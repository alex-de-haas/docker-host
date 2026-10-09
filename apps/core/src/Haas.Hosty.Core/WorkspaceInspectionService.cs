namespace Haas.Hosty.Core;

internal sealed class WorkspaceInspectionService(DevelopmentWorkspaceService workspaces, AppRegistryStore apps,
    IClock clock, PublicationService? publications = null, UserDirectoryStore? users = null,
    UserConnectionService? connections = null, PrivateSourceService? privateSources = null,
    LocalCommandProcessRegistry? processes = null)
{
    public async Task<WorkspaceInventory> ListAsync(string userId, CancellationToken ct)
    {
        var installed = await apps.ListAppRecordsAsync(ct);
        var allowed = new List<DevelopmentWorkspace>();
        foreach (var tree in (await workspaces.ListAsync(null, true, ct)).Workspaces)
        {
            try { await RequireSourceAsync(tree, userId, installed, ct); allowed.Add(tree); }
            catch (AppLifecycleException) { /* Inaccessible source must not leak through metadata or counts. */ }
        }
        var result = new List<InspectedWorkspace>();
        foreach (var group in allowed.GroupBy(w => w.WorkspaceId).OrderBy(g => g.Key, StringComparer.Ordinal))
        {
            var first = group.First();
            var owner = first.Owner;
            var assistant = installed.FirstOrDefault(a => a.Id == owner.AppId && a.InstalledAt == owner.Installation);
            var destination = owner.IsExternal ? new WorkspaceDestination(null, null) : BrowserDestination(assistant, first.SessionPath);
            var projection = new InspectionOwner(owner.IsExternal ? "external" : "assistant",
                owner.External?.Label ?? assistant?.DisplayName ?? owner.AppId, owner.SessionId,
                owner.IsExternal ? null : owner.AppId, destination.Url, destination.Unavailable);
            var children = group.OrderBy(w => w.Repository, StringComparer.Ordinal).Select(w => Project(w, installed)).ToArray();
            var state = children.All(w => w.State == "released") ? "released"
                : children.Any(w => w.State != "active" || w.Observation?.State != "ok") ? "attention" : "active";
            result.Add(new(group.Key, state, projection, children));
        }
        return new(result.ToArray(), clock.UtcNow);
    }

    private async Task RequireSourceAsync(DevelopmentWorkspace tree, string userId, IReadOnlyList<AppRecord> installed, CancellationToken ct)
    {
        var repository = workspaces.LogicalRepositoryIdentity(tree.Repository);
        if (tree.SourceGrant is not null)
        {
            var effective = await workspaces.WorkspaceGrantAsync(tree, ct);
            if (tree.Owner.UserId != userId || effective is null || effective.OwnerId != userId || effective.Repository != repository)
                throw DevelopmentWorkspaceService.Error("forbidden", "This worktree's private source grant is no longer available.");
        }
        // A later private-source review applies even to worktrees originally prepared anonymously.
        foreach (var app in installed.Where(a => a.PrivateSources?.Git is not null &&
            (tree.Apps.Any(b => b.AppId == a.Id && b.Installation == a.InstalledAt) ||
             a.PrivateSources!.Git!.Repository == repository)))
        {
            var grant = app.PrivateSources!.Git!;
            if (tree.Owner.UserId != userId || grant.OwnerId != userId || grant.Repository != repository)
                throw DevelopmentWorkspaceService.Error("forbidden", "Private worktree access belongs to its source owner.");
            await (privateSources ?? throw PrivateSourceService.Denied()).ValidateAsync(new(Git: grant), ct);
        }
    }

    private async Task<DevelopmentWorkspace> RequireAsync(string workspaceId, string id, string userId, CancellationToken ct)
    {
        var tree = await workspaces.Read(id, null, ct);
        if (tree.WorkspaceId != workspaceId) throw DevelopmentWorkspaceService.Error("not_found", "Worktree is not in this workspace.");
        await RequireSourceAsync(tree, userId, await apps.ListAppRecordsAsync(ct), ct);
        return tree;
    }

    public async Task<InspectedWorktree> ReadAsync(string workspaceId, string id, string userId, CancellationToken ct)
    {
        var tree = await RequireAsync(workspaceId, id, userId, ct);
        // Observation reads local Git only. It never fetches, integrates, publishes or runs applications.
        if (tree.State == "active") tree = await workspaces.ObserveAsync(id, null, ct);
        var installed = await apps.ListAppRecordsAsync(ct);
        await RequireSourceAsync(tree, userId, installed, ct);
        var result = Project(tree, installed);
        var commits = new List<InspectionCommit>();
        var changes = new List<AppSourceFile>();
        string? detailError = null;
        if (tree.State == "active" && tree.Observation is { State: "ok", Head: { } head })
        {
            try
            {
                await workspaces.ValidateTree(tree, ct);
                var status = await DevelopmentWorkspaceService.Git(tree.Path,
                    ["diff", "--name-status", "-z", "--no-renames", tree.OriginalBase, "--"], ct);
                var names = status.StandardOutput.Split('\0', StringSplitOptions.RemoveEmptyEntries);
                for (var i = 0; i + 1 < names.Length; i += 2)
                    changes.Add(new(names[i + 1], names[i], names[i] == "A", false));
                foreach (var file in tree.Observation.Local?.Files.Where(f => f.Status == "??") ?? [])
                    if (!changes.Any(c => c.Path == file.Path)) changes.Add(file with { CanDiscard = false });
                var output = await DevelopmentWorkspaceService.Git(tree.Path,
                    ["log", "--no-show-signature", "--max-count=101", "--format=%H%x00%an%x00%aI%x00%s%x00", tree.OriginalBase + ".." + head, "--"], ct);
                var fields = output.StandardOutput.Split('\0');
                for (var i = 0; i + 3 < fields.Length; i += 4)
                    commits.Add(new(fields[i].Trim(), fields[i + 1], fields[i + 2], fields[i + 3]));
            }
            catch (AppLifecycleException ex) { detailError = ex.Message; }
        }
        return result with { Commits = commits.Take(100).ToArray(), CommitsTruncated = commits.Count > 100,
            SessionChanges = changes.OrderBy(c => c.Path, StringComparer.Ordinal).ToArray(),
            Consumers = Consumers(tree, installed), PullRequests = await PullRequestsAsync(tree, userId, ct), DetailError = detailError };
    }

    public async Task<AppSourceDiff> DiffAsync(string workspaceId, string id, string userId, WorkspaceDiffRequest input, CancellationToken ct)
    {
        await RequireAsync(workspaceId, id, userId, ct);
        var diff = await workspaces.DiffAsync(id, null, input, ct);
        await RequireAsync(workspaceId, id, userId, ct);
        return diff;
    }

    private static InspectedWorktree Project(DevelopmentWorkspace tree, IReadOnlyList<AppRecord> installed)
        => new(tree.Id, tree.WorkspaceId, tree.Repository, tree.Branch, tree.TargetBranch, tree.OriginalBase, tree.IntegrationBase,
            tree.Path, tree.State, tree.Apps.Select(binding =>
            {
                var app = installed.FirstOrDefault(a => a.Id == binding.AppId && a.InstalledAt == binding.Installation);
                return new InspectionApp(binding.AppId, app?.DisplayName ?? binding.AppId, binding.Subpath, app is not null);
            }).ToArray(), tree.Observation,
            tree.Operations.Select(o => new InspectionOperation(o.Id, o.Kind, o.State, o.Error)).ToArray(), tree.Leases,
            tree.PullRequests.Where(SafeUrl).Select(url => new InspectionPullRequest(url, null, null, "No verified provider observation.")).ToArray(), [], []);

    private InspectionConsumer[] Consumers(DevelopmentWorkspace tree, IReadOnlyList<AppRecord> installed)
    {
        var result = installed.Where(a => a.SourceState?.LocalOverridePath is { } path && IsUnder(tree.Path, path))
            .Select(a => new InspectionConsumer("source-selection", a.Id)).ToList();
        foreach (var entry in processes?.Snapshot() ?? [])
        {
            try
            {
                if (IsUnder(tree.Path, entry.Value.WorkingDirectory) && !entry.Value.Process.HasExited)
                    result.Add(new("local-service", entry.Key));
            }
            catch (InvalidOperationException) { /* A process may exit between observations. */ }
        }
        return result.ToArray();
    }
    private static bool IsUnder(string root, string path)
    {
        var relative = Path.GetRelativePath(root, path);
        return !Path.IsPathRooted(relative) && relative != ".." && !relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal);
    }
    private static bool SafeUrl(string url) => Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == "https" && uri.UserInfo.Length == 0;

    private async Task<InspectionPullRequest[]> PullRequestsAsync(DevelopmentWorkspace tree, string userId, CancellationToken ct)
    {
        var result = tree.PullRequests.Where(SafeUrl).Distinct(StringComparer.Ordinal).ToDictionary(url => url,
            url => new InspectionPullRequest(url, null, null, "No verified provider observation."), StringComparer.Ordinal);
        if (publications is null || users is null || connections is null) return result.Values.ToArray();
        var record = (await publications.ListAsync(null, ct)).Publications.FirstOrDefault(p => p.WorkspaceId == tree.Id && p.Owner.SameIdentity(tree.Owner));
        if (record is null || record.Owner.UserId != userId) return result.Values.ToArray();
        foreach (var previous in record.History.Where(p => SafeUrl(p.Url)))
            result[previous.Url] = new(previous.Url, previous.Head, null, "Historical reference; no current provider observation.");
        if (record.Url is { } recordedUrl && SafeUrl(recordedUrl))
            result[recordedUrl] = new(recordedUrl, record.PublishedHead, null, "No authorized provider observation.");
        var connection = (await users.ReadAsync(ct)).ProviderConnections?.FirstOrDefault(c => c.Id == record.ConnectionId && c.UserId == userId
            && c.Provider == record.Provider && c.Status == "connected" && (c.ExpiresAt is null || c.ExpiresAt > clock.UtcNow));
        if (connection is null || !connections.Providers.Contains(record.Provider)) return result.Values.ToArray();
        var provider = connections.Providers.Resolve(record.Provider).Publication;
        if (provider is null) return result.Values.ToArray();
        try { if (provider.NormalizeRepository(tree.Repository) != record.Repository) return result.Values.ToArray(); }
        catch (Exception ex) when (ex is PublicationException or UserConnectionException or AppLifecycleException) { return result.Values.ToArray(); }
        foreach (var previous in record.History.Where(p => SafeUrl(p.Url)))
            result[previous.Url] = new(previous.Url, previous.Head, null, "Historical reference; no current provider observation.");
        if (record.Url is { } url && SafeUrl(url))
        {
            var observation = record.Observation;
            var matched = observation?.Head is { } head && head == record.PublishedHead;
            // Review summaries and check states suffice; private review comment bodies are not projected.
            result[url] = new(url, record.PublishedHead, matched ? observation! with { Reviews = null } : null,
                matched ? null : "Provider observation does not match the published head.");
        }
        return result.Values.ToArray();
    }

    internal static WorkspaceDestination BrowserDestination(AppRecord? app, string? path)
    {
        if (app is null) return new(null, "The application installation was removed or replaced.");
        var endpoint = app.Endpoints.FirstOrDefault(e => e.Key == app.Ui?.EndpointKey)
            ?? app.Endpoints.FirstOrDefault(e => e.Public && e.Protocol is "http" or "https");
        var origin = endpoint is null ? null : LocalBrowserOrigins.App(app, endpoint);
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var basis) || basis.Scheme is not ("http" or "https") || basis.UserInfo.Length != 0)
            return new(null, "The application browser origin is unavailable.");
        if (path is null || !path.StartsWith('/') || path.StartsWith("//", StringComparison.Ordinal) || path.Contains('\\') || path.Any(char.IsControl)
            || !Uri.TryCreate(basis, path, out var uri) || uri.Scheme != basis.Scheme || uri.Host != basis.Host || uri.Port != basis.Port || uri.UserInfo.Length != 0)
            return new(null, "The destination must stay on the application's browser origin.");
        return new(uri.AbsoluteUri, null);
    }
    public async Task<WorkspaceDestination> DestinationAsync(DevelopmentWorkspace tree, CancellationToken ct)
        => BrowserDestination(await apps.GetAppAsync("hosty.workspaces", ct), "/?workspace=" + tree.WorkspaceId + "&worktree=" + tree.Id);
}
