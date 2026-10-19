using System.Text.Json;

namespace Haas.Hosty.Core;

// Read-only observations are separate from publication commands and completion/cleanup policy.
internal sealed record ExternalPublicationSnapshot(string WorkspaceId, WorkspaceOwner Owner,
    string Repository, string ConnectionId, InspectionPullRequest[] PullRequests);

internal sealed partial class PublicationService
{
    private readonly SemaphoreSlim externalObservationGate = new(1, 1);
    private string ExternalPath(string id) => Path.Combine(Root, "external", id + ".json");

    private async Task<(ISourceProvider Source, string Repository, UserProviderConnection Connection)> ExternalConnection(
        DevelopmentWorkspace tree, CancellationToken ct)
    {
        if (!tree.Owner.IsExternal) throw new PublicationException("forbidden", "External workspace required.");
        await workspaces.RequireExternalSourceAsync(tree, ct);
        var state = await users.ReadAsync(ct);
        if (!state.Users.Any(u => u.Id == tree.Owner.UserId && !u.Disabled && AppAccessPolicy.IsAdmin(u)))
            throw new PublicationException("forbidden", "PR tracking requires the workspace owner's active administrator account.");
        var source = connections.Providers.ForUrl(tree.Repository);
        var provider = source.Publication ?? throw new PublicationException("unsupported", "This source provider does not support PR tracking.");
        var repository = provider.NormalizeRepository(tree.Repository);
        var grant = await workspaces.WorkspaceGrantAsync(tree, ct);
        if (grant is null)
        {
            foreach (var binding in tree.Apps)
            {
                var app = await apps.GetAppAsync(binding.AppId, ct);
                if (app?.InstalledAt == binding.Installation && app.PrivateSources?.Git is { } current)
                { grant = current; break; }
            }
        }
        var candidates = (state.ProviderConnections ?? []).Where(c => c.UserId == tree.Owner.UserId &&
            c.Provider == source.Descriptor.Id && c.Status == "connected" &&
            (grant is null || c.Id == grant.ConnectionId)).ToArray();
        if (candidates.Length == 0)
            throw new PublicationException("connection_required", "PR tracking is not connected. Connect the workspace owner's source account in Shell Settings → Source connections.");
        if (candidates.Length != 1)
            throw new PublicationException("connection_ambiguous", "Several source accounts match. Select a Git source connection for the workspace's application to enable PR tracking.");
        var connection = candidates[0];
        if (connection.ExpiresAt <= clock.UtcNow && connection.Method != "oauth")
            throw new PublicationException("connection_expired", "PR tracking connection expired. Reconnect it in Shell Settings → Source connections.");
        return (source, repository, connection);
    }

    internal async Task<InspectionPullRequest[]> ReadExternalReferencesAsync(DevelopmentWorkspace tree, string userId, CancellationToken ct)
    {
        var urls = tree.PullRequests.Where(SafeReference).Distinct(StringComparer.Ordinal).ToArray();
        InspectionPullRequest[] Unavailable(string message) => urls.Select(url => new InspectionPullRequest(url, null, null, message)).ToArray();
        if (tree.Owner.UserId != userId) return Unavailable("PR tracking is available to the workspace owner.");
        try
        {
            var binding = await ExternalConnection(tree, ct);
            var snapshot = await JsonStorage.ReadAsync<ExternalPublicationSnapshot>(ExternalPath(tree.Id), ct);
            if (snapshot is null || snapshot.WorkspaceId != tree.Id || !snapshot.Owner.SameIdentity(tree.Owner) ||
                snapshot.Repository != binding.Repository || snapshot.ConnectionId != binding.Connection.Id)
                return Unavailable("PR tracking is connected; waiting for the next provider observation.");
            return urls.Select(url => snapshot.PullRequests.FirstOrDefault(p => p.Url == url)
                ?? new(url, null, null, "Waiting for the next provider observation.")).ToArray();
        }
        catch (Exception ex) when (ex is PublicationException or UserConnectionException or AppLifecycleException)
        { return Unavailable(ex.Message); }
        catch (Exception ex) when (ex is IOException or JsonException)
        { return Unavailable("PR observation is unavailable; the next refresh will retry."); }
    }

    // Fetch fresh provider evidence before acquiring the workspace mutation lock. Publication
    // commands take publication -> workspace locks; reversing that order would deadlock.
    internal async Task<Dictionary<string, string>> MergedWorkspaceHeadsAsync(WorkspaceOwner owner, CancellationToken ct)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var tree in (await workspaces.ListAsync(owner, true, ct)).Workspaces)
        {
            if (!owner.IsExternal)
            {
                var record = await Read(tree.Id, ct);
                if (record is null) continue;
                record = await ObserveAsync(tree.Id, owner, ct);
                if (record.Observation is { State: "merged", Complete: true, Head: { } head } && head == record.PublishedHead)
                    result[tree.Id] = head;
                continue;
            }
            if (tree.PullRequests.Length == 0) continue;
            try
            {
                var binding = await ExternalConnection(tree, ct);
                var provider = binding.Source.Publication!;
                // Background observation stops while paused. Refresh local evidence explicitly
                // before selecting a matching PR; the mutation rechecks it under the owner gate.
                var current = await workspaces.ObserveAsync(tree.Id, owner, ct);
                foreach (var url in tree.PullRequests.Where(SafeReference))
                {
                    if (!int.TryParse(new Uri(url).AbsolutePath.Split('/').LastOrDefault(), out var number) ||
                        number <= 0 || !string.Equals(provider.PullRequestUrl(binding.Repository, number), url, StringComparison.OrdinalIgnoreCase)) continue;
                    var record = new PublicationRecord { WorkspaceId = tree.Id, Owner = owner,
                        Repository = binding.Repository, HeadRepository = binding.Repository,
                        ConnectionId = binding.Connection.Id, Provider = binding.Source.Descriptor.Id,
                        Branch = tree.Branch, TargetBranch = tree.TargetBranch, Number = number, Url = url };
                    var observation = await connections.UseForSourceAsync(owner.UserId, binding.Connection.Id,
                        c => provider.ObserveAsync(c, record, ct), ct);
                    if (observation is { State: "merged", Complete: true, Head: { } head } && head == current.Observation?.Head)
                        result[tree.Id] = head;
                }
            }
            catch (Exception ex) when (ex is PublicationException or UserConnectionException or HttpRequestException)
            { /* No provider exemption; the fresh target ancestry check still applies. */ }
        }
        return result;
    }

    private int externalObservationCursor;
    internal async Task RefreshExternalReferencesAsync(CancellationToken ct, TimeSpan? maximumDuration = null)
    {
        if (!await externalObservationGate.WaitAsync(0, ct)) return;
        using var cycle = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cycle.CancelAfter(maximumDuration ?? TimeSpan.FromSeconds(10));
        try
        {
            var eligible = new List<DevelopmentWorkspace>();
            foreach (var tree in (await workspaces.ListAsync(null, true, cycle.Token)).Workspaces.Where(w => w.Owner.IsExternal))
                if (await workspaces.CanObserveInBackgroundAsync(tree.Id, cycle.Token)) eligible.Add(tree);
            var jobs = eligible.OrderBy(w => w.Id, StringComparer.Ordinal)
                .SelectMany(tree => tree.PullRequests.Where(SafeReference).Distinct(StringComparer.Ordinal)
                    .OrderBy(url => url, StringComparer.Ordinal).Select(url => (Tree: tree, Url: url))).ToArray();
            // One global request budget, with rotation so a slow or large workspace cannot starve
            // references later in the list. Ordinary publications run before this bounded batch.
            for (var attempt = 0; attempt < Math.Min(10, jobs.Length) && !cycle.IsCancellationRequested; attempt++)
            {
                var (tree, url) = jobs[externalObservationCursor % jobs.Length];
                externalObservationCursor = (externalObservationCursor + 1) % jobs.Length;
                try
                {
                    // A previous provider request may have overlapped Delete. Recheck each
                    // queued item so the rest of the batch does not keep polling that workspace.
                    if (!await workspaces.CanObserveInBackgroundAsync(tree.Id, cycle.Token)) continue;
                    var binding = await ExternalConnection(tree, cycle.Token);
                    var provider = binding.Source.Publication!;
                    InspectionPullRequest result;
                    try
                    {
                        var uri = new Uri(url);
                        if (!int.TryParse(uri.AbsolutePath.Split('/').Last(), out var number) || number <= 0 ||
                            !string.Equals(provider.PullRequestUrl(binding.Repository, number), url, StringComparison.OrdinalIgnoreCase))
                            throw new PublicationException("pr_mismatch", "The PR URL does not match this workspace's source repository.");
                        var record = new PublicationRecord { WorkspaceId = tree.Id, Owner = tree.Owner,
                            Repository = binding.Repository, HeadRepository = binding.Repository,
                            ConnectionId = binding.Connection.Id, Provider = binding.Source.Descriptor.Id,
                            Branch = tree.Branch, TargetBranch = tree.TargetBranch, Number = number, Url = url };
                        var observation = await connections.UseForSourceAsync(tree.Owner.UserId, binding.Connection.Id,
                            c => provider.ObserveAsync(c, record, cycle.Token), cycle.Token);
                        result = new(url, observation.Head, observation with { Reviews = null }, null);
                    }
                    catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                    { result = new(url, null, null, "Provider observation timed out; the next refresh will retry."); }
                    catch (Exception ex) when (ex is PublicationException or UserConnectionException or HttpRequestException or JsonException)
                    { result = new(url, null, null, ex is PublicationException ? ex.Message : "Provider state is unavailable. Check the source connection; the next refresh will retry."); }
                    // Finish local persistence even when the provider budget expired. Do not extend
                    // it with another network request. Reads independently revalidate access too.
                    var current = await workspaces.Read(tree.Id, tree.Owner, ct);
                    var finalBinding = await ExternalConnection(current, ct);
                    if (finalBinding.Connection.Id != binding.Connection.Id) continue;
                    var previous = await JsonStorage.ReadAsync<ExternalPublicationSnapshot>(ExternalPath(tree.Id), ct);
                    var retained = previous is not null && previous.WorkspaceId == tree.Id && previous.Owner.SameIdentity(tree.Owner)
                        && previous.Repository == binding.Repository && previous.ConnectionId == binding.Connection.Id
                        ? previous.PullRequests : [];
                    var results = current.PullRequests.Where(SafeReference).Distinct(StringComparer.Ordinal)
                        .Select(reference => reference == url ? result : retained.FirstOrDefault(p => p.Url == reference)
                            ?? new(reference, null, null, "Waiting for the next provider observation.")).ToArray();
                    await workspaces.WritePublicationAsync(tree.Id, () => JsonStorage.WriteAsync(ExternalPath(tree.Id),
                        new ExternalPublicationSnapshot(tree.Id, tree.Owner, binding.Repository, binding.Connection.Id, results),
                        restrictToOwner: true), ct);
                }
                catch (Exception ex) when (ex is PublicationException or UserConnectionException or AppLifecycleException or IOException or JsonException)
                { /* Unavailable ownership/source/credentials are explained by the read projection. */ }
            }
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { /* Yield the observer when this batch's deadline expires. */ }
        finally { externalObservationGate.Release(); }
    }

    private static bool SafeReference(string url) => Uri.TryCreate(url, UriKind.Absolute, out var uri) &&
        uri.Scheme == "https" && uri.UserInfo.Length == 0;
}
