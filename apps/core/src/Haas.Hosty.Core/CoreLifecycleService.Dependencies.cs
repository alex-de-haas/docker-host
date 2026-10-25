namespace Haas.Hosty.Core;

internal sealed partial class CoreLifecycleService
{
    private readonly TaskCompletionSource dependencyStartupReady = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly SemaphoreSlim dependencyResumeGate = new(1, 1);
    internal Task DependencyStartupReady => dependencyStartupReady.Task;

    private static bool DependencyReady(AppDependencyContract dependency, IReadOnlyList<AppRecord> records)
    {
        var provider = records.FirstOrDefault(app => app.Id == dependency.AppId);
        return provider is not null && AppRuntimeStates.IsUp(provider.RuntimeState) &&
            ProviderEndpointsAnswer(provider, dependency.Endpoints ?? []) &&
            (dependency.Endpoints ?? []).All(wired => (provider.Endpoints ?? []).Any(endpoint =>
                endpoint.Key == wired.EndpointKey && !string.IsNullOrWhiteSpace(endpoint.Url)));
    }

    private static bool DependenciesReady(AppRecord app, IReadOnlyList<AppRecord> records)
        => (app.Dependencies ?? []).Where(dependency => dependency.Required).All(dependency => DependencyReady(dependency, records));

    // Diagnose only unresolved startup edges. A running provider breaks a startup cycle, even if it
    // itself declares a dependency on the consumer. The operator can repair a cycle without reinstalling.
    private static string? DependencyCycle(AppRecord app, IReadOnlyList<AppRecord> records)
    {
        var installed = records.ToDictionary(record => record.Id, StringComparer.Ordinal);
        var path = new List<string>();
        var visited = new HashSet<string>(StringComparer.Ordinal);
        string? Visit(AppRecord current)
        {
            var index = path.IndexOf(current.Id);
            if (index >= 0) return "Required dependency cycle: " + string.Join(" -> ", path.Skip(index).Append(current.Id));
            if (!visited.Add(current.Id)) return null;
            path.Add(current.Id);
            foreach (var dependency in current.Dependencies ?? [])
            {
                if (!dependency.Required || !installed.TryGetValue(dependency.AppId, out var provider) ||
                    AppRuntimeStates.IsUp(provider.RuntimeState)) continue;
                if (Visit(provider) is { } cycle) return cycle;
            }
            path.RemoveAt(path.Count - 1);
            return null;
        }
        return Visit(app);
    }

    // Called under the consumer's operation lock, after its live contract/settings have been checked,
    // and before launching any runtime. It never holds a provider lock or starts that provider.
    private async Task<AppLifecycleResponse?> DeferDependencyStartAsync(
        AppRecord app, CancellationToken cancellationToken, bool preserveOperationStatus = false)
    {
        var records = await apps.ListAppRecordsAsync(cancellationToken);
        if (DependenciesReady(app, records)) return null;
        var cycle = DependencyCycle(app, records);
        var updated = await apps.UpdateAppAsync(app.Id, current => current with
        {
            RuntimeState = AppRuntimeStates.Waiting,
            Health = null,
            LaunchProgress = new("waiting-for-dependencies", clock.UtcNow),
            OperationStatus = preserveOperationStatus || current.OperationStatus == "updating" ? current.OperationStatus : "waiting",
            LastOperation = "start",
            LastError = cycle,
        }, cancellationToken);
        return new(await BuildAppSummaryAsync(updated.App, cancellationToken), null, "waiting");
    }

    // Dynamic eligibility, not dependency waves: a finished provider releases its own consumers while
    // independent slow starts retain only their individual slots. Blocked apps use no launch slot.
    private async Task<IReadOnlyList<AppBackgroundLifecycleResult>> ScheduleDependencyStartsAsync(
        IEnumerable<AppRecord> candidates, string operation, bool waitingOnly, CancellationToken cancellationToken)
    {
        var pending = candidates.OrderByDescending(app => app.System).ThenBy(app => app.Id, StringComparer.Ordinal)
            .Select(app => app.Id).ToList();
        var tasks = new List<Task<AppBackgroundLifecycleResult>>();
        var active = new List<Task<AppBackgroundLifecycleResult>>(MaxConcurrentAutostarts);
        try
        {
            while (pending.Count > 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
                active.RemoveAll(task => task.IsCompleted);
                if (active.Count == MaxConcurrentAutostarts)
                {
                    await Task.WhenAny(active).WaitAsync(cancellationToken);
                    continue;
                }
                var records = await apps.ListAppRecordsAsync(cancellationToken);
                pending.RemoveAll(id => !records.Any(app => app.Id == id));
                if (pending.Count == 0) break;
                var id = pending.FirstOrDefault(id => records.Any(app => app.Id == id &&
                    (AppRuntimeStates.IsUp(app.RuntimeState) || DependenciesReady(app, records))));
                if (id is null && active.Count > 0)
                {
                    await Task.WhenAny(active).WaitAsync(cancellationToken);
                    continue;
                }
                if (id is null && waitingOnly) break;
                // No remaining provider can finish inside this tier. Record the unresolved intent and
                // continue to the next tier; Start still rechecks the live manifest and current state.
                id ??= pending[0];
                pending.Remove(id);
                var task = RunBackgroundLifecycleActionAsync(id, operation, () =>
                    StartScheduledAppAsync(id, waitingOnly, cancellationToken), cancellationToken);
                tasks.Add(task);
                active.Add(task);
            }
        }
        finally
        {
            // Drain admitted operations even on cancellation: no launch escapes the caller's lifetime.
            await Task.WhenAll(tasks);
        }
        return tasks.Select(task => task.Result).ToArray();
    }

    private Task<AppLifecycleResponse> StartScheduledAppAsync(string appId, bool waitingOnly, CancellationToken ct)
        => WithAppLockAsync(appId, async () =>
        {
            var app = await RequireAppAsync(appId, ct);
            if (waitingOnly && app.RuntimeState != AppRuntimeStates.Waiting)
                return new(await BuildAppSummaryAsync(app, ct), null, "skipped");
            if ((await GetConfigurationReadinessAsync(app, ct)).Required)
                return new(await BuildAppSummaryAsync(app, ct), null, "configuration-required");
            return await StartCoreAsync(appId, afterOwnStop: false, ct);
        }, ct, allowDevelopment: true, startsDevelopmentRuntime: true);

    /// <summary>Rechecks durable waiting intents under their own locks; a concurrent Stop wins before admission.</summary>
    public async Task ResumeWaitingAppsAsync(CancellationToken cancellationToken = default, IReadOnlySet<string>? allowedIds = null)
    {
        await dependencyResumeGate.WaitAsync(cancellationToken);
        try
        {
            var records = await apps.ListAppRecordsAsync(cancellationToken);
            var waiting = records.Where(app => app.Kind == "runtime" && app.RuntimeState == AppRuntimeStates.Waiting &&
                (allowedIds is null || allowedIds.Contains(app.Id))).ToArray();
            // A manifest/provider change can expose a new cycle. Only write changed diagnostics, so
            // registry notifications do not produce a self-sustaining wake loop.
            foreach (var app in waiting)
            {
                var cycle = DependencyCycle(app, records);
                if (cycle == app.LastError) continue;
                await WithAppLockAsync(app.Id, async () =>
                {
                    var current = await RequireAppAsync(app.Id, cancellationToken);
                    if (current.RuntimeState == AppRuntimeStates.Waiting)
                        await apps.UpdateAppAsync(app.Id, value => value with { LastError = cycle }, cancellationToken);
                    return true;
                }, cancellationToken, allowDevelopment: true);
            }
            await ScheduleDependencyStartsAsync(waiting, "dependency-start", true, cancellationToken);
        }
        finally { dependencyResumeGate.Release(); }
    }
}
