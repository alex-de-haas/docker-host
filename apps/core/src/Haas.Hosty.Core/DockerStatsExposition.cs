using System.Globalization;
using System.Text;

namespace Haas.Hosty.Core;

// Container acquisition and legacy Prometheus formatting. RuntimeResourceSampler is the only
// producer; Dashboard and Telemetry share its cached samples without duplicate docker processes.
internal sealed class DockerStatsExposition(
    IDockerCommandRunner dockerRunner,
    IClock clock,
    // Runtime config, for the instance id that keeps a secondary-root Core from attributing (and
    // double-reporting) the default root's containers. Optional only for unit fixtures, which then
    // scrape as the default instance; production DI always supplies it.
    HostyCoreRuntimeConfig? runtimeConfig = null)
{
    // The root's instance identity; empty = the default instance, which also matches containers
    // that predate the hosty.instance label.
    private readonly string instanceId = runtimeConfig?.InstanceId ?? "";


    // Longest a cached owner map may be trusted. Container names are derived, and derivation is not
    // injective — BuildContainerName normalizes punctuation, so app `foo.bar` and app `foo-bar` with
    // the same service key produce the SAME container name (a collision the removal path already
    // guards against explicitly). Uninstall one and start the other and the cached entry would
    // attribute the new app's metrics to the old one, with no unknown name to trigger a refresh. The
    // age cap bounds that to a minute instead of forever, and still spares five of every six reads.
    private static readonly TimeSpan MaxOwnerMapAge = TimeSpan.FromSeconds(60);

    // Prometheus label the backend promotes app attribution from; matches the collector's promoted
    // `hosty_app_id`, so docker stats attribute the same way as app OTLP metrics.
    internal const string AppAttributionLabel = "hosty_app_id";

    // Metric names kept identical to what Core's old in-memory store used, so Shell's pinned CPU/mem
    // (`container.*`) charts need no change. The backend's lenient Prometheus parser accepts dotted
    // names (this endpoint is only ever scraped by our backend).
    internal const string ContainerCpuPercentMetric = "container.cpu.percent";
    internal const string ContainerMemoryBytesMetric = "container.memory.bytes";
    internal const string ContainerMemoryPercentMetric = "container.memory.percent";

    // Container → owning app, cached across ticks. `docker ps` answers a question that changes when an
    // app starts, stops or is installed — not every ten seconds — so re-reading it with a process spawn
    // per tick was pure repetition. Refreshed when the map is empty (nothing running yet, which is
    // exactly the state a starting app changes), when a sample names a *Hosty* container we have no
    // owner for (something started since), and once the map reaches MaxOwnerMapAge. Touched only from
    // the single-threaded tick loop.
    private IReadOnlyDictionary<string, ContainerStatOwner> owners = EmptyOwners;

    private DateTimeOffset ownersLoadedAt;

    private static readonly IReadOnlyDictionary<string, ContainerStatOwner> EmptyOwners =
        new Dictionary<string, ContainerStatOwner>(StringComparer.Ordinal);


    public IReadOnlyList<RuntimeResourceSample> Samples { get; private set; } = [];

    // Internal (not private) so the owner-map caching can be exercised without driving the timer.
    internal async Task<string> BuildSnapshotAsync(CancellationToken cancellationToken)
    {
        Samples = [];
        if (owners.Count == 0)
        {
            owners = await LoadContainerOwnersAsync(cancellationToken);
            if (owners.Count == 0)
            {
                return string.Empty;
            }
        }

        // Deliberately NOT scoped to the container names already known: naming them explicitly would
        // fail the call over a container that stopped since the last refresh, and — the real problem —
        // would hide the containers that started since, which are the only signal that the owner map
        // needs refreshing.
        var stats = DockerStatsParser.Parse(await RunDockerOrEmptyAsync(
            ["stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}"],
            cancellationToken));

        if (stats.Count == 0)
        {
            // Nothing to sample at all: every container has stopped, or docker is unavailable. Drop
            // the map so the next tick goes back through the cheap `docker ps` and can take the
            // skip-sampling path above. Without this a stale non-empty map would keep the expensive
            // sampling call running every tick over a host with nothing to report — turning the
            // cheapest case into the most expensive one.
            owners = EmptyOwners;
            return string.Empty;
        }

        // Only an unattributed *Hosty* container means the map is behind. A shared host runs the
        // operator's own containers too, and `docker stats` reports all of them: treating any unknown
        // name as a refresh signal would re-run `docker ps` on every tick of every host that runs
        // anything outside Hosty — which is most of them — and cache nothing.
        if (clock.UtcNow - ownersLoadedAt >= MaxOwnerMapAge ||
            stats.Any(stat => IsHostyContainer(stat.ContainerName) && !owners.ContainsKey(stat.ContainerName)))
        {
            owners = await LoadContainerOwnersAsync(cancellationToken);
        }

        var builder = new StringBuilder();
        var samples = new List<RuntimeResourceSample>();
        foreach (var stat in stats)
        {
            if (!owners.TryGetValue(stat.ContainerName, out var owner))
            {
                continue;
            }

            samples.Add(new RuntimeResourceSample(owner.AppId, owner.Service, "docker", clock.UtcNow,
                Sanitize(stat.CpuPercent), Sanitize(stat.MemoryBytes), Sanitize(stat.MemoryPercent)));
            if (Sanitize(stat.CpuPercent) is { } cpu)
            {
                AppendSample(builder, ContainerCpuPercentMetric, owner.AppId, owner.Service, cpu);
            }

            if (Sanitize(stat.MemoryBytes) is { } memoryBytes)
            {
                AppendSample(builder, ContainerMemoryBytesMetric, owner.AppId, owner.Service, memoryBytes);
            }

            if (Sanitize(stat.MemoryPercent) is { } memoryPercent)
            {
                AppendSample(builder, ContainerMemoryPercentMetric, owner.AppId, owner.Service, memoryPercent);
            }
        }

        Samples = samples;
        return builder.ToString();
    }

    private static double? Sanitize(double? value) => value is >= 0 && double.IsFinite(value.Value) ? value : null;

    private async Task<IReadOnlyDictionary<string, ContainerStatOwner>> LoadContainerOwnersAsync(CancellationToken cancellationToken)
    {
        // The instance is a post-filter on the printed label (docker ps cannot filter on "label
        // absent", which is what the default instance's containers look like): a secondary-root Core
        // must not attribute the default root's containers to its own apps.
        var loaded = ParseContainerOwners(
            await RunDockerOrEmptyAsync(
                ["ps", "--no-trunc", "--filter", "label=hosty.app.id", "--format",
                    "{{.Names}}\t{{.Label \"hosty.app.id\"}}\t{{.Label \"hosty.app.service\"}}\t{{.Label \"hosty.instance\"}}"],
                cancellationToken),
            instanceId);
        ownersLoadedAt = clock.UtcNow;
        return loaded;
    }

    // Every container Core runs is named by BuildContainerName, which prefixes this; anything else in
    // a `docker stats` sample belongs to the operator, not to Hosty.
    private static bool IsHostyContainer(string containerName)
        => containerName.StartsWith("hosty-", StringComparison.Ordinal);

    // Renders one Prometheus sample: name{hosty_app_id="…",service="…"} value
    internal static void AppendSample(StringBuilder builder, string name, string appId, string service, double value)
    {
        builder.Append(name)
            .Append("{").Append(AppAttributionLabel).Append("=\"").Append(EscapeLabel(appId))
            .Append("\",service=\"").Append(EscapeLabel(service)).Append("\"} ")
            .Append(value.ToString("R", CultureInfo.InvariantCulture))
            .Append('\n');
    }

    private static string EscapeLabel(string value)
        => value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n");

    // container name → owner, read back from the `hosty.app.*` docker labels. Falls back to app id for
    // the service when the service label is absent. Rows of a different instance are dropped — an
    // absent hosty.instance label (the 4th field, and every pre-label container) reads as the default
    // instance's empty id.
    internal static IReadOnlyDictionary<string, ContainerStatOwner> ParseContainerOwners(string? output, string instanceId = "")
    {
        var owners = new Dictionary<string, ContainerStatOwner>(StringComparer.Ordinal);
        if (string.IsNullOrWhiteSpace(output))
        {
            return owners;
        }

        foreach (var rawLine in output.Split('\n'))
        {
            var fields = rawLine.Trim().Split('\t');
            if (fields.Length < 2 || string.IsNullOrWhiteSpace(fields[0]) || string.IsNullOrWhiteSpace(fields[1]))
            {
                continue;
            }

            var rowInstance = fields.Length > 3 ? fields[3].Trim() : string.Empty;
            if (!string.Equals(rowInstance, instanceId, StringComparison.Ordinal))
            {
                continue;
            }

            var service = fields.Length > 2 && !string.IsNullOrWhiteSpace(fields[2]) ? fields[2].Trim() : fields[1].Trim();
            owners[fields[0].Trim()] = new ContainerStatOwner(fields[1].Trim(), service);
        }

        return owners;
    }

    private async Task<string> RunDockerOrEmptyAsync(IReadOnlyList<string> args, CancellationToken cancellationToken)
    {
        try
        {
            var result = await dockerRunner.RunAsync(args, cancellationToken: cancellationToken);
            return result.ExitCode == 0 ? result.StandardOutput : string.Empty;
        }
        catch (DockerUnavailableException)
        {
            return string.Empty;
        }
    }
}

// Which app/service a hosty container belongs to, read back from its `hosty.app.*` docker labels.
internal readonly record struct ContainerStatOwner(string AppId, string Service);
