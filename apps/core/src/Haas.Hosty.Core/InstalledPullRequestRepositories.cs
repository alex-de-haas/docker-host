namespace Haas.Hosty.Core;

// Discovery reads installed records only. It never fetches Git, resolves a branch or creates a workspace.
internal sealed class InstalledPullRequestRepositories(AppRegistryStore apps, UserDirectoryStore users,
    UserConnectionService connections, IClock clock)
{
    internal sealed record Binding(string Key, string Repository, string ConnectionId, string Authority,
        PullRequestApp[] Apps, IPullRequestProvider Provider);
    internal sealed record Inventory(Binding[] Bindings, PullRequestCoverage[] Coverage);

    public async Task RequireActorAsync(PullRequestActor actor, CancellationToken ct)
    {
        var state = await users.ReadAsync(ct);
        var user = state.Users.FirstOrDefault(u => u.Id == actor.UserId && !u.Disabled && AppAccessPolicy.IsAdmin(u));
        if (user is null) throw new PullRequestException("pr_forbidden", "PR observation requires an active administrator.", 403);
        if (actor.AppId is { } appId)
        {
            var app = await apps.GetAppAsync(appId, ct);
            if (app is null || app.InstalledAt != actor.Installation || !AppAccessPolicy.CanAccessApp(state, user, appId, app.System) ||
                !AppManagementAuthorization.HasPermission(app, CoreAppPermissions.Sources))
                throw new PullRequestException("pr_forbidden", "The calling installation no longer has source access.", 403);
        }
    }

    public async Task<Inventory> DiscoverAsync(PullRequestActor actor, CancellationToken ct)
    {
        await RequireActorAsync(actor, ct);
        var installed = await apps.ListAppRecordsAsync(ct);
        var state = await users.ReadAsync(ct);
        var coverage = new List<PullRequestCoverage>();
        var groups = new Dictionary<string, List<AppRecord>>(StringComparer.OrdinalIgnoreCase);
        var providers = new Dictionary<string, (string Name, IPullRequestProvider Provider, string ProviderId)>(StringComparer.OrdinalIgnoreCase);
        foreach (var app in installed.OrderBy(a => a.Id, StringComparer.Ordinal))
        {
            PullRequestApp[] projected = [new(app.Id, app.DisplayName)];
            if (app.SourceState?.Repository is not { Length: > 0 } repository)
            { coverage.Add(new(projected, "source_missing", "No source repository is declared for this installed app.")); continue; }
            try
            {
                var source = connections.Providers.ForUrl(repository);
                if (source.Publication is not IPullRequestProvider provider) throw new PullRequestException("pr_provider_unsupported", "Repository PR reads are not supported by this provider.");
                var normalized = source.NormalizeRepository(repository);
                var name = source.Publication.NormalizeRepository(normalized);
                if (app.PrivateSources?.Git is { } grant &&
                    (grant.OwnerId != actor.UserId || !string.Equals(grant.Repository, normalized, StringComparison.OrdinalIgnoreCase)))
                { coverage.Add(new(projected, "source_access_required", "This app's reviewed source binding does not authorize the acting user.")); continue; }
                var key = source.Descriptor.Id + ":" + normalized.ToLowerInvariant();
                if (!groups.TryGetValue(key, out var group)) groups[key] = group = [];
                group.Add(app); providers[key] = (name, provider, source.Descriptor.Id);
            }
            catch (Exception ex) when (ex is AppLifecycleException or PublicationException or UserConnectionException or PullRequestException)
            { coverage.Add(new(projected, "source_unsupported", "The installed source does not support repository PR reads.")); }
        }
        var result = new List<Binding>();
        foreach (var (key, group) in groups.OrderBy(g => g.Key, StringComparer.Ordinal))
        {
            var projected = group.Select(a => new PullRequestApp(a.Id, a.DisplayName)).ToArray();
            var source = providers[key];
            var grants = group.Select(a => a.PrivateSources?.Git?.ConnectionId).OfType<string>().Distinct(StringComparer.Ordinal).ToArray();
            var candidates = (state.ProviderConnections ?? []).Where(c => c.UserId == actor.UserId && c.Provider == source.ProviderId &&
                c.Status == "connected" && (c.Method == "oauth" || c.ExpiresAt is null || c.ExpiresAt > clock.UtcNow) &&
                (grants.Length == 0 || grants.Contains(c.Id, StringComparer.Ordinal))).ToArray();
            if (grants.Length > 1 || candidates.Length > 1)
            { coverage.Add(new(projected, "connection_selection_required", "Select one reviewed source connection for these installed apps.")); continue; }
            if (candidates.Length == 0)
            { coverage.Add(new(projected, "connection_required", "Connect an account with repository PR access in the existing source connection settings.")); continue; }
            var c = candidates[0];
            // Source/installation/account changes invalidate protected cache before it can be served.
            var authority = DevelopmentWorkspaceService.Hash(string.Join('\n', group.Select(a => a.Id + ":" + a.InstalledAt.ToString("O") + ":" + a.PrivateSources?.Git?.ConnectionId)) +
                "\n" + c.Id + ":" + c.AccountId);
            result.Add(new(key, source.Name, c.Id, authority, projected, source.Provider));
        }
        return new(result.ToArray(), coverage.ToArray());
    }
}
