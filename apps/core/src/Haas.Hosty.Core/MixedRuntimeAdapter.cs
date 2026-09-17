namespace Haas.Hosty.Core;

// Executes one dependency graph across existing adapters. A service projection keeps the full
// graph for peer discovery, while lifecycle operations only touch the selected service.
internal sealed class MixedRuntimeAdapter(IEnumerable<IAppRuntimeAdapter> adapters) : IAppRuntimeAdapter
{
    public string Type => "mixed";

    private IAppRuntimeAdapter Adapter(RuntimeSelectedService service)
        => adapters.FirstOrDefault(adapter => adapter.Type == service.Runtime.Type)
            ?? throw new AppLifecycleException("runtime_adapter_missing", $"Runtime adapter '{service.Runtime.Type}' is not available.");

    internal static RuntimeLifecycleContext ForService(RuntimeLifecycleContext context, RuntimeSelectedService service)
    {
        RuntimeAppDataTarget? Target(RuntimeAppDataManifest? storage, RuntimeAppDataTarget? fallback)
            => storage?.Targets.FirstOrDefault(target => target.Runtime == context.Manifest.RuntimeProfile.Key && target.Service == service.Key)
                ?? storage?.Targets.FirstOrDefault(target => target.Runtime == context.Manifest.RuntimeProfile.Key && string.IsNullOrEmpty(target.Service))
                ?? fallback;
        return context with
        {
            GraphServices = context.AllServices,
            Manifest = context.Manifest with
            {
                Services = [service],
                DataTarget = Target(context.Manifest.Manifest.Data, context.Manifest.DataTarget),
                CacheTarget = Target(context.Manifest.Manifest.Cache, context.Manifest.CacheTarget),
            },
        };
    }

    public async Task<AppRuntimeStartResult> StartAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
    {
        // Validate the whole graph before creating any processes or containers.
        var services = DockerRuntimeAdapter.OrderServices(context.Manifest.Services);
        foreach (var service in services)
        {
            _ = Adapter(service);
            // Discover every cross-runtime edge before the first process is created.
            _ = RuntimeServiceDiscovery.BuildEnvironment(context.AllServices, service,
                (target, port) => RuntimeServiceDiscovery.BuildPeerUrl(context, service, target, port)).ToArray();
        }
        var started = new List<RuntimeSelectedService>();
        var endpoints = new List<AppEndpointContract>();
        var locks = new Dictionary<string, ArtifactLock>(StringComparer.Ordinal);
        try
        {
            foreach (var service in services)
            {
                var scoped = ForService(context, service);
                var adapter = Adapter(service);
                var previous = await adapter.GetHealthAsync(scoped, cancellationToken);
                var result = await adapter.StartAsync(scoped, cancellationToken);
                if (result.CreatedServices?.Contains(service.Key) ?? !previous.Services.Any(health => health.Status == "running")) started.Add(service);
                endpoints.AddRange(result.Endpoints);
                foreach (var pair in result.ArtifactLocks ?? new Dictionary<string, ArtifactLock>()) locks[pair.Key] = pair.Value;
            }
        }
        catch (Exception startError)
        {
            var failures = new List<Exception> { startError };
            foreach (var service in started.AsEnumerable().Reverse())
            {
                try { await Adapter(service).RemoveAsync(ForService(context, service), CancellationToken.None); }
                catch (Exception cleanupError) { failures.Add(cleanupError); }
            }
            if (failures.Count > 1)
                throw new AppLifecycleException("mixed_start_cleanup_incomplete", string.Join("; ", failures.Select(error => error.Message)));
            throw;
        }
        return new("running", endpoints, locks);
    }

    public Task<AppRuntimeOperationResult> StopAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
        => StopOrRemoveAsync(context, false, cancellationToken);

    public Task<AppRuntimeOperationResult> RemoveAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
        => StopOrRemoveAsync(context, true, cancellationToken);

    private async Task<AppRuntimeOperationResult> StopOrRemoveAsync(RuntimeLifecycleContext context, bool remove, CancellationToken cancellationToken)
    {
        var failures = new List<Exception>();
        foreach (var service in DockerRuntimeAdapter.OrderServices(context.Manifest.Services).Reverse())
        {
            try
            {
                var adapter = Adapter(service);
                var scoped = ForService(context, service);
                if (remove) await adapter.RemoveAsync(scoped, cancellationToken);
                else await adapter.StopAsync(scoped, cancellationToken);
            }
            catch (Exception error) when (error is not OperationCanceledException) { failures.Add(error); }
        }
        if (failures.Count > 0)
            throw new AppLifecycleException("mixed_stop_incomplete", string.Join("; ", failures.Select(error => error.Message)));
        return new(remove ? "removed" : "stopped");
    }

    public async Task<AppRuntimeLogsResult> GetLogsAsync(RuntimeLifecycleContext context, int tail, CancellationToken cancellationToken = default)
    {
        var logs = new List<AppRuntimeServiceLogs>();
        foreach (var service in context.Manifest.Services)
        {
            var result = await Adapter(service).GetLogsAsync(ForService(context, service), tail, cancellationToken);
            logs.AddRange(result.Services ?? [new(service.Key, result.Text)]);
        }
        return new(string.Join("\n", logs.Select(log => $"[{log.Service}]\n{log.Text}")), logs);
    }

    public async Task<AppRuntimeHealthResult> GetHealthAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
    {
        var health = new List<AppRuntimeServiceHealth>();
        foreach (var service in context.Manifest.Services)
            health.AddRange((await Adapter(service).GetHealthAsync(ForService(context, service), cancellationToken)).Services);
        return new(DockerRuntimeAdapter.SummarizeHealthStatus(health), health);
    }
}
