using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

internal sealed record UiNavigationTarget(string AppId, string InstallationId, string EntryKey);
internal sealed record UiNavigationEntry(string Key, string Label, string? Icon, string? Endpoint,
    string? Origin, string? Route, bool Available, string State, string? StandaloneHref);
internal sealed record UiNavigationCatalog(string AppId, string InstallationId, string Revision,
    IReadOnlyList<UiNavigationEntry> Entries);
internal sealed record UiResolvedNavigation(UiNavigationTarget Target, UiFrameSurface? Surface,
    bool Available, string State, string? StandaloneHref);

internal sealed partial class UiPanelService
{
    private static string NavigationKey(string? endpoint, string route)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes($"{endpoint?.Length ?? 0}:{endpoint}{route}")));

    private UiNavigationCatalog Navigation(AppRecord app)
    {
        var installation = PanelIdentity.Installation(app);
        var entries = AppSummary.From(app).Navigation
            .DistinctBy(item => (item.Endpoint, item.Path))
            .Select(item =>
            {
                var valid = item.Endpoint is not null && UiSurfaceRoutes.Valid(item.Path);
                var state = valid ? SurfaceState(app, item.Service, item.EmbeddedUrl) : "destination_invalid";
                var icon = item.IconUrl is null ? null : new Uri(new Uri(coreOrigins.Effective), item.IconUrl).AbsoluteUri;
                return new UiNavigationEntry(NavigationKey(item.Endpoint, item.Path), item.Label, icon,
                    item.Endpoint, valid ? Origin(item.EmbeddedUrl) : null, valid ? item.Path : null, valid && Available(app, item.Service, item.EmbeddedUrl), state,
                    valid ? BuildOpenUrl(coreOrigins.Effective, app.Id, installation, item.Endpoint!, item.Path) : null);
            }).ToArray();
        // Length framing prevents metadata separators from creating ambiguous revisions.
        var revisionInput = string.Concat(entries.SelectMany(e => new[] { e.Key, e.Label, e.Icon, e.Origin, e.State, e.Available ? "1" : "0", e.StandaloneHref })
            .Select(value => $"{value?.Length ?? 0}:{value}"));
        return new(app.Id, installation,
            Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(revisionInput))), entries);
    }

    public async Task<UiNavigationCatalog> NavigationAsync(AppRecord caller, string userId, CancellationToken ct)
    {
        var (_, current) = await identity.RequireAccessibleUserAsync(caller.Id, userId, ct);
        return Navigation(current);
    }

    public async Task<UiResolvedNavigation> ResolveNavigationAsync(AppRecord caller, string userId,
        UiNavigationTarget target, CancellationToken ct)
    {
        if (target is not { AppId.Length: > 0 and <= 256, InstallationId.Length: > 0 and <= 256, EntryKey.Length: 64 })
            throw new AppIdentityException("destination_invalid", "Select a declared navigation entry.");
        if (target.AppId != caller.Id) RequireHost(caller);
        var (_, app) = await identity.RequireAccessibleUserAsync(target.AppId, userId, ct);
        if (PanelIdentity.Installation(app) != target.InstallationId)
            throw new AppIdentityException("installation_changed", "The selected app installation changed.");
        var entry = Navigation(app).Entries.SingleOrDefault(e => e.Key == target.EntryKey)
            ?? throw new AppIdentityException("destination_changed", "The selected navigation entry is no longer declared.");
        if (entry.Endpoint is null || entry.Route is null)
            throw new AppIdentityException("destination_invalid", "The navigation destination is invalid.");
        var declaration = AppSummary.From(app).Navigation.First(e => NavigationKey(e.Endpoint, e.Path) == entry.Key);
        var origin = Origin(declaration.EmbeddedUrl);
        return new(target, origin is null ? null : new(app.Id, target.InstallationId, entry.Endpoint,
            entry.Route, origin, UiFramePolicy.From(app)), entry.Available, entry.State, entry.StandaloneHref);
    }
}
