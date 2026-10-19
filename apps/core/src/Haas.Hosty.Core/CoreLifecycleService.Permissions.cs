namespace Haas.Hosty.Core;

internal sealed record AppPermissionObservation(
    string Status, IReadOnlyList<string> Required, IReadOnlyList<string> Optional,
    IReadOnlyList<string> AcceptedRequired, IReadOnlyList<string> AcceptedOptional,
    IReadOnlyList<string> Granted, IReadOnlyList<string> MissingRequired,
    bool ReviewRequired, IReadOnlyList<string> UnconfirmedRoles, string? Error,
    DateTimeOffset? CheckedAt)
{
    public IReadOnlyList<string> UnsupportedRequired => Required.Where(p => !CoreAppPermissions.Known.Contains(p, StringComparer.Ordinal)).ToArray();
    public IReadOnlyList<string> UnsupportedOptional => Optional.Where(p => !CoreAppPermissions.Known.Contains(p, StringComparer.Ordinal)).ToArray();

    public IReadOnlyDictionary<string, string> Descriptions => Required.Concat(Optional)
        .Concat(AcceptedRequired).Concat(AcceptedOptional).Concat(Granted).Distinct(StringComparer.Ordinal)
        .ToDictionary(p => p, CoreAppPermissions.Describe, StringComparer.Ordinal);
}

internal sealed partial class CoreLifecycleService
{
    private sealed record PermissionCandidate(string Source, string Runtime, string? Digest,
        IReadOnlyList<string> Required, IReadOnlyList<string> Optional, IReadOnlyList<string> Roles);
    private sealed record PermissionSnapshot(string Identity, AppPermissionObservation Observation);
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, PermissionSnapshot> permissionSnapshots = new(StringComparer.Ordinal);
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, (DateTimeOffset Installation, string Path)> observedPermissionCheckouts = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim permissionObservationGate = new(1, 1);

    internal static string PermissionIdentity(AppRecord app) => string.Join("\n", app.InstalledAt.ToString("O"),
        app.PermissionRevision, app.Version, app.AppliedSourceManifestDigest,
        string.Join(",", (app.RuntimeProfiles ?? []).Select(p => $"{p.Key}:{p.Type}:{p.Development}")), app.SelectedRuntime, app.ManifestPath, app.InstallManifestPath, app.ManifestUrl, app.SourceState?.LocalOverridePath,
        app.SourceState?.ManagedCheckoutPath, app.SourceState?.ManifestSubpath,
        string.Join(",", app.RequiredCorePermissions ?? []), string.Join(",", app.OptionalCorePermissions ?? []),
        string.Join(",", app.GrantedCorePermissions ?? []), string.Join(",", app.ConfirmedRoles ?? []));

    private static AppPermissionObservation UnknownPermissions(AppRecord app) => new("unknown", [], [],
        app.RequiredCorePermissions ?? app.GrantedCorePermissions ?? [], app.OptionalCorePermissions ?? [],
        app.GrantedCorePermissions ?? [], [], false, [], null, null);

    internal AppPermissionObservation CachedPermissions(AppRecord app)
        => permissionSnapshots.TryGetValue(app.Id, out var snapshot) && snapshot.Identity == PermissionIdentity(app)
            ? snapshot.Observation : UnknownPermissions(app);

    internal sealed record PermissionManifestSource(string? Path, string? LiveRoot, string? WatchPath);

    internal async Task<PermissionManifestSource> ResolvePermissionManifestAsync(AppRecord app, CancellationToken ct)
    {
        var profiles = await ResolveRuntimeProfilesAsync(app, ct);
        var live = ResolveLiveSourcePath(app, profiles);
        string? pendingCheckout = null;
        if (profiles.Any(p => p.Key == app.SelectedRuntime && p.Development))
        {
            // Missing configured source is an observation failure, not permission to fall back
            // to an older installed manifest and report that the current contract is healthy.
            if (!string.IsNullOrWhiteSpace(app.SourceState?.LocalOverridePath)) live = app.SourceState.LocalOverridePath;
            // Before the first clone, retain the installed contract but watch for materialization.
            // Once observed, a disappearing checkout is an error, not a return to installed bytes.
            else if (!string.IsNullOrWhiteSpace(app.SourceState?.ManagedCheckoutPath))
            {
                var checkout = app.SourceState.ManagedCheckoutPath;
                if (Directory.Exists(checkout)) observedPermissionCheckouts[app.Id] = (app.InstalledAt, checkout);
                if (observedPermissionCheckouts.TryGetValue(app.Id, out var seen) && seen == (app.InstalledAt, checkout)) live = checkout;
                else pendingCheckout = checkout;
            }
            if (live is null && string.IsNullOrWhiteSpace(app.ManifestUrl) && !string.IsNullOrWhiteSpace(app.InstallManifestPath)
                && !IsInternalAppPath(app.Id, app.InstallManifestPath)) live = app.InstallManifestPath;
        }
        if (live is not null && Uri.TryCreate(live, UriKind.Absolute, out var uri) && uri.IsFile) live = uri.LocalPath;
        // Overrides/checkouts are directories even when absent or their names contain a dot.
        // Original local installs can instead name a manifest file directly.
        var sourceFile = live is not null && live != app.SourceState?.LocalOverridePath
            && live != app.SourceState?.ManagedCheckoutPath && !Directory.Exists(live)
            && (File.Exists(live) || System.IO.Path.HasExtension(live));
        var path = live is null ? app.ManifestPath : CombineManifestSubpath(live, app.SourceState?.ManifestSubpath);
        if (live is not null && !sourceFile) path = System.IO.Path.Combine(path!, "manifest.json");
        var liveRoot = live is null ? null : sourceFile ? System.IO.Path.GetDirectoryName(live) : live;
        var watchPath = liveRoot is not null ? path : pendingCheckout is not null
            ? System.IO.Path.Combine(CombineManifestSubpath(pendingCheckout, app.SourceState?.ManifestSubpath), "manifest.json") : null;
        return new(path, liveRoot ?? pendingCheckout, watchPath);
    }

    internal void ForgetPermissionObservation(string appId)
    {
        permissionSnapshots.TryRemove(appId, out _);
        observedPermissionCheckouts.TryRemove(appId, out _);
    }

    private async Task<PermissionCandidate> ReadPermissionCandidateAsync(AppRecord app, CancellationToken ct, bool forceRead = false)
    {
        var path = (await ResolvePermissionManifestAsync(app, ct)).Path;
        // Older records can manage their already accepted optional choices without a source path.
        // They cannot discover or introduce declarations this way.
        if (string.IsNullOrWhiteSpace(path))
        {
            if (app.RequiredCorePermissions is null && app.OptionalCorePermissions is null)
                throw new AppLifecycleException("permission_manifest_unavailable", "The installed manifest is unavailable. Restore it before reviewing new permissions.");
            return new("stored", app.SelectedRuntime ?? "", null, app.RequiredCorePermissions ?? app.GrantedCorePermissions ?? [],
                app.OptionalCorePermissions ?? [], app.ConfirmedRoles ?? []);
        }
        if (Uri.TryCreate(path, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https")
            throw new AppLifecycleException("permission_manifest_unavailable", "Review the installed manifest locally; remote releases require an app update review.");
        // Never use a remote update/feed or the last-good fallback for a broken live manifest.
        var selection = await manifests.LoadAsync(path, app.SelectedRuntime, ct, validateAllProfiles: true, forceRead: forceRead, allowUnsupportedPermissions: true);
        if (selection.Manifest.Id != app.Id)
            throw new AppLifecycleException("permission_manifest_invalid", "The source manifest describes a different app.");
        return new(selection.ManifestPath, selection.RuntimeProfile.Key, selection.ManifestDigest,
            selection.Manifest.CorePermissions.ToArray(), selection.Manifest.OptionalCorePermissions.ToArray(),
            selection.Manifest.Provides.ToArray());
    }

    internal async Task<AppPermissionObservation> ObservePermissionsAsync(string appId, bool refresh, CancellationToken ct, bool forceRead = false)
    {
        await permissionObservationGate.WaitAsync(ct);
        try
        {
            var app = await apps.GetAppAsync(appId, ct)
                ?? throw new AppLifecycleException("app_not_found", "The app is no longer installed.");
            var identity = PermissionIdentity(app);
            var prior = CachedPermissions(app);
            if (!refresh && !forceRead && prior.CheckedAt is not null) return prior;
            AppPermissionObservation observed;
            try
            {
                var candidate = await ReadPermissionCandidateAsync(app, ct, forceRead || refresh);
                var required = app.RequiredCorePermissions ?? app.GrantedCorePermissions ?? [];
                var optional = app.OptionalCorePermissions ?? [];
                var granted = app.GrantedCorePermissions ?? [];
                observed = new("known", candidate.Required, candidate.Optional, required, optional, granted,
                    candidate.Required.Where(p => CoreAppPermissions.Known.Contains(p, StringComparer.Ordinal)).Except(granted, StringComparer.Ordinal).ToArray(),
                    !candidate.Required.ToHashSet(StringComparer.Ordinal).SetEquals(required)
                    || !candidate.Optional.ToHashSet(StringComparer.Ordinal).SetEquals(optional)
                    || app.RequiredCorePermissions is null || app.OptionalCorePermissions is null,
                    candidate.Roles.Except(app.ConfirmedRoles ?? [], StringComparer.Ordinal).ToArray(), null, clock.UtcNow);
            }
            catch (Exception ex) when (ex is AppManifestException or AppLifecycleException or IOException or UnauthorizedAccessException or System.Text.Json.JsonException)
            {
                observed = prior with {
                    Status = AppRuntimeStates.IsUp(app.RuntimeState) || prior.Status != "unknown" ? "stale" : "unknown",
                    Error = ex.Message, CheckedAt = clock.UtcNow,
                };
            }
            // A concurrent lifecycle operation must not publish an observation for its old installation.
            var current = await apps.GetAppAsync(appId, ct);
            if (current is null || PermissionIdentity(current) != identity) return current is null ? observed : CachedPermissions(current);
            permissionSnapshots[appId] = new(identity, observed);
            if (System.Text.Json.JsonSerializer.Serialize(prior with { CheckedAt = null }, CoreJson.TypeInfo<AppPermissionObservation>())
                != System.Text.Json.JsonSerializer.Serialize(observed with { CheckedAt = null }, CoreJson.TypeInfo<AppPermissionObservation>()))
                events?.PublishAppEvent(CoreEventHub.AppChanged, appId);
            return observed;
        }
        finally { permissionObservationGate.Release(); }
    }

    internal async Task ObserveAppPermissionsAsync(CancellationToken ct)
    {
        var records = await apps.ListAppRecordsAsync(ct);
        var installed = records.Select(a => a.Id).ToHashSet(StringComparer.Ordinal);
        foreach (var id in permissionSnapshots.Keys.Where(id => !installed.Contains(id))) permissionSnapshots.TryRemove(id, out _);
        foreach (var app in records)
        {
            // Observation must neither interrupt an in-flight lifecycle operation nor queue behind
            // it and delay checks for every other app. The event observer retries busy apps separately.
            var mutex = apps.OperationLock(app.Id);
            if (!await mutex.WaitAsync(0, ct)) continue;
            try
            {
                var current = await apps.GetAppAsync(app.Id, ct);
                if (current is null) continue;
                var running = AppRuntimeStates.IsUp(current.RuntimeState);
                await ObservePermissionsAsync(current.Id, false, ct, forceRead: running);
            }
            finally { mutex.Release(); }
        }
    }

    internal Task<AppPermissionPlan> CreatePermissionPlanAsync(string appId, CancellationToken ct)
        => WithAppLockAsync(appId, async () =>
        {
            var app = await apps.GetAppAsync(appId, ct) ?? throw new AppLifecycleException("app_not_found", "The app is no longer installed.");
            var candidate = await ReadPermissionCandidateAsync(app, ct, forceRead: true);
            _ = CoreAppPermissions.ResolveGrants(candidate.Required, candidate.Optional, []);
            return new AppPermissionPlan(app.Id, app.DisplayName, app.InstalledAt, app.PermissionRevision,
                candidate.Required, candidate.Optional, app.GrantedCorePermissions ?? [],
                candidate.Source, candidate.Runtime, candidate.Digest, PermissionIdentity(app),
                app.RequiredCorePermissions ?? app.GrantedCorePermissions ?? [], app.OptionalCorePermissions ?? []);
        }, ct);
}
