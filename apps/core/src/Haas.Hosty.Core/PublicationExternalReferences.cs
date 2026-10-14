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

    internal async Task RefreshExternalReferencesAsync(CancellationToken ct)
    {
        await externalObservationGate.WaitAsync(ct);
        try
        {
            foreach (var tree in (await workspaces.ListAsync(null, true, ct)).Workspaces.Where(w => w.Owner.IsExternal && w.PullRequests.Length > 0))
            {
                try
                {
                    var binding = await ExternalConnection(tree, ct);
                    var provider = binding.Source.Publication!;
                    var results = new List<InspectionPullRequest>();
                    foreach (var url in tree.PullRequests.Where(SafeReference).Distinct(StringComparer.Ordinal))
                    {
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
                            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                            timeout.CancelAfter(TimeSpan.FromSeconds(20));
                            var observation = await connections.UseForSourceAsync(tree.Owner.UserId, binding.Connection.Id,
                                c => provider.ObserveAsync(c, record, timeout.Token), timeout.Token);
                            // The existing provider correlates repository, head branch and base branch.
                            // A remote push advances the observation; it never changes local workspace HEAD.
                            results.Add(new(url, observation.Head, observation with { Reviews = null }, null));
                        }
                        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                        { results.Add(new(url, null, null, "Provider observation timed out; the next refresh will retry.")); }
                        catch (Exception ex) when (ex is PublicationException or UserConnectionException or HttpRequestException or JsonException)
                        { results.Add(new(url, null, null, ex is PublicationException ? ex.Message : "Provider state is unavailable. Check the source connection; the next refresh will retry.")); }
                    }
                    // Recheck access after network I/O; reads also revalidate before showing cached facts.
                    var current = await workspaces.Read(tree.Id, tree.Owner, ct);
                    var finalBinding = await ExternalConnection(current, ct);
                    if (finalBinding.Connection.Id != binding.Connection.Id) continue;
                    await JsonStorage.WriteAsync(ExternalPath(tree.Id), new ExternalPublicationSnapshot(tree.Id,
                        tree.Owner, binding.Repository, binding.Connection.Id, results.Where(p => current.PullRequests.Contains(p.Url)).ToArray()), restrictToOwner: true);
                }
                catch (Exception ex) when (ex is PublicationException or UserConnectionException or AppLifecycleException or IOException or JsonException)
                { /* Unavailable ownership/source/credentials are explained by the read projection. */ }
            }
        }
        finally { externalObservationGate.Release(); }
    }

    private static bool SafeReference(string url) => Uri.TryCreate(url, UriKind.Absolute, out var uri) &&
        uri.Scheme == "https" && uri.UserInfo.Length == 0;
}
