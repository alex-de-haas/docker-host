using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Haas.Hosty.Launch;
using Haas.Hosty.Releases;

namespace Haas.Hosty.Core;

internal sealed record AppUpdateSourceBinding(string? ManifestUrl, string? FeedsUrl, string? FeedId);
internal sealed record AppSourceMigration(string MigrationId, string AppId, AppUpdateSourceBinding From, AppUpdateSourceBinding To);
internal sealed record AppSourceMigrations(string SchemaVersion, IReadOnlyList<AppSourceMigration> Migrations);
internal sealed record AppUpdateSourcePlanRequest(string? FeedsUrl = null, string? FeedId = null, string? ExpectedRevision = null, string? MigrationId = null, string? ManifestUrl = null);
internal sealed record AppUpdateSourcePlan(string AppId, AppUpdateSourceBinding From, AppUpdateSourceBinding To,
    string ExpectedRevision, string FeedDigest, string ManifestDigest, string TargetVersion, string? TargetSourceCommit,
    string Ordering, string Impact, string? MigrationId, DateTimeOffset CreatedAt, string PlanDigest);
internal sealed record AppUpdateSourceApplyRequest(string PlanDigest, string RequestId);
internal sealed record AppUpdateSourceOperation(string RequestId, string AppId, string PlanDigest, string Status,
    AppUpdateSourceBinding Previous, AppUpdateSourceBinding Selected, string? Revision = null, string? Error = null);
internal sealed record AppUpdateSourceSuggestion(AppSourceMigration Migration, string Revision);
internal sealed record AppUpdateSourceSuggestions(IReadOnlyList<AppUpdateSourceSuggestion> Suggestions);
internal sealed record AppUpdateSourceBatchItem(string AppId, string PlanDigest);
internal sealed record AppUpdateSourceBatchRequest(string RequestId, IReadOnlyList<AppUpdateSourceBatchItem> Items);
internal sealed record AppUpdateSourceBatchResult(string AppId, AppUpdateSourceOperation? Operation, string? ErrorCode = null, string? Error = null);
internal sealed record AppUpdateSourceBatchResponse(string RequestId, IReadOnlyList<AppUpdateSourceBatchResult> Results);

internal sealed partial class CoreLifecycleService
{
    private static AppUpdateSourceBinding UpdateBinding(AppRecord app) => new(app.ManifestUrl, app.FeedsUrl, app.FollowedFeedId);
    private static bool BindingMatches(AppRecord app, AppUpdateSourceBinding from)
        => from.FeedsUrl is not null ? app.FeedsUrl == from.FeedsUrl && app.FollowedFeedId == from.FeedId
            : app.FeedsUrl is null && app.FollowedFeedId is null && app.ManifestUrl == from.ManifestUrl;

    private static AppSourceMigrations DistributionSourceMigrations()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Hosty.AppSourceMigrations.json")
            ?? throw new InvalidOperationException("Distribution source-migration data is missing.");
        var declarations = JsonSerializer.Deserialize(stream, CoreJsonSerializerContext.Default.AppSourceMigrations);
        if (declarations?.SchemaVersion != "app-source-migrations.0.1") throw new InvalidOperationException("Unsupported source-migration declarations.");
        return declarations;
    }

    private async Task<string> UpdateSourceRevisionAsync(AppRecord app, CancellationToken ct)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(
            await UpdateBaseAsync(app, ct) + "\n" + app.UpdateSourceRevision + "\n" + app.DevModeId)));

    private async Task<bool> SourceMigrationExcludedAsync(AppRecord app, CancellationToken ct)
    {
        if (app.PrivateSources is not null || app.SourceState?.LocalOverridePath is not null
            || string.IsNullOrWhiteSpace(app.ManifestUrl)
            || app.RuntimeProfiles?.Any(p => p.Key == app.SelectedRuntime && p.Development) == true)
            return true;

        // InstallManifestPath is historical once an explicit URL becomes the update source.
        // Return keeps its journal ID for recovery; only an active or mismatched journal blocks
        // a new source review. An unreadable journal still fails closed through AppDevStore.
        var development = await AppDevStore.ReadAsync(paths, app, ct);
        return development is not null && (development.Active || development.Installation != app.InstalledAt);
    }

    public async Task<AppUpdateSourceSuggestions> GetUpdateSourceSuggestionsAsync(CancellationToken ct = default)
    {
        var declarations = DistributionSourceMigrations();
        var suggestions = new List<AppUpdateSourceSuggestion>();
        foreach (var app in await apps.ListAppRecordsAsync(ct))
        {
            var matches = declarations.Migrations.Where(m => m.AppId == app.Id && BindingMatches(app, m.From)).ToArray();
            if (matches.Length == 0) continue;
            try
            {
                if (await SourceMigrationExcludedAsync(app, ct)) continue;
            }
            catch (AppLifecycleException error) when (error.Code == "dev_state_unavailable")
            {
                logger.LogWarning(error, "Skipping source migration suggestions for {AppId}: development history is unavailable.", app.Id);
                continue;
            }
            // An authored explicit commit pin is different from the run lock of a branch-based install.
            var installed = await LoadSelectionForAppAsync(app, ct);
            if (installed.Manifest.Source?.Commit is not null || installed.Manifest.Source?.Tag is not null) continue;
            foreach (var migration in matches)
                suggestions.Add(new(migration, await UpdateSourceRevisionAsync(app, ct)));
        }
        return new(suggestions);
    }

    public Task<AppUpdateSourcePlan> PlanUpdateSourceAsync(string appId, AppUpdateSourcePlanRequest request, CancellationToken ct = default)
        => WithAppLockAsync(appId, async () =>
        {
            var app = await RequireAppAsync(appId, ct);
            if (await SourceMigrationExcludedAsync(app, ct)) throw new AppLifecycleException("update_source_protected", "This installation uses a private, local or active development source. Return or review that source through its supported source controls first.");
            var revision = await UpdateSourceRevisionAsync(app, ct);
            if (request.ExpectedRevision is not null && request.ExpectedRevision != revision) throw SourcePlanStale();
            if (request.MigrationId is not null)
            {
                var mapping = DistributionSourceMigrations().Migrations.SingleOrDefault(m => m.MigrationId == request.MigrationId && m.AppId == appId);
                if (mapping is null || !BindingMatches(app, mapping.From) || mapping.To.FeedsUrl != request.FeedsUrl || mapping.To.FeedId != request.FeedId)
                    throw new AppLifecycleException("update_source_mapping_mismatch", "The proposed mapping does not match this exact current and destination binding.");
                var installed = await LoadSelectionForAppAsync(app, ct);
                if (installed.Manifest.Source?.Commit is not null || installed.Manifest.Source?.Tag is not null)
                    throw new AppLifecycleException("update_source_pinned", "An explicit source pin is excluded from suggested migration. Select a destination explicitly to review a source switch.");
            }
            var (binding, feedDigest, selection) = await ValidateUpdateSourceDestinationAsync(app, request.FeedsUrl, request.FeedId, request.ManifestUrl, request.MigrationId is not null, ct);
            var ordering = Version.TryParse(app.Version, out var current) && Version.TryParse(selection.Manifest.Version, out var target)
                ? target < current ? "installed-ahead" : target > current ? "newer-version" : "same-version-order-unknown"
                : "unknown";
            var plan = new AppUpdateSourcePlan(appId, UpdateBinding(app), binding,
                revision, feedDigest, selection.ManifestDigest, selection.Manifest.Version!, selection.Manifest.Source?.Commit,
                ordering, "Changes only the source of future updates. Installed binaries, source locks, runtime, permissions, settings and data remain in place. A separate update review is required.",
                request.MigrationId, clock.UtcNow, "");
            plan = plan with { PlanDigest = HashPlanSeed(plan) };
            CoreLaunchFiles.Write(SourcePlanPath(plan.PlanDigest), plan, CoreJsonSerializerContext.Default.AppUpdateSourcePlan);
            return plan;
        }, ct);

    private async Task<(AppUpdateSourceBinding Binding, string FeedDigest, RuntimeAppManifestSelection Selection)> ValidateUpdateSourceDestinationAsync(
        AppRecord app, string? feedsUrl, string? feedId, string? manifestUrl, bool requireReadyRelease, CancellationToken ct)
    {
        if (manifestUrl is not null && (feedsUrl is not null || feedId is not null) || manifestUrl is null && (feedsUrl is null || feedId is null))
            throw new AppLifecycleException("update_source_destination_invalid", "Choose either an explicit HTTPS manifest or a feed index and feed ID.");
        AppFeedResolution? resolution = null;
        if (manifestUrl is null)
        {
            resolution = await RequireFeedService().ResolveAsync(feedsUrl!, feedId!, ct);
            RequireFeedAppMatch(app, resolution.AppId);
            manifestUrl = resolution.Feed.ManifestRef;
        }
        else PlatformReleaseReader.ValidateReference(manifestUrl, allowLocal: false);
        var selection = await manifests.LoadAsync(manifestUrl, app.SelectedRuntime, ct, validateAllProfiles: true, requirePanelIcons: true);
        if (selection.Manifest.Id != app.Id) throw new AppLifecycleException("update_source_identity_mismatch", "The destination manifest belongs to another app.");
        if (requireReadyRelease && selection.Manifest.SchemaVersion != "app.0.2") throw new AppLifecycleException("update_source_release_required", "Source migration requires a ready release using app.0.2.");
        var probes = await ProbeServiceArtifactsAsync(app, selection, ct);
        if (probes.Any(p => p.CandidateDigest is null)) throw new AppLifecycleException("update_source_not_ready", "A destination image is unavailable, invalid or incompatible with this host.");
        if (selection.Manifest.SchemaVersion == "app.0.2" && selection.Services.Any(s => s.Runtime.Type == "localCommand") && !selection.RuntimeProfile.Development)
        {
            var pin = selection.Manifest.Source?.Commit;
            if (!ArtifactIdentity.IsCommit(pin)) throw new AppLifecycleException("update_source_not_ready", "A destination source commit is missing.");
            await sources.PrefetchUpdateAsync(app, selection.Manifest.Source!.Repository!, pin!, null, ct);
        }
        return (new(manifestUrl, resolution?.FeedsUrl, resolution?.Feed.Id), resolution?.DocumentDigest ?? "", selection);
    }

    public async Task<AppUpdateSourceOperation> ApplyUpdateSourceAsync(string appId, AppUpdateSourceApplyRequest request, CancellationToken ct = default)
    {
        var result = await WithAppLockAsync(appId, async () =>
        {
            var operationPath = SourceOperationPath(request.RequestId);
            using var operationLease = await AcquireSourceRequestLockAsync("operation:" + request.RequestId, ct);
            var retained = CoreLaunchFiles.Read(operationPath, CoreJsonSerializerContext.Default.AppUpdateSourceOperation);
            if (retained is not null)
            {
                if (retained.AppId != appId || retained.PlanDigest != request.PlanDigest) throw new AppLifecycleException("update_source_request_conflict", "This request ID already names a different reviewed source switch.");
                if (retained.Status == "completed") return retained;
            }
            var plan = CoreLaunchFiles.Read(SourcePlanPath(request.PlanDigest), CoreJsonSerializerContext.Default.AppUpdateSourcePlan)
                ?? throw new AppLifecycleException("update_source_plan_missing", "The reviewed source plan was not found.");
            if (plan.AppId != appId) throw SourcePlanStale();
            var app = await RequireAppAsync(appId, ct);
            // Recover a crash after the atomic registry write and before recording completion.
            if (retained is not null && app.UpdateSourceRevision == request.RequestId && UpdateBinding(app) == plan.To)
            {
                await ClearUpdateAvailability(appId);
                var recovered = retained with { Status = "completed", Revision = await UpdateSourceRevisionAsync(app, ct) };
                CoreLaunchFiles.Write(operationPath, recovered, CoreJsonSerializerContext.Default.AppUpdateSourceOperation); return recovered;
            }
            if (clock.UtcNow - plan.CreatedAt > TimeSpan.FromHours(1) || await SourceMigrationExcludedAsync(app, ct)
                || await UpdateSourceRevisionAsync(app, ct) != plan.ExpectedRevision) throw SourcePlanStale();
            var (binding, feedDigest, selection) = await ValidateUpdateSourceDestinationAsync(app, plan.To.FeedsUrl, plan.To.FeedId, plan.To.FeedsUrl is null ? plan.To.ManifestUrl : null, plan.MigrationId is not null, ct);
            if (feedDigest != plan.FeedDigest || selection.ManifestDigest != plan.ManifestDigest || binding != plan.To) throw SourcePlanStale();
            var operation = new AppUpdateSourceOperation(request.RequestId, appId, plan.PlanDigest, "prepared", plan.From, plan.To);
            CoreLaunchFiles.Write(operationPath, operation, CoreJsonSerializerContext.Default.AppUpdateSourceOperation);
            var updated = await apps.UpdateAppAsync(appId, current => current with {
                FeedsUrl = plan.To.FeedsUrl, FollowedFeedId = plan.To.FeedId, ManifestUrl = plan.To.ManifestUrl,
                UpdateSourceRevision = request.RequestId,
            }, ct);
            await ClearUpdateAvailability(appId);
            operation = operation with { Status = "completed", Revision = await UpdateSourceRevisionAsync(updated.App, ct) };
            CoreLaunchFiles.Write(operationPath, operation, CoreJsonSerializerContext.Default.AppUpdateSourceOperation);
            return operation;
        }, ct);
        // The binding operation is already durable. A later unavailable registry is a new check
        // failure, never a reason to undo the operator's source selection or replay its mutation.
        try { await GetUpdateStatusAsync(appId, refresh: true, cancellationToken: ct); }
        catch (Exception error) when (error is not OperationCanceledException)
        { logger.LogWarning(error, "Could not refresh updates after source selection for {AppId}.", appId); }
        return result;
    }

    public AppUpdateSourceOperation GetUpdateSourceOperation(string appId, string requestId)
    {
        var operation = CoreLaunchFiles.Read(SourceOperationPath(requestId), CoreJsonSerializerContext.Default.AppUpdateSourceOperation);
        return operation?.AppId == appId ? operation : throw new AppLifecycleException("update_source_operation_missing", "No retained source operation exists for this app and request ID.");
    }

    public async Task<AppUpdateSourceBatchResponse> ApplyUpdateSourceBatchAsync(AppUpdateSourceBatchRequest request, CancellationToken ct = default)
    {
        if (!Guid.TryParseExact(request.RequestId, "N", out _) || request.Items is not { Count: > 0 and <= 100 }
            || request.Items.Select(i => i.AppId).Distinct(StringComparer.Ordinal).Count() != request.Items.Count)
            throw new AppLifecycleException("update_source_batch_invalid", "A batch needs a UUID and one to 100 distinct reviewed app switches.");
        using var batchLease = await AcquireSourceRequestLockAsync("batch:" + request.RequestId, ct);
        var path = Path.Combine(paths.CoreRoot, "update-source", "batches", request.RequestId + ".json");
        var previous = CoreLaunchFiles.Read(path, CoreJsonSerializerContext.Default.AppUpdateSourceBatchRequest);
        if (previous is not null && HashPlanSeed(previous) != HashPlanSeed(request)) throw new AppLifecycleException("update_source_request_conflict", "The retained batch names different source switches.");
        CoreLaunchFiles.Write(path, request, CoreJsonSerializerContext.Default.AppUpdateSourceBatchRequest);
        var results = new List<AppUpdateSourceBatchResult>();
        foreach (var item in request.Items)
        {
            var id = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(request.RequestId + "/" + item.AppId)))[..32];
            try { results.Add(new(item.AppId, await ApplyUpdateSourceAsync(item.AppId, new(item.PlanDigest, id), ct))); }
            catch (AppLifecycleException error) { results.Add(new(item.AppId, null, error.Code, error.Message)); }
        }
        return new(request.RequestId, results);
    }

    private async Task<IDisposable> AcquireSourceRequestLockAsync(string key, CancellationToken ct)
    {
        var gate = apps.OperationLock("update-source-request:" + key);
        await gate.WaitAsync(ct);
        return new SourceRequestLease(gate);
    }
    private sealed class SourceRequestLease(SemaphoreSlim gate) : IDisposable
    {
        public void Dispose() => gate.Release();
    }

    internal AppUpdateSourcePlan ReadUpdateSourcePlan(string appId, string digest)
    {
        var plan = CoreLaunchFiles.Read(SourcePlanPath(digest), CoreJsonSerializerContext.Default.AppUpdateSourcePlan)
            ?? throw new AppLifecycleException("update_source_plan_missing", "Review the destination source first.");
        if (plan.AppId != appId) throw new AppLifecycleException("update_source_plan_mismatch", "The plan belongs to another application.");
        return plan;
    }

    private string SourcePlanPath(string digest)
        => ArtifactIdentity.IsHash(digest) ? Path.Combine(paths.CoreRoot, "update-source", "plans", digest + ".json")
            : throw new AppLifecycleException("update_source_plan_invalid", "The plan digest must be a SHA256.");
    private string SourceOperationPath(string id)
        => Guid.TryParseExact(id, "N", out _) ? Path.Combine(paths.CoreRoot, "update-source", "operations", id + ".json")
            : throw new AppLifecycleException("update_source_request_invalid", "The source switch request ID must be a UUID without hyphens.");
    private static AppLifecycleException SourcePlanStale() => new("update_source_plan_stale", "The installation, source binding or destination release changed. Review a fresh source-switch plan.");
}
