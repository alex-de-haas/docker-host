using System.Globalization;
using System.Text.Json;

namespace Haas.Hosty.Core;

// Reservations survive stops and failures. Only Finish releases them. Docker limits cover app
// containers; native Core/build processes are measured separately, not advertised as hard-capped.
internal sealed record CoreEnvironmentLimits(long MemoryBytes = 4294967296, double Cpus = 2, int Pids = 512,
    long DiskBytes = 10737418240, long ApplicationMemoryBytes = 2147483648, double ApplicationCpus = 1,
    int ApplicationPids = 256);
internal sealed record CoreEnvironmentUsage(long OwnedDiskBytes, long ContainerMemoryBytes, long CoreMemoryBytes,
    string State, DateTimeOffset ObservedAt, string? Error = null);

internal static class CoreEnvironmentResources
{
    internal static readonly CoreEnvironmentLimits Pool = new(8589934592, 4, 1024, 21474836480);
    internal static CoreEnvironmentLimits Limits(CoreEnvironmentRecord record) => record.Request.Limits ?? new();
    internal static void Validate(CoreEnvironmentLimits value)
    {
        if (value.MemoryBytes is < 268435456 or > 8589934592 || !double.IsFinite(value.Cpus) || value.Cpus is < 0.25 or > 4
            || value.Pids is < 64 or > 1024 || value.DiskBytes is < 1048576 or > 21474836480
            || value.ApplicationMemoryBytes < 67108864 || value.ApplicationMemoryBytes > value.MemoryBytes
            || !double.IsFinite(value.ApplicationCpus) || value.ApplicationCpus < 0.1 || value.ApplicationCpus > value.Cpus
            || value.ApplicationPids < 16 || value.ApplicationPids > value.Pids)
            throw new SandboxException("environment_limits_invalid", "Select bounded environment and application limits within the root pool.", 400);
    }
    internal static void Reserve(IEnumerable<CoreEnvironmentRecord> records, CoreEnvironmentLimits requested)
    {
        Validate(requested);
        var existing = records.Select(Limits).ToArray();
        if (existing.Sum(l => l.MemoryBytes) + requested.MemoryBytes > Pool.MemoryBytes
            || existing.Sum(l => l.Cpus) + requested.Cpus > Pool.Cpus
            || existing.Sum(l => (long)l.Pids) + requested.Pids > Pool.Pids
            || existing.Sum(l => l.DiskBytes) + requested.DiskBytes > Pool.DiskBytes)
            throw new SandboxException("environment_resource_capacity", "The root environment memory, CPU, PID or disk reservation pool is exhausted. Finish an environment to release its reservation.", 409);
    }
    internal static async Task<CoreEnvironmentRecord?> ManagedAsync(HostyCoreRuntimeConfig config, CancellationToken ct)
    {
        var root = new DirectoryInfo(Path.GetFullPath(config.DataRoot));
        if (root.Parent?.Name != "environments" || !Guid.TryParseExact(root.Name, "N", out _)) return null;
        var parent = new CoreEnvironmentStore(CoreDataPaths.FromConfig(config with { DataRoot = root.Parent.Parent!.FullName }));
        var record = await parent.ReadAsync(root.Name, ct)
            ?? throw new SandboxException("environment_owner_unknown", "The managed environment reservation is unavailable.", 409);
        parent.VerifyRoot(record);
        await parent.BudgetStoreAsync(ct);
        if (record.State is "finished" or "finishing" or "cleanup-failed" || record.RootDeletionStarted)
            throw new SandboxException("environment_finishing", "The environment is closing; no new resources may be allocated.", 409);
        return record;
    }
    internal static async Task<string> Docker(IDockerCommandRunner runner, string[] args, CancellationToken ct)
    {
        var result = await runner.RunAsync(args, cancellationToken: ct);
        if (result.ExitCode != 0) throw new SandboxException("environment_docker_unknown", "Docker resource inventory is unavailable; reservations are retained.", 409);
        return result.StandardOutput.Trim();
    }
    internal static async Task<JsonDocument> Containers(IDockerCommandRunner runner, string id, CancellationToken ct)
    {
        var ids = (await Docker(runner, ["ps", "-aq", "--no-trunc", "--filter", "label=hosty.instance=" + id], ct))
            .Split('\n', StringSplitOptions.RemoveEmptyEntries);
        return JsonDocument.Parse(ids.Length == 0 ? "[]" : await Docker(runner, ["inspect", .. ids], ct));
    }
    internal static async Task<CoreEnvironmentAdmission?> AdmitAsync(HostyCoreRuntimeConfig config,
        IDockerCommandRunner runner, string appId, int services, CancellationToken ct, CoreEnvironmentLimits? allocation = null,
        IReadOnlySet<string>? replacementServices = null, int? totalServices = null)
    {
        var record = await ManagedAsync(config, ct);
        if (record is null) return null;
        var store = new CoreEnvironmentStore(CoreDataPaths.FromConfig(config));
        // Keep inventory and creation atomic across slow pulls/builds, but let concurrent starts
        // wait through the bounded lifecycle operation rather than fail after ten seconds.
        var gate = await store.LockAllocationAsync(ct, TimeSpan.FromMinutes(8));
        try
        {
            record = (await ManagedAsync(config, ct))!;
            var limits = Limits(record);
            if (allocation is not null) limits = limits with { ApplicationMemoryBytes = allocation.ApplicationMemoryBytes,
                ApplicationCpus = allocation.ApplicationCpus, ApplicationPids = allocation.ApplicationPids };
            var divisor = totalServices ?? services;
            if (services < 1 || divisor < services || limits.ApplicationMemoryBytes / divisor < 67108864 || limits.ApplicationPids / divisor < 16)
                throw new SandboxException("environment_application_limits", "The application has too many services for its configured resource share.", 409);
            using var containers = await Containers(runner, record.Id, ct);
            long memory = 0, pids = 0; double cpus = 0;
            foreach (var container in containers.RootElement.EnumerateArray())
            {
                var labels = container.GetProperty("Config").GetProperty("Labels");
                if (labels.TryGetProperty("hosty.app.id", out var app) && app.GetString() == appId
                    && (replacementServices is null || labels.TryGetProperty("hosty.app.service", out var service)
                        && replacementServices.Contains(service.GetString() ?? ""))) continue;
                var host = container.GetProperty("HostConfig");
                var m = host.GetProperty("Memory").GetInt64();
                var c = host.GetProperty("NanoCpus").GetInt64() / 1e9;
                var pid = host.GetProperty("PidsLimit"); var n = pid.ValueKind == JsonValueKind.Number ? pid.GetInt64() : 0;
                if (m <= 0 || c <= 0 || n <= 0) throw new SandboxException("environment_resources_unbounded", "An existing container has no verified limits. Stop and recreate it before allocating more resources.", 409);
                memory += m; cpus += c; pids += n;
            }
            if (memory + limits.ApplicationMemoryBytes / divisor * services > limits.MemoryBytes || cpus + limits.ApplicationCpus / divisor * services > limits.Cpus + 0.000001
                || pids + limits.ApplicationPids / divisor * services > limits.Pids)
                throw new SandboxException("environment_application_capacity", "The environment container resource budget is exhausted. Remove another app or select larger limits in a new environment.", 409);
            if (OwnedSize(config.DataRoot) > limits.DiskBytes)
                throw new SandboxException("environment_disk_capacity", "The environment owned-data soft disk limit is exceeded.", 409);
            return new(gate, limits, divisor);
        }
        catch { gate.Dispose(); throw; }
    }
    internal static long OwnedSize(string root)
    {
        long bytes = 0;
        if (!Directory.Exists(root)) return 0;
        var pending = new Stack<string>(); pending.Push(root);
        while (pending.TryPop(out var directory))
            foreach (var item in new DirectoryInfo(directory).EnumerateFileSystemInfos())
            {
                if ((item.Attributes & FileAttributes.ReparsePoint) != 0) continue;
                // Descendants have independent reservations and observations.
                if (directory == root && item.Name == "environments") continue;
                if (item is DirectoryInfo) pending.Push(item.FullName);
                else if (item is FileInfo file) bytes = checked(bytes + file.Length);
            }
        return bytes;
    }
    internal static long DockerSize(string value)
    {
        var suffix = new[] { ("GiB", 1073741824d), ("MiB", 1048576d), ("KiB", 1024d), ("GB", 1e9), ("MB", 1e6), ("kB", 1e3), ("B", 1d) };
        foreach (var (unit, scale) in suffix)
            if (value.EndsWith(unit, StringComparison.Ordinal)
                && double.TryParse(value[..^unit.Length].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var number) && double.IsFinite(number) && number >= 0)
                return checked((long)Math.Ceiling(number * scale));
        throw new IOException("Docker reported an unknown disk-size format.");
    }
    internal static async Task<CoreEnvironmentUsage> InspectAsync(CoreEnvironmentRecord record, string root, IDockerCommandRunner runner, CancellationToken ct)
    {
        long disk = OwnedSize(root), memory = 0, rss = 0;
        using var inventory = JsonDocument.Parse(await Docker(runner, ["system", "df", "-v", "--format", "json"], ct));
        foreach (var type in new[] { "Containers", "Volumes" })
            if (inventory.RootElement.TryGetProperty(type, out var resources) && resources.ValueKind == JsonValueKind.Array)
                foreach (var item in resources.EnumerateArray())
                    if ((item.GetProperty("Labels").GetString() ?? "").Split(',').Contains("hosty.instance=" + record.Id, StringComparer.Ordinal))
                        disk += DockerSize(item.GetProperty("Size").GetString()!);
        var ids = (await Docker(runner, ["ps", "-q", "--filter", "label=hosty.instance=" + record.Id], ct)).Split('\n', StringSplitOptions.RemoveEmptyEntries);
        if (ids.Length > 0)
        {
            var stats = await Docker(runner, ["stats", "--no-stream", "--format", "{{.MemUsage}}", .. ids], ct);
            foreach (var line in stats.Split('\n', StringSplitOptions.RemoveEmptyEntries)) memory += DockerSize(line.Split('/')[0].Trim());
        }
        if (CoreEnvironmentRuntime.Alive(record.Process))
        {
            using var process = System.Diagnostics.Process.GetProcessById(record.Process!.Pid); rss = process.WorkingSet64;
        }
        return new(disk, memory, rss, "observed", DateTimeOffset.UtcNow);
    }
}

internal sealed class CoreEnvironmentAdmission(FileStream gate, CoreEnvironmentLimits limits, int services) : IDisposable
{
    internal async Task<bool> MatchesAsync(IDockerCommandRunner runner, string container, CancellationToken ct)
    {
        var result = await runner.RunAsync(["inspect", container], cancellationToken: ct);
        if (result.ExitCode != 0) return false;
        using var json = JsonDocument.Parse(result.StandardOutput);
        var host = json.RootElement[0].GetProperty("HostConfig");
        return host.GetProperty("Memory").GetInt64() == limits.ApplicationMemoryBytes / services
            && host.GetProperty("MemorySwap").GetInt64() == limits.ApplicationMemoryBytes / services
            && Math.Abs(host.GetProperty("NanoCpus").GetInt64() / 1e9 - limits.ApplicationCpus / services) < 0.000001
            && host.GetProperty("PidsLimit").GetInt64() == limits.ApplicationPids / services;
    }
    internal string[] Arguments => ["--memory", (limits.ApplicationMemoryBytes / services).ToString(CultureInfo.InvariantCulture),
        "--memory-swap", (limits.ApplicationMemoryBytes / services).ToString(CultureInfo.InvariantCulture),
        "--cpus", (limits.ApplicationCpus / services).ToString("0.#########", CultureInfo.InvariantCulture),
        "--pids-limit", (limits.ApplicationPids / services).ToString(CultureInfo.InvariantCulture),
        "--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=3"];
    public void Dispose() => gate.Dispose();
}
