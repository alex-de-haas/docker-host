namespace Haas.Hosty.Core;

internal sealed record AppPermissionHolder(string Id, string DisplayName, string? Icon, string? IconUrl);
internal sealed record AppPermissionOverviewEntry(
    string Id, string Kind, string Description, IReadOnlyList<AppPermissionHolder> Apps);
internal sealed record AppPermissionOverview(IReadOnlyList<AppPermissionOverviewEntry> Entries)
{
    public static AppPermissionOverview From(IReadOnlyList<AppRecord> apps)
    {
        var holders = apps.ToDictionary(app => app.Id, app =>
        {
            var summary = AppSummary.From(app);
            return new AppPermissionHolder(app.Id, app.DisplayName, summary.Icon, summary.IconUrl);
        }, StringComparer.Ordinal);
        AppPermissionOverviewEntry Entry(string id, string kind, string description, Func<AppRecord, bool> has)
            => new(id, kind, description, apps.Where(has).Select(app => holders[app.Id])
                .OrderBy(app => app.DisplayName, StringComparer.OrdinalIgnoreCase).ThenBy(app => app.Id, StringComparer.Ordinal).ToArray());

        return new([
            .. CoreAppPermissions.Known.Order(StringComparer.Ordinal).Select(permission =>
                Entry(permission, "permission", CoreAppPermissions.Describe(permission),
                    app => app.GrantedCorePermissions?.Contains(permission, StringComparer.Ordinal) == true)),
            .. PlatformCapabilities.ConsentRoles.Order(StringComparer.Ordinal).Select(role =>
                Entry(role, "role", PlatformCapabilities.DescribeRole(role),
                    app => app.ConfirmedRoles?.Contains(role, StringComparer.Ordinal) == true)),
            Entry(PlatformCapabilities.OtlpCollector, "provisioning",
                "Legacy collector provisioning and startup ordering; this declaration is not a confirmed provider role or a Core permission",
                app => app.Provides?.Contains(PlatformCapabilities.OtlpCollector, StringComparer.Ordinal) == true),
        ]);
    }
}
