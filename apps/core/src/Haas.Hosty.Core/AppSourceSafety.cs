using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Haas.Hosty.Core;

internal sealed record AppSourceReview(string[] Details, string Fingerprint, bool Unknown);

// Facts come from current source and durable workspace records, never an advisory cached list.
// Callers hold repository source gates through validation and mutation; native writers hold leases.
internal sealed class AppSourceSafety(CoreDataPaths paths, AppRegistryStore apps)
{
    private string Records => Path.Combine(paths.CoreRoot, "development", "workspaces");
    internal string[] DeletionPaths(string appId) => [paths.ResolveManagedCheckoutPath(appId), CoreDataPaths.ResolveContainedPath(paths.SourcesRoot, appId)];

    private async Task<DevelopmentWorkspace[]> Trees(string appId, CancellationToken ct)
    {
        var result = new List<DevelopmentWorkspace>();
        if (!Directory.Exists(Records)) return [];
        var reader = new DevelopmentWorkspaceService(paths, apps, new SystemClock());
        foreach (var file in Directory.EnumerateFiles(Records, "*.json").Order(StringComparer.Ordinal))
        {
            DevelopmentWorkspace tree;
            try { tree = await reader.Read(Path.GetFileNameWithoutExtension(file), null, ct); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or AppLifecycleException)
            { throw new AppLifecycleException("source_activity_unknown", "Workspace activity cannot be verified. Restore unreadable workspace records before changing or removing source."); }
            if (tree.State != "released" && (tree.Apps.Any(a => a.AppId == appId) ||
                DeletionPaths(appId).Any(root => Path.IsPathFullyQualified(tree.Repository) && HostPathAuthority.Within(root, tree.Repository))))
                result.Add(tree);
        }
        return result.ToArray();
    }

    // The app operation lock prevents preparation for this app while its existing repository
    // admissions are collected. Sorted repository gates also fence consumers owned by other sessions.
    internal async Task<IDisposable> LockAsync(string appId, CancellationToken ct)
    {
        var ids = (await Trees(appId, ct)).Select(t => t.RepositoryId).ToHashSet(StringComparer.Ordinal);
        var source = (await apps.GetAppAsync(appId, ct))?.SourceState;
        if (source is not null)
        {
            try
            {
                var repository = await new DevelopmentWorkspaceService(paths, apps, new SystemClock())
                    .CanonicalRepositoryAsync(source.Repository, source.LocalOverridePath, ct);
                ids.Add(DevelopmentWorkspaceService.Hash(repository));
            }
            catch (AppLifecycleException) { /* Unknown source facts are reported by ReviewAsync. */ }
        }
        var held = new List<SemaphoreSlim>();
        try
        {
            foreach (var id in ids.Order(StringComparer.Ordinal))
            {
                var gate = apps.SourceActivityGate(id);
                await gate.WaitAsync(ct);
                held.Add(gate);
            }
            return new ActivityScope(held);
        }
        catch { foreach (var gate in held.AsEnumerable().Reverse()) gate.Release(); throw; }
    }

    private sealed class ActivityScope(List<SemaphoreSlim> gates) : IDisposable
    {
        public void Dispose() { foreach (var gate in gates.AsEnumerable().Reverse()) gate.Release(); }
    }

    internal async Task RequireIdleAsync(string appId, CancellationToken ct)
    {
        var trees = await Trees(appId, ct);
        if (trees.Any(t => t.Leases.Length > 0 || t.SandboxConsumers.Length > 0 ||
            t.State == "releasing" || t.Operations.Any(o => o.State is "pending" or "unknown")))
            throw new AppLifecycleException("source_in_use", "Stop active workspace work, finish attached sandboxes and recover pending source operations before removing the app or changing source. Files were retained.");
    }

    internal async Task<AppSourceReview> ReviewAsync(string appId, bool deleting, CancellationToken ct)
    {
        var details = new List<string>();
        var seed = new List<string> { appId, deleting.ToString() };
        var unknown = false;
        var app = await apps.GetAppAsync(appId, ct);
        seed.Add(CoreJson.Text(app?.SourceState));
        var owned = DeletionPaths(appId);
        var roots = owned.Concat(new[] { app?.SourceState?.LocalOverridePath, app?.SourceState?.ManagedCheckoutPath }
            .OfType<string>()).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal);
        string? canonicalHead = null;
        foreach (var root in roots)
        {
            var deletes = deleting && owned.Contains(root, StringComparer.Ordinal);
            seed.Add(root);
            if (!Directory.Exists(root) && !File.Exists(root)) { seed.Add("absent"); continue; }
            details.Add($"{root}: {(deletes ? "permanently delete" : "keep on disk")}.");
            try
            {
                if (CoreDataPaths.ContainsSymbolicLink(paths.DataRoot, root) && owned.Contains(root, StringComparer.Ordinal))
                    throw new IOException("Managed source is a symbolic link.");
                var git = await GitFacts(root, ct);
                seed.Add(git.Facts);
                details.Add(git.Description);
                if (root == owned[0]) canonicalHead = git.Head;
                if (deletes) seed.Add(await ContentFingerprint(root, ct));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or AppLifecycleException)
            {
                unknown = true; seed.Add("unknown");
                details.Add("Source state is unknown. Git cleanliness, recoverability or file contents could not be verified.");
            }
        }
        try
        {
            foreach (var tree in await Trees(appId, ct))
            {
                seed.Add(CoreJson.Text(tree with { Observation = null }));
                try
                {
                    var git = await GitFacts(tree.Path, ct);
                    seed.Add(git.Facts);
                    var integrated = canonicalHead is not null && git.Head is not null &&
                        (await DevelopmentWorkspaceService.Git(tree.Path, ["merge-base", "--is-ancestor", git.Head, canonicalHead], ct, true)).ExitCode == 0;
                    details.Add($"Worktree {tree.Id}: {git.Description} {(integrated ? "Committed HEAD is included in canonical source." : "Integration into canonical source is not verified.")} Worktree files are kept.");
                    details.Add($"Activity: {tree.Leases.Length} lease(s), {tree.SandboxConsumers.Length} sandbox consumer(s); pending or unknown source operations: {tree.Operations.Count(o => o.State is "pending" or "unknown")}.");
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or AppLifecycleException)
                { unknown = true; seed.Add("worktree-unknown"); details.Add($"Worktree {tree.Id}: source state unknown; files are kept."); }
            }
        }
        catch (AppLifecycleException)
        { unknown = true; seed.Add("activity-unknown"); details.Add("Workspace activity is unknown; source changes and removal are blocked."); }
        if (!deleting && app?.SourceState?.Type == "local-git")
            details.Add("The local source binding and accepted commit are retained for explicit reinstallation, even when app data and settings are deleted.");
        details.Add("Local commits and an existing remote do not prove a remote backup. No remote backup was checked.");
        if (deleting) details.Add("Deleting source does not delete retained worktrees, but their original source binding may become unavailable. Export or accept outstanding work before deletion if you need to continue it.");
        return new(details.ToArray(), DevelopmentWorkspaceService.Hash(string.Join("\0", seed)), unknown);
    }

    private static async Task<(string Facts, string Description, string? Head)> GitFacts(string root, CancellationToken ct)
    {
        var git = await DevelopmentWorkspaceService.Git(root, ["rev-parse", "--show-toplevel"], ct, true);
        if (git.ExitCode != 0 || MountPathPolicy.ResolveRealPath(git.StandardOutput.Trim()) != MountPathPolicy.ResolveRealPath(root))
        {
            if (File.Exists(Path.Combine(root, ".git")) || Directory.Exists(Path.Combine(root, ".git")))
                throw new IOException("Git metadata cannot be read.");
            return ("no-git", "No Git history in this folder; recovery from commits is unavailable.", null);
        }
        var head = (await DevelopmentWorkspaceService.Git(root, ["rev-parse", "HEAD"], ct)).StandardOutput.Trim();
        var status = (await DevelopmentWorkspaceService.Git(root, ["status", "--porcelain", "--untracked-files=all"], ct)).StandardOutput;
        var refs = (await DevelopmentWorkspaceService.Git(root, ["show-ref", "--head"], ct)).StandardOutput;
        var remotes = (await DevelopmentWorkspaceService.Git(root, ["remote"], ct)).StandardOutput;
        return (string.Join("\n", head, status, refs, remotes),
            $"Git HEAD {head}: {(status.Length == 0 ? "clean" : "uncommitted changes")}; {(remotes.Length == 0 ? "local only, no remote" : "remote configured, backup unverified")}", head);
    }

    // Bounded full content review for destructive deletion includes ignored files. Git object storage
    // is represented by refs/HEAD above; no source bytes or credentials enter the returned review.
    private static async Task<string> ContentFingerprint(string root, CancellationToken ct)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        long bytes = 0; int count = 0;
        async Task Walk(string dir)
        {
            foreach (var path in Directory.EnumerateFileSystemEntries(dir).Order(StringComparer.Ordinal))
            {
                ct.ThrowIfCancellationRequested();
                if (++count > 20000) throw new IOException("Source review file limit exceeded.");
                var relative = Path.GetRelativePath(root, path);
                hash.AppendData(Encoding.UTF8.GetBytes(relative + "\0"));
                var attr = File.GetAttributes(path);
                if ((attr & FileAttributes.ReparsePoint) != 0)
                { hash.AppendData(Encoding.UTF8.GetBytes("link:" + new FileInfo(path).LinkTarget + "\0")); continue; }
                if (relative == ".git") continue;
                if ((attr & FileAttributes.Directory) != 0) { await Walk(path); continue; }
                await using var stream = File.OpenRead(path);
                if ((bytes += stream.Length) > 256L * 1024 * 1024) throw new IOException("Source review byte limit exceeded.");
                hash.AppendData(await SHA256.HashDataAsync(stream, ct));
            }
        }
        await Walk(root);
        return Convert.ToHexString(hash.GetHashAndReset());
    }
}
