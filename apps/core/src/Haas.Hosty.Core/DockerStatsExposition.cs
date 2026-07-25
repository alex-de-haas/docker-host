using System.Globalization;
using System.Text;

namespace Haas.Hosty.Core;

// Observability Phase 2 (Core producer): collects container infra metrics with `docker stats` — which
// need the host-level Docker access the telemetry backend deliberately lacks — and re-exposes them as a
// Prometheus text snapshot the backend scrapes as a second target (alongside the collector). Each
// series is attributed to its app via the `hosty_app_id` label the backend already keys on, so the
// backend stores docker stats uniformly with app OTLP metrics. This replaces the docker-stats half of
// the old TelemetryScrapeService; Core no longer keeps a metric store of its own. Gated on the
// telemetry app being installed — the flag that used to control this folded into the bootstrap
// catalog (removable-system-apps), so installing it starts stats flowing without a Core restart —
// and best-effort: a docker-less host simply exposes nothing.
// See docs/features/observability/feature.md.
internal sealed class DockerStatsExposition(
    AppRegistryStore apps,
    IDockerCommandRunner dockerRunner,
    ILogger<DockerStatsExposition> logger) : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(10);

    // Prometheus label the backend promotes app attribution from; matches the collector's promoted
    // `hosty_app_id`, so docker stats attribute the same way as app OTLP metrics.
    internal const string AppAttributionLabel = "hosty_app_id";

    // Metric names kept identical to what Core's old in-memory store used, so Shell's pinned CPU/mem
    // (`container.*`) charts need no change. The backend's lenient Prometheus parser accepts dotted
    // names (this endpoint is only ever scraped by our backend).
    internal const string ContainerCpuPercentMetric = "container.cpu.percent";
    internal const string ContainerMemoryBytesMetric = "container.memory.bytes";
    internal const string ContainerMemoryPercentMetric = "container.memory.percent";

    // Latest rendered snapshot, swapped atomically each tick and served by the exposition endpoint.
    private volatile string current = string.Empty;

    public string CurrentPrometheusText => current;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await Task.Yield();
        using var timer = new PeriodicTimer(Interval);
        do
        {
            try
            {
                // Observability follows the telemetry app: unless it is installed AND running,
                // nothing scrapes this producer (the scraping backend is one of its services), so
                // the tick idles with an empty snapshot instead of running docker commands nobody
                // consumes. Checked per tick so a live enable through the bootstrap endpoints or a
                // plain app start takes effect without a Core restart.
                var collector = await apps.GetAppAsync(CollectorBootstrap.AppId, stoppingToken);
                current = string.Equals(collector?.RuntimeState, "running", StringComparison.Ordinal)
                    ? await BuildSnapshotAsync(stoppingToken)
                    : string.Empty;
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Docker stats exposition tick failed.");
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    private async Task<string> BuildSnapshotAsync(CancellationToken cancellationToken)
    {
        var owners = ParseContainerOwners(await RunDockerOrEmptyAsync(
            ["ps", "--no-trunc", "--filter", "label=hosty.app.id", "--format",
                "{{.Names}}\t{{.Label \"hosty.app.id\"}}\t{{.Label \"hosty.app.service\"}}"],
            cancellationToken));
        if (owners.Count == 0)
        {
            return string.Empty;
        }

        var stats = DockerStatsParser.Parse(await RunDockerOrEmptyAsync(
            ["stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}"],
            cancellationToken));

        var builder = new StringBuilder();
        foreach (var stat in stats)
        {
            if (!owners.TryGetValue(stat.ContainerName, out var owner))
            {
                continue;
            }

            if (stat.CpuPercent is { } cpu)
            {
                AppendSample(builder, ContainerCpuPercentMetric, owner.AppId, owner.Service, cpu);
            }

            if (stat.MemoryBytes is { } memoryBytes)
            {
                AppendSample(builder, ContainerMemoryBytesMetric, owner.AppId, owner.Service, memoryBytes);
            }

            if (stat.MemoryPercent is { } memoryPercent)
            {
                AppendSample(builder, ContainerMemoryPercentMetric, owner.AppId, owner.Service, memoryPercent);
            }
        }

        return builder.ToString();
    }

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
    // the service when the service label is absent.
    internal static IReadOnlyDictionary<string, ContainerStatOwner> ParseContainerOwners(string? output)
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
