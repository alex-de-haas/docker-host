namespace Haas.Hosty.Core;

internal sealed partial class WorkspaceInspectionService
{
    internal async Task<PullRequestRelatedLink[]> PullRequestLinksAsync(string userId, string url, CancellationToken ct)
    {
        await workspaces.RequireWorkspaceUserAsync(userId, ct);
        var installed = await apps.ListAppRecordsAsync(ct);
        var result = new Dictionary<string, PullRequestRelatedLink>(StringComparer.Ordinal);
        foreach (var tree in (await workspaces.ListAsync(null, true, ct)).Workspaces)
        {
            if (!tree.PullRequests.Contains(url, StringComparer.OrdinalIgnoreCase)) continue;
            try { await RequireSourceAsync(tree, userId, installed, ct); }
            catch (AppLifecycleException) { continue; }
            result.TryAdd(tree.WorkspaceId, new("workspace", tree.WorkspaceId, tree.Name ?? "Workspace"));
            if (result.Count >= 50) break;
        }
        return result.Values.ToArray();
    }
}
