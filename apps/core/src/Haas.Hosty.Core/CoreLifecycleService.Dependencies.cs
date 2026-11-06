namespace Haas.Hosty.Core;

internal sealed partial class CoreLifecycleService
{
    private readonly TaskCompletionSource dependencyStartupReady = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly SemaphoreSlim dependencyResumeGate = new(1, 1);
    internal Task DependencyStartupReady => dependencyStartupReady.Task;
    private readonly AsyncLocal<bool> dependencyAdmission = new();
    private readonly AsyncLocal<string[]?> dependencyActivationSelection = new();
    private readonly AsyncLocal<DependencyStartAuthority?> dependencyAuthority = new();
    private readonly AsyncLocal<System.Collections.Concurrent.ConcurrentDictionary<string, byte>?> bootDependencyAttempts = new();

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
        var intent = app.DependencyStart;
        if (intent is null && !dependencyAdmission.Value)
        {
            var authority = dependencyAuthority.Value ?? (dependencyAuthorization is null ? new DependencyStartAuthority("operator")
                : await dependencyAuthorization.CaptureAsync(cancellationToken));
            if (dependencyActivationSelection.Value is { } selection) authority = authority with { ProviderIds = selection };
            intent = new(Guid.NewGuid().ToString("N"), authority, RequiredProviders(app, records)
                .Select(id => SnapshotProvider(id, records) with { Attempted = bootDependencyAttempts.Value?.ContainsKey(id) == true ||
                    SnapshotProvider(id, records).Attempted }).ToArray());
        }
        var cycle = DependencyDiagnostic(app, records, intent);
        var updated = await apps.UpdateAppAsync(app.Id, current => current with
        {
            RuntimeState = AppRuntimeStates.Waiting,
            DependencyStart = intent,
            DependencyBorrowedStart = intent is null && dependencyAdmission.Value,
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
        IEnumerable<AppRecord> candidates, string operation, bool waitingOnly, CancellationToken cancellationToken,
        IReadOnlyList<AppRecord>? bootRoots = null)
    {
        var expected = candidates.ToDictionary(app => app.Id, StringComparer.Ordinal);
        var pending = expected.Values.OrderByDescending(app => app.System).ThenBy(app => app.Id, StringComparer.Ordinal)
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
                    StartScheduledAppAsync(expected[id], waitingOnly, cancellationToken, bootRoots), cancellationToken);
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

    private Task<AppLifecycleResponse> StartScheduledAppAsync(AppRecord expected, bool waitingOnly, CancellationToken ct,
        IReadOnlyList<AppRecord>? bootRoots)
        => WithAppLockAsync(expected.Id, async () =>
        {
            var appId = expected.Id;
            var app = await RequireAppAsync(appId, ct);
            var records = await apps.ListAppRecordsAsync(ct);
            if (app.DependencyStopVersion != expected.DependencyStopVersion || bootRoots is not null && !bootRoots.Any(root =>
                records.FirstOrDefault(current => current.Id == root.Id) is { } current && current.DependencyStopVersion == root.DependencyStopVersion &&
                (current.Id == appId || RequiredProviders(current, records, includeRunning: true).Contains(appId))))
                return new(await BuildAppSummaryAsync(app, ct), null, "skipped");
            if (waitingOnly && app.RuntimeState != AppRuntimeStates.Waiting)
                return new(await BuildAppSummaryAsync(app, ct), null, "skipped");
            if ((await GetConfigurationReadinessAsync(app, ct)).Required)
                return new(await BuildAppSummaryAsync(app, ct), null, "configuration-required");
            bootDependencyAttempts.Value?.TryAdd(appId, 0);
            var previous = dependencyAdmission.Value;
            dependencyAdmission.Value = bootRoots is not null && !bootRoots.Any(root => root.Id == appId);
            if (!dependencyAdmission.Value && !waitingOnly)
                await apps.UpdateAppAsync(appId, value => value with { DependencyStart = null, DependencyBorrowedStart = false }, ct);
            try { return await StartCoreAsync(appId, afterOwnStop: false, ct); }
            finally { dependencyAdmission.Value = previous; }
        }, ct, allowDevelopment: true, startsDevelopmentRuntime: true, resumeWaitingDevelopment: true);

    private async Task<T> ResumeWaitingDevelopmentAsync<T>(AppRecord app, AppDevOperation development,
        Func<Task<T>> start, CancellationToken ct)
    {
        await ValidateDevBindingAsync(app, development, ct);
        var installed = await manifests.LoadAsync(app.ManifestPath!, app.SelectedRuntime, ct);
        await ValidateDevSourceAuthorityAsync(app, installed, development.Actor, ct);
        if (development.WorktreeId is { } treeId)
            return await DevWorkspaces.WithDevAdmissionAsync(treeId, app, development.Actor.WorkspaceOwner, start, ct);
        return await start();
    }

    // The root remains the owner of a cascade. Providers never acquire independent waiting intents
    // merely because a consumer needs them; cancelling the last root therefore cancels unadmitted work.
    private static HashSet<string> RequiredProviders(AppRecord root, IReadOnlyList<AppRecord> records, bool includeRunning = false)
    {
        var result = new HashSet<string>(StringComparer.Ordinal);
        var installed = records.ToDictionary(app => app.Id, StringComparer.Ordinal);
        void Visit(AppRecord current)
        {
            foreach (var dependency in current.Dependencies ?? [])
            {
                if (!dependency.Required || dependency.AppId == root.Id || !result.Add(dependency.AppId)) continue;
                if (installed.TryGetValue(dependency.AppId, out var provider) && (includeRunning || !AppRuntimeStates.IsUp(provider.RuntimeState))) Visit(provider);
            }
        }
        Visit(root);
        return result;
    }

    private static DependencyStartAttempt SnapshotProvider(string id, IReadOnlyList<AppRecord> records)
    {
        var provider = records.FirstOrDefault(app => app.Id == id);
        return new(id, provider?.InstalledAt, provider?.DependencyStopVersion,
            provider is not null && (AppRuntimeStates.IsUp(provider.RuntimeState) || AppRuntimeStates.IsBusy(provider.RuntimeState)));
    }

    private static string? DependencyDiagnostic(AppRecord root, IReadOnlyList<AppRecord> records, DependencyStartIntent? intent)
    {
        if (DependencyCycle(root, records) is { } cycle) return cycle;
        var visited = new HashSet<string>(StringComparer.Ordinal);
        string? Visit(AppRecord consumer, string chain)
        {
            if (!visited.Add(consumer.Id)) return null;
            foreach (var dependency in consumer.Dependencies ?? [])
            {
                if (!dependency.Required || DependencyReady(dependency, records)) continue;
                var path = chain + " -> " + dependency.AppId;
                var provider = records.FirstOrDefault(app => app.Id == dependency.AppId);
                if (provider is null) return path + ": required application is not installed.";
                var attempt = intent?.Providers.FirstOrDefault(entry => entry.AppId == provider.Id);
                if (attempt?.Installation is { } installation && installation != provider.InstalledAt)
                    return path + ": installation changed; retry Start to review the current dependency.";
                if (attempt is not null && attempt.StopVersion != provider.DependencyStopVersion)
                    return path + ": explicitly stopped; retry Start when it should run again.";
                if (attempt?.Error is { } error) return path + ": " + error;
                if (provider.LastError is { } failure) return path + ": " + failure;
                if (attempt?.Attempted == true && AppRuntimeStates.IsIdle(provider.RuntimeState))
                    return path + ": the start did not complete; retry Start.";
                if (Visit(provider, path) is { } nested) return nested;
                if (AppRuntimeStates.IsUp(provider.RuntimeState))
                    return path + ": required endpoints are unhealthy or have no resolved URL.";
            }
            return null;
        }
        return Visit(root, root.Id);
    }

    private async Task<DependencyStartIntent> RefreshDependencyIntentAsync(AppRecord root, IReadOnlyList<AppRecord> records, CancellationToken ct)
    {
        var intent = root.DependencyStart!;
        var providers = intent.Providers.ToDictionary(entry => entry.AppId, StringComparer.Ordinal);
        var changed = false;
        foreach (var id in RequiredProviders(root, records))
        {
            if (!providers.TryGetValue(id, out var entry) || entry.Installation is null && records.Any(app => app.Id == id))
            {
                var snapshot = SnapshotProvider(id, records);
                // Installing a previously missing app does not erase an explicit Stop made before
                // this coordinator observes it. New graph edges use their current generation.
                providers[id] = entry is { Installation: null } ? snapshot with { StopVersion = entry.StopVersion } : snapshot;
                changed = true;
            }
        }
        if (!changed) return intent;
        var updated = intent with { Providers = providers.Values.ToArray() };
        var saved = await apps.UpdateAppAsync(root.Id, current =>
        {
            if (current.RuntimeState != AppRuntimeStates.Waiting || current.DependencyStart?.Id != intent.Id) return current;
            // Admission of another branch may have recorded an attempt since the snapshot was read.
            var merged = current.DependencyStart.Providers.ToDictionary(entry => entry.AppId, StringComparer.Ordinal);
            foreach (var entry in updated.Providers)
                if (!merged.TryGetValue(entry.AppId, out var live) || live.Installation is null) merged[entry.AppId] = entry;
            return current with { DependencyStart = current.DependencyStart with { Providers = merged.Values.ToArray() } };
        }, ct);
        return saved.App.DependencyStart ?? updated;
    }

    private sealed record DependencyCandidate(string AppId, string RootId, string? IntentId, bool Provider, string? UserId);

    private async Task<IReadOnlyList<DependencyCandidate>> DependencyCandidatesAsync(IReadOnlySet<string>? allowedIds, CancellationToken ct)
    {
        var records = await apps.ListAppRecordsAsync(ct);
        foreach (var orphan in records.Where(app => app.RuntimeState == AppRuntimeStates.Waiting && app.DependencyBorrowedStart))
        {
            await WithAppLockAsync(orphan.Id, async () =>
            {
                var current = await apps.ListAppRecordsAsync(ct);
                if (current.Any(root => root.RuntimeState == AppRuntimeStates.Waiting && !root.DependencyBorrowedStart &&
                    RequiredProviders(root, current).Contains(orphan.Id))) return false;
                await apps.UpdateAppAsync(orphan.Id, value => value.RuntimeState == AppRuntimeStates.Waiting && value.DependencyBorrowedStart
                    ? value with { RuntimeState = AppRuntimeStates.Stopped, OperationStatus = "stopped", LaunchProgress = null,
                        DependencyBorrowedStart = false, LastError = null } : value, ct);
                return true;
            }, ct, allowDevelopment: true);
        }
        records = await apps.ListAppRecordsAsync(ct);
        var candidates = new List<DependencyCandidate>();
        foreach (var root in records.Where(app => app.Kind == "runtime" && app.RuntimeState == AppRuntimeStates.Waiting && !app.DependencyBorrowedStart &&
            (allowedIds is null || allowedIds.Contains(app.Id))))
        {
            var intent = root.DependencyStart is null ? null : await RefreshDependencyIntentAsync(root, records, ct);
            var diagnostic = DependencyDiagnostic(root, records, intent);
            if (root.LastError != diagnostic)
                await apps.UpdateAppAsync(root.Id, current => current.RuntimeState == AppRuntimeStates.Waiting && current.DependencyStart?.Id == intent?.Id
                    ? current with { LastError = diagnostic } : current, ct);
            if (DependenciesReady(root, records))
                candidates.Add(new(root.Id, root.Id, intent?.Id, false, intent?.Authority.UserId));
            if (intent is null || DependencyCycle(root, records) is not null) continue;
            var needed = RequiredProviders(root, records);
            foreach (var attempt in intent.Providers)
            {
                var provider = records.FirstOrDefault(app => app.Id == attempt.AppId);
                if (!needed.Contains(attempt.AppId) || provider is null || provider.Kind != "runtime" ||
                    allowedIds is not null && !allowedIds.Contains(provider.Id) ||
                    attempt.Installation != provider.InstalledAt || attempt.StopVersion != provider.DependencyStopVersion ||
                    attempt.Error is not null || attempt.Attempted && provider.RuntimeState != AppRuntimeStates.Waiting ||
                    AppRuntimeStates.IsUp(provider.RuntimeState) || AppRuntimeStates.IsBusy(provider.RuntimeState) ||
                    !DependenciesReady(provider, records)) continue;
                candidates.Add(new(provider.Id, root.Id, intent.Id, true, intent.Authority.UserId));
            }
        }
        return candidates.OrderByDescending(candidate => records.First(app => app.Id == candidate.AppId).System)
            .ThenBy(candidate => candidate.AppId, StringComparer.Ordinal).ToArray();
    }

    private async Task ValidateDependencyRootAsync(AppRecord root, DependencyStartIntent intent, string target, bool provider, CancellationToken ct)
    {
        if (provider && intent.Authority.ProviderIds is { } selected && !selected.Contains(target, StringComparer.Ordinal))
            throw new AppLifecycleException("dependency_not_selected", $"'{target}' is outside the reviewed workspace activation. Start it or include it explicitly in a new activation.");
        if (dependencyAuthorization is not null) await dependencyAuthorization.ValidateAsync(intent.Authority, target, provider, ct);
        else if (intent.Authority.Kind != "operator")
            throw new AppLifecycleException("dependency_start_forbidden", "The original start authority cannot be revalidated.");
        if (await AppDevStore.ReadAsync(paths, root, ct) is { Active: true } development)
        {
            await ValidateDevBindingAsync(root, development, ct);
            var selection = await manifests.LoadAsync(root.ManifestPath!, root.SelectedRuntime, ct);
            await ValidateDevSourceAuthorityAsync(root, selection, development.Actor, ct);
        }
    }

    private async Task SetDependencyAttemptAsync(DependencyCandidate candidate, string? error, bool allConsumers, CancellationToken ct)
    {
        var records = await apps.ListAppRecordsAsync(ct);
        foreach (var root in records.Where(app => app.RuntimeState == AppRuntimeStates.Waiting && app.DependencyStart is not null &&
            (allConsumers || app.Id == candidate.RootId && app.DependencyStart.Id == candidate.IntentId)))
        {
            var intent = root.DependencyStart!;
            if (!intent.Providers.Any(entry => entry.AppId == candidate.AppId)) continue;
            await apps.UpdateAppAsync(root.Id, current => current.DependencyStart?.Id != intent.Id ? current : current with
            {
                DependencyStart = current.DependencyStart with { Providers = current.DependencyStart.Providers.Select(entry =>
                    entry.AppId == candidate.AppId ? entry with { Attempted = true, Error = error } : entry).ToArray() },
            }, ct);
        }
    }

    private async Task StartDependencyCandidateAsync(DependencyCandidate candidate, CancellationToken ct)
    {
        // A candidate is just a hint. Authority, demand, Stop generations and readiness are checked
        // again after acquiring this one app's lock; no consumer/provider lock nesting is needed.
        try
        {
            var admitted = await WithAppLockAsync(candidate.AppId, async () =>
            {
                var records = await apps.ListAppRecordsAsync(ct);
                var root = records.FirstOrDefault(app => app.Id == candidate.RootId);
                var app = records.FirstOrDefault(app => app.Id == candidate.AppId);
                if (root?.RuntimeState != AppRuntimeStates.Waiting || root.DependencyStart?.Id != candidate.IntentId || app is null ||
                    AppRuntimeStates.IsUp(app.RuntimeState) || AppRuntimeStates.IsBusy(app.RuntimeState) || !DependenciesReady(app, records)) return false;
                if (candidate.Provider)
                {
                    var attempt = root.DependencyStart?.Providers.FirstOrDefault(entry => entry.AppId == app.Id);
                    if (attempt is null || attempt.Installation != app.InstalledAt || attempt.StopVersion != app.DependencyStopVersion ||
                        attempt.Error is not null || attempt.Attempted && app.RuntimeState != AppRuntimeStates.Waiting ||
                        !RequiredProviders(root, records).Contains(app.Id)) return false;
                }
                if (root.DependencyStart is { } intent) await ValidateDependencyRootAsync(root, intent, app.Id, candidate.Provider, ct);
                if ((await GetConfigurationReadinessAsync(app, ct)).Required)
                    throw new AppLifecycleException("dependency_configuration_required", $"'{app.Id}' requires configuration before it can start.");
                if (candidate.Provider) await SetDependencyAttemptAsync(candidate, null, true, ct);
                var previous = dependencyAdmission.Value;
                dependencyAdmission.Value = true;
                try { await StartCoreAsync(app.Id, afterOwnStop: false, ct); }
                finally { dependencyAdmission.Value = previous; }
                return true;
            }, ct, allowDevelopment: true, startsDevelopmentRuntime: true, resumeWaitingDevelopment: !candidate.Provider);
            if (admitted) await AuditDependencyStartAsync(candidate, "succeeded", ct);
        }
        catch (Exception ex) when (IsRecordableLifecycleFailure(ex))
        {
            if (candidate.Provider) await SetDependencyAttemptAsync(candidate, ex.Message, false, ct);
            else await RecordBackgroundLifecycleFailureAsync(candidate.AppId, "dependency-start", ex.Message, ct);
            await AuditDependencyStartAsync(candidate, "failed", ct);
        }
    }

    private async Task AuditDependencyStartAsync(DependencyCandidate candidate, string outcome, CancellationToken ct)
    {
        if (audit is null) return;
        try
        {
            await audit.AppendAsync(new(Guid.NewGuid().ToString("N"), "app.lifecycle.dependency-start", "app", candidate.AppId,
                outcome, candidate.UserId, clock.UtcNow,
                new Dictionary<string, string> { ["consumerAppId"] = candidate.RootId, ["via"] = "dependency" }), ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        { logger.LogWarning(ex, "Could not audit dependency start for {AppId}.", candidate.AppId); }
    }

    /// <summary>Runs pending dependency graphs; concurrent Stop and shared providers are rechecked at admission.</summary>
    public async Task ResumeWaitingAppsAsync(CancellationToken cancellationToken = default, IReadOnlySet<string>? allowedIds = null)
    {
        await dependencyResumeGate.WaitAsync(cancellationToken);
        var active = new Dictionary<string, Task>(StringComparer.Ordinal);
        try
        {
            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();
                foreach (var id in active.Where(pair => pair.Value.IsCompleted).Select(pair => pair.Key).ToArray())
                {
                    await active[id];
                    active.Remove(id);
                }
                var candidates = await DependencyCandidatesAsync(allowedIds, cancellationToken);
                var next = candidates.FirstOrDefault(candidate => !active.ContainsKey(candidate.AppId));
                if (next is not null && active.Count < MaxConcurrentAutostarts)
                {
                    active.Add(next.AppId, StartDependencyCandidateAsync(next, cancellationToken));
                    continue;
                }
                if (active.Count == 0) break;
                await Task.WhenAny(active.Values).WaitAsync(cancellationToken);
            }
        }
        finally
        {
            try { await Task.WhenAll(active.Values); }
            finally { dependencyResumeGate.Release(); }
        }
    }
}
