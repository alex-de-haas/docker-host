using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core;

internal sealed record AppPermissionObservation(
    string Status, IReadOnlyList<string> Required, IReadOnlyList<string> Optional,
    IReadOnlyList<string> AcceptedRequired, IReadOnlyList<string> AcceptedOptional,
    IReadOnlyList<string> Granted, IReadOnlyList<string> MissingRequired,
    bool ReviewRequired, IReadOnlyList<string> UnconfirmedRoles, string? Error,
    DateTimeOffset? CheckedAt)
{
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
    private readonly SemaphoreSlim permissionObservationGate = new(1, 1);

    private static string PermissionIdentity(AppRecord app) => string.Join("\n", app.InstalledAt.ToString("O"),
        app.PermissionRevision, app.SelectedRuntime, app.ManifestPath, app.InstallManifestPath, app.ManifestUrl, app.SourceState?.LocalOverridePath,
        app.SourceState?.ManagedCheckoutPath, app.SourceState?.ManifestSubpath,
        string.Join(",", app.RequiredCorePermissions ?? []), string.Join(",", app.OptionalCorePermissions ?? []),
        string.Join(",", app.GrantedCorePermissions ?? []), string.Join(",", app.ConfirmedRoles ?? []));

    private static AppPermissionObservation UnknownPermissions(AppRecord app) => new("unknown", [], [],
        app.RequiredCorePermissions ?? app.GrantedCorePermissions ?? [], app.OptionalCorePermissions ?? [],
        app.GrantedCorePermissions ?? [], [], false, [], null, null);

    private AppPermissionObservation CachedPermissions(AppRecord app)
        => permissionSnapshots.TryGetValue(app.Id, out var snapshot) && snapshot.Identity == PermissionIdentity(app)
            ? snapshot.Observation : UnknownPermissions(app);

    private async Task<PermissionCandidate> ReadPermissionCandidateAsync(AppRecord app, CancellationToken ct, bool forceRead = false)
    {
        var profiles = await ResolveRuntimeProfilesAsync(app, ct);
        var live = ResolveLiveSourcePath(app, profiles);
        if (profiles.Any(p => p.Key == app.SelectedRuntime && p.Development))
        {
            // Missing configured source is an observation failure, not permission to fall back
            // to an older installed manifest and report that the current contract is healthy.
            if (!string.IsNullOrWhiteSpace(app.SourceState?.LocalOverridePath)) live = app.SourceState.LocalOverridePath;
            else if (!string.IsNullOrWhiteSpace(app.SourceState?.ManagedCheckoutPath)) live = app.SourceState.ManagedCheckoutPath;
            else if (string.IsNullOrWhiteSpace(app.ManifestUrl) && !string.IsNullOrWhiteSpace(app.InstallManifestPath)
                && !IsInternalAppPath(app.Id, app.InstallManifestPath)) live = app.InstallManifestPath;
        }
        var path = live is null ? app.ManifestPath : CombineManifestSubpath(live, app.SourceState?.ManifestSubpath);
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
        var selection = await manifests.LoadAsync(path, app.SelectedRuntime, ct, validateAllProfiles: true, forceRead: forceRead);
        if (selection.Manifest.Id != app.Id)
            throw new AppLifecycleException("permission_manifest_invalid", "The source manifest describes a different app.");
        return new(selection.ManifestPath, selection.RuntimeProfile.Key, selection.ManifestDigest,
            selection.Manifest.CorePermissions.ToArray(), selection.Manifest.OptionalCorePermissions.ToArray(),
            selection.Manifest.Provides.ToArray());
    }

    internal async Task<AppPermissionObservation> ObservePermissionsAsync(string appId, bool refresh, CancellationToken ct)
    {
        await permissionObservationGate.WaitAsync(ct);
        try
        {
            var app = await apps.GetAppAsync(appId, ct)
                ?? throw new AppLifecycleException("app_not_found", "The app is no longer installed.");
            var identity = PermissionIdentity(app);
            var prior = CachedPermissions(app);
            if (!refresh && prior.CheckedAt is { } checkedAt && clock.UtcNow - checkedAt < TimeSpan.FromSeconds(5)) return prior;
            AppPermissionObservation observed;
            try
            {
                var candidate = await ReadPermissionCandidateAsync(app, ct);
                var required = app.RequiredCorePermissions ?? app.GrantedCorePermissions ?? [];
                var optional = app.OptionalCorePermissions ?? [];
                var granted = app.GrantedCorePermissions ?? [];
                observed = new("known", candidate.Required, candidate.Optional, required, optional, granted,
                    candidate.Required.Except(granted, StringComparer.Ordinal).ToArray(),
                    !candidate.Required.ToHashSet(StringComparer.Ordinal).SetEquals(required)
                    || !candidate.Optional.ToHashSet(StringComparer.Ordinal).SetEquals(optional)
                    || app.RequiredCorePermissions is null || app.OptionalCorePermissions is null,
                    candidate.Roles.Except(app.ConfirmedRoles ?? [], StringComparer.Ordinal).ToArray(), null, clock.UtcNow);
            }
            catch (Exception ex) when (ex is AppManifestException or AppLifecycleException or IOException or UnauthorizedAccessException or System.Text.Json.JsonException)
            {
                observed = prior with { Status = prior.Status == "unknown" ? "unknown" : "stale", Error = ex.Message, CheckedAt = clock.UtcNow };
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
        foreach (var app in records) await ObservePermissionsAsync(app.Id, false, ct);
    }

    internal Task<AppPermissionPlan> CreatePermissionPlanAsync(string appId, CancellationToken ct)
        => WithAppLockAsync(appId, async () =>
        {
            var app = await apps.GetAppAsync(appId, ct) ?? throw new AppLifecycleException("app_not_found", "The app is no longer installed.");
            var candidate = await ReadPermissionCandidateAsync(app, ct, forceRead: true);
            return new AppPermissionPlan(app.Id, app.DisplayName, app.InstalledAt, app.PermissionRevision,
                candidate.Required, candidate.Optional, app.GrantedCorePermissions ?? [],
                candidate.Source, candidate.Runtime, candidate.Digest, PermissionIdentity(app),
                app.RequiredCorePermissions ?? app.GrantedCorePermissions ?? [], app.OptionalCorePermissions ?? []);
        }, ct);
}

internal sealed class AppPermissionObserver(CoreLifecycleService lifecycle, ILogger<AppPermissionObserver> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5));
        do
        {
            try { await lifecycle.ObserveAppPermissionsAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { return; }
            catch (Exception ex) { logger.LogWarning(ex, "Could not observe app permission declarations"); }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
