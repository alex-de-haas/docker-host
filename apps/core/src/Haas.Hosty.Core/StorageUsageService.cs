namespace Haas.Hosty.Core;

// The last completed snapshot remains available during a refresh. No GET performs filesystem I/O.
// Request replay is bounded to the most recent 1024 accepted UUIDs in this Core process; all requests
// admitted during a scan join that same scan, including requests whose HTTP connection has closed.
internal sealed class StorageUsageService(StorageUsageScanner scanner, IHostApplicationLifetime lifetime,
    ILogger<StorageUsageService> logger) : IHostedService
{
    private readonly object gate = new();
    private readonly HashSet<Guid> requests = [];
    private readonly Queue<Guid> order = [];
    private StorageUsageState state = new(null, false, null);
    private Task active = Task.CompletedTask;

    public StorageUsageState GetState() { lock (gate) return state; }

    public StorageUsageState Refresh(Guid requestId)
    {
        lock (gate)
        {
            if (!requests.Add(requestId)) return state;
            order.Enqueue(requestId);
            while (order.Count > 1024) requests.Remove(order.Dequeue());
            if (state.IsScanning) return state;
            state = state with { IsScanning = true, LastError = null };
            active = Task.Run(ScanAsync);
            return state;
        }
    }

    internal Task WaitForScanAsync() { lock (gate) return active; }
    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StopAsync(CancellationToken cancellationToken) => WaitForScanAsync().WaitAsync(cancellationToken);

    private async Task ScanAsync()
    {
        try
        {
            var snapshot = await scanner.ScanAsync(lifetime.ApplicationStopping);
            lock (gate) state = new(snapshot, false, null);
        }
        catch (OperationCanceledException) when (lifetime.ApplicationStopping.IsCancellationRequested)
        { lock (gate) state = state with { IsScanning = false, LastError = "storage_scan_cancelled" }; }
        catch (Exception ex)
        {
            // Neither on-disk paths nor arbitrary filesystem exception text are sent to the client.
            logger.LogWarning(ex, "Storage measurement failed");
            lock (gate) state = state with { IsScanning = false, LastError = "storage_scan_failed" };
        }
    }
}
