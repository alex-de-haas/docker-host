namespace Haas.Hosty.Core;

internal sealed partial class CoreLifecycleService
{
    // Exclude transient health/UpdatedAt changes, but bind consent to this installation and contract.
    private static string RemovalIdentity(AppRecord app)
        => PermissionIdentity(app) + "\n" + app.Version + "\n" + app.DisplayName;

    internal Task<AppRemovalPlan> CreateRemovalPlanAsync(string appId, AppRemoveRequest options, CancellationToken ct)
        => WithAppLockAsync(appId, async () =>
        {
            var app = await RequireAppAsync(appId, ct);
            return new AppRemovalPlan(app.Id, app.DisplayName, app.Version, options,
                await GetRemovalImpactAsync(app.Id, ct)) { Identity = RemovalIdentity(app) };
        }, ct);

    internal Task<AppLifecycleResponse> ApplyRemovalAsync(AppRemovalPlan plan, CancellationToken ct)
        => WithAppLockAsync(plan.AppId, async () =>
        {
            var app = await apps.GetAppAsync(plan.AppId, ct);
            // Direct operator removal also supports retained-data cleanup of absent apps. A reviewed
            // app request must never inherit that authority or delete a replacement installation.
            if (app is null || RemovalIdentity(app) != plan.Identity)
                throw new AppLifecycleException("removal_plan_stale", "The app changed since removal was prepared. Review a new removal request.");
            return await RemoveCoreAsync(plan.AppId, plan.Options, ct);
        }, ct);
}
