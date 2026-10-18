namespace Haas.Hosty.Core;

internal sealed partial class CoreLifecycleService
{
    private static string RemovalIdentity(AppRecord app)
        => PermissionIdentity(app) + "\n" + app.Version + "\n" + app.DisplayName;

    internal Task<AppRemovalPlan> CreateRemovalPlanAsync(string appId, AppRemoveRequest options, CancellationToken ct)
        => WithAppLockAsync(appId, async () =>
        {
            var app = await RequireAppAsync(appId, ct);
            return new AppRemovalPlan(app.Id, app.DisplayName, app.Version, options,
                await GetRemovalImpactAsync(app.Id, ct))
            {
                Identity = RemovalIdentity(app),
                SourceReview = await new AppSourceSafety(paths, apps).ReviewAsync(appId, options.DeleteSource, ct),
            };
        }, ct);

    internal Task<AppLifecycleResponse> ApplyRemovalAsync(AppRemovalPlan plan, CancellationToken ct)
        => WithAppLockAsync(plan.AppId, async () =>
        {
            var app = await apps.GetAppAsync(plan.AppId, ct);
            // Replayed reviews never acquire authority over a replacement installation.
            if (app is null || RemovalIdentity(app) != plan.Identity)
                throw new AppLifecycleException("removal_plan_stale", "The app changed since removal was prepared. Review a new removal request.");
            return await RemoveWithSourceProtectionAsync(plan.AppId, plan.Options, plan.SourceReview, ct);
        }, ct);

    private async Task<AppLifecycleResponse> RemoveWithSourceProtectionAsync(string appId, AppRemoveRequest options,
        AppSourceReview? reviewed, CancellationToken ct)
    {
        var safety = new AppSourceSafety(paths, apps);
        using var activity = await safety.LockAsync(appId, ct);
        {
            if (options.DeleteSource && options.IgnoreRuntimeErrors)
                throw new AppLifecycleException("removal_source_runtime_required", "Source deletion requires verified runtime removal. Retry without Ignore runtime errors.");
            await safety.RequireIdleAsync(appId, ct);
            var current = await safety.ReviewAsync(appId, options.DeleteSource, ct);
            if (reviewed is not null && current.Fingerprint != reviewed.Fingerprint)
                throw new AppLifecycleException("removal_source_changed", "Source or workspace state changed after review. Prepare a new removal request; no files were deleted.");
            if (options.DeleteSource && current.Unknown)
                throw new AppLifecycleException("removal_source_unknown", "Source contents cannot be verified. Keep source, or resolve the reported source state before reviewing deletion again.");
            return await RemoveCoreAsync(appId, options, ct, current);
        }
    }
}
