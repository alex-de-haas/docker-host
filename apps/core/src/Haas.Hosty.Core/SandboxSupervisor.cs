using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core;

// Reconciliation never treats an unreadable daemon, journal, or filesystem as evidence of
// deletion. Instance data and source consumers remain retained until verified disposal.
internal sealed class SandboxSupervisor(SandboxStore store, ISandboxRuntime runtime,
    SandboxServiceCredentials credentials, SandboxBrowser browser, IClock clock, ILogger<SandboxSupervisor> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                foreach (var instance in await store.ListAsync(stoppingToken))
                    await ObserveAsync(instance.Id, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex) when (ex is IOException or SandboxException or DockerUnavailableException or UnauthorizedAccessException or System.Text.Json.JsonException or InvalidOperationException or OverflowException)
            { logger.LogWarning("Sandbox observation unavailable ({Type}); retained resources require reconciliation.", ex.GetType().Name); }
            await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
        }
    }

    internal async Task ObserveAsync(string id, CancellationToken ct)
    {
        var gate = store.Gate(id);
        var snapshot = await store.ReadAsync(id, ct);
        if (snapshot is null) return;
        // Docker stats and recursive cache measurement can take seconds. They must not hold
        // the realm's mutation gate: every app request revalidates its short-lived identity.
        var storage = ObserveStorage(store, snapshot, clock.UtcNow);
        string? reason = store.EmergencyRevoked(id) ? "storage_budget_exceeded" : storage.ErrorCode;
        string? observed = null;
        SandboxMetrics? metrics = null;
        try
        {
            if (snapshot.State == "ready")
            {
                if (await runtime.VmFreeBytesAsync(snapshot, ct) is { } vmFree && vmFree < 10737418240)
                    reason = "storage_budget_exceeded";
                try { await credentials.RequireAsync(id, credentials.Create(snapshot), ct); }
                catch (SandboxException ex) { reason ??= ex.Code; }
            }
            if (reason is null && snapshot.State is "ready" or "unhealthy" or "unknown")
            {
                observed = await runtime.ObserveAsync(snapshot, ct);
                if (observed == "ready") metrics = await runtime.MetricsAsync(snapshot, ct);
            }
        }
        catch (Exception ex) when (ex is SandboxException or IOException or DockerUnavailableException or UnauthorizedAccessException or System.Text.Json.JsonException or InvalidOperationException or OverflowException)
        { reason = ex is SandboxException sandbox ? sandbox.Code : "sandbox_observation_unknown"; }
        if (!await gate.WaitAsync(0, ct))
        {
            // Long setup remains monitored without publishing an obsolete instance snapshot.
            if (storage.ErrorCode is not null)
            {
                await store.RevokeEmergencyAsync(id, ct);
                var busy = await store.ReadAsync(id, ct);
                if (busy is not null) await runtime.StopAsync(busy, ct);
            }
            return;
        }
        try
        {
            var instance = await store.ReadAsync(id, ct);
            if (instance is null || instance.Revision != snapshot.Revision || instance.Generation != snapshot.Generation
                || instance.DataRevision != snapshot.DataRevision || instance.State != snapshot.State
                || instance.AccessRevoked != snapshot.AccessRevoked) return;
            instance = await browser.RecoverLockedAsync(instance, ct);
            var interrupted = instance.Operations.Any(o => o.State == "running");
            if (interrupted) reason ??= "sandbox_operation_interrupted";
            if (reason is not null || instance.State is "starting" or "stopping" or "resetting")
            {
                instance = instance with { AccessRevoked = true, ErrorCode = reason ?? instance.ErrorCode ?? "sandbox_operation_interrupted", Storage = storage,
                    Operations = instance.Operations.Select(o => o.State == "running" ? o with {
                        State = "unknown", ErrorCode = "sandbox_operation_interrupted", Message = "Core restarted before the operation outcome was persisted; resources and data are retained." } : o).ToArray() };
                await store.WriteAsync(instance, ct);
                await runtime.StopAsync(instance, ct);
                instance = instance with { State = instance.State == "disposing" ? "disposing" : "stopped" };
            }
            else if (observed is not null)
                instance = instance with { State = observed, AccessRevoked = observed != "ready" || instance.AccessRevoked,
                    ErrorCode = observed == "ready" ? instance.ErrorCode : "sandbox_runtime_" + observed,
                    Metrics = metrics ?? instance.Metrics };
            await store.WriteAsync(instance with { Storage = storage }, ct);
        }
        catch (Exception ex) when (ex is SandboxException or IOException or DockerUnavailableException or UnauthorizedAccessException or System.Text.Json.JsonException or InvalidOperationException or OverflowException)
        {
            var instance = await store.ReadAsync(id, ct);
            if (instance is not null)
                await store.WriteAsync(instance with { State = "unknown", AccessRevoked = true,
                    ErrorCode = ex is SandboxException sandbox ? sandbox.Code : "sandbox_observation_unknown" }, ct);
        }
        finally { gate.Release(); }
    }

    internal static SandboxStorageObservation ObserveStorage(SandboxStore store, SandboxInstance instance, DateTimeOffset at)
    {
        var limits = instance.Request.Limits ?? new();
        var data = Size(store.DataPath(instance.Id, "data"));
        var seeds = Size(store.DataPath(instance.Id, "seeds"));
        var cache = Size(store.DataPath(instance.Id, "cache"));
        var evidence = Size(store.DataPath(instance.Id, "evidence"));
        var total = checked(data + seeds + cache + evidence + Size(store.DataPath(instance.Id, "logs")));
        var exceeded = data >= limits.DataBytes || seeds >= 33554432 || cache >= limits.CacheBytes || evidence >= 262144000;
        var warning = data >= limits.DataBytes * .8 || seeds >= 33554432 * .8 || cache >= limits.CacheBytes * .8 || evidence >= 262144000 * .8;
        var free = new DriveInfo(Path.GetPathRoot(store.TemporaryRoot)!).AvailableFreeSpace;
        // Reserve 10 GiB of the 30 GiB coordinated mutable budget for the separately managed
        // agent state/worktree outputs. Their enforcement belongs to the worker coordinator.
        var sandboxTotal = Size(store.TemporaryRoot);
        return new(at, data, seeds, cache, evidence, total, warning || sandboxTotal >= 17179869184,
            exceeded || free < 10737418240 || sandboxTotal >= 21474836480 ? "storage_budget_exceeded" : null);
    }

    internal static long Size(string root)
    {
        if (!Directory.Exists(root)) return 0;
        long bytes = 0;
        var directories = new Stack<string>(); directories.Push(root);
        while (directories.TryPop(out var directory))
            foreach (var item in new DirectoryInfo(directory).EnumerateFileSystemInfos())
            {
                // Count link metadata, never follow links into source, host, or another sandbox.
                if ((item.Attributes & FileAttributes.ReparsePoint) != 0) { bytes = checked(bytes + 4096); continue; }
                if (item is DirectoryInfo) directories.Push(item.FullName);
                else if (item is FileInfo file) bytes = checked(bytes + file.Length);
            }
        return bytes;
    }
}
