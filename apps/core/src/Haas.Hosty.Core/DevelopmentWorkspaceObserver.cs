using System.Collections.Concurrent;

namespace Haas.Hosty.Core;

internal sealed class DevelopmentWorkspaceObserver(DevelopmentWorkspaceService workspaces, WorkspaceObservationState state,
    CoreDataPaths paths, ILogger<DevelopmentWorkspaceObserver> logger, TimeSpan? healthInterval = null,
    Func<string, string[], CancellationToken, Action<string[]>?, Task<bool>>? relevance = null) : BackgroundService
{
    // NUL cannot occur in a filesystem name, so literal paths never collide with batch metadata.
    private const string SubtreePrefix = "\0subtree:";
    private readonly Func<string, string[], CancellationToken, Action<string[]>?, Task<bool>> checkRelevance = relevance ?? RelevantAsync;
    private readonly Dictionary<string, SourceWatch> sources = new(StringComparer.Ordinal);
    private readonly Dictionary<string, RepositoryWatch> repositories = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> failed = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, string[]> ignoredDirectories = new(StringComparer.Ordinal);
    private readonly object changeGate = new();
    private Dictionary<string, HashSet<string>> changes = new(StringComparer.Ordinal);
    private int healthCheck;
    private volatile bool rootFailed;
    private FileSystemWatcher? roots;
    private long catalog;
    private WorkspaceDirectoryIdentity? rootsIdentity;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var healthTimer = new PeriodicTimer(healthInterval ?? TimeSpan.FromSeconds(15));
        var health = CheckHealthAsync(healthTimer, stoppingToken);
        state.Wake.Writer.TryWrite(true);
        try
        {
            while (await state.Wake.Reader.WaitToReadAsync(stoppingToken))
            {
                while (state.Wake.Reader.TryRead(out _)) { }
                await Task.Delay(200, stoppingToken);
                try
                {
                    if (Interlocked.Exchange(ref healthCheck, 0) != 0)
                    {
                        if (roots is not null && (!Directory.Exists(roots.Path) || WorkspaceDirectoryIdentity.Read(roots.Path) != rootsIdentity)) rootFailed = true;
                        foreach (var (common, repository) in repositories)
                            if (!Directory.Exists(common) || WorkspaceDirectoryIdentity.Read(common) != repository.Identity) failed[common] = 0;
                        foreach (var source in sources.Values)
                            if (!Directory.Exists(source.Tree.Path) || WorkspaceDirectoryIdentity.Read(source.Tree.Path) != source.Identity
                                || !Directory.Exists(source.GitDirectory) || WorkspaceDirectoryIdentity.Read(source.GitDirectory) != source.GitIdentity) Failed(source.Tree.Id);
                    }
                    if (catalog != state.CatalogRevision || failed.Count > 0 || rootFailed) await ReconcileAsync(stoppingToken);
                    Dictionary<string, HashSet<string>> batch;
                    lock (changeGate) { batch = changes; changes = new(StringComparer.Ordinal); }
                    foreach (var (id, pending) in batch)
                    {
                        if (logger.IsEnabled(LogLevel.Debug)) logger.LogDebug("Workspace event batch {Id}: {Paths}", id, string.Join(", ", pending));
                        if (id.StartsWith("repository:", StringComparison.Ordinal))
                        {
                            var common = id[11..];
                            foreach (var source in sources.Values.Where(s => workspaces.RepositoryPath(s.Tree.Repository) == common))
                                if (pending.Any(path => path == "*" || !path.StartsWith("worktrees/", StringComparison.Ordinal)
                                    || Path.GetFullPath(Path.Combine(common, path)) == source.GitDirectory
                                    || Path.GetFullPath(Path.Combine(common, path)).StartsWith(source.GitDirectory + Path.DirectorySeparatorChar, StringComparison.Ordinal)))
                                { ignoredDirectories.TryRemove(source.Tree.Id, out _); state.Invalidate(source.Tree.Id); }
                        }
                        else if (sources.TryGetValue(id, out var source))
                        {
                            bool relevant;
                            try { relevant = await checkRelevance(source.Tree.Path, pending.ToArray(), stoppingToken, directories => ignoredDirectories[id] = directories); }
                            catch (Exception ex) when (ex is not OperationCanceledException)
                            {
                                // Ignore filtering is an optimization: uncertainty must retain the edit.
                                ignoredDirectories.TryRemove(id, out _);
                                logger.LogWarning(ex, "Cannot filter workspace changes for {WorkspaceId}; inspecting source", id);
                                relevant = true;
                            }
                            if (relevant) state.Invalidate(id);
                        }
                    }
                    foreach (var id in state.Dirty)
                    {
                        if (!sources.ContainsKey(id)) continue;
                        try { await workspaces.ObserveAvailableAsync(id, stoppingToken); }
                        catch (Exception ex) when (ex is not OperationCanceledException)
                        { logger.LogWarning(ex, "Cannot observe workspace {WorkspaceId}", id); Failed(id); }
                    }
                    // A busy owner gate or an event during a scan retains its generation.
                    if (state.Dirty.Any(id => sources.ContainsKey(id) && !failed.ContainsKey(id)))
                        state.Wake.Writer.TryWrite(true);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                { logger.LogWarning(ex, "Cannot reconcile workspace observation"); }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        finally
        {
            healthTimer.Dispose();
            try { await health; } catch (OperationCanceledException) { }
            roots?.Dispose();
            foreach (var source in sources.Values) source.Watcher.Dispose();
            foreach (var repository in repositories.Values) repository.Watcher.Dispose();
        }
    }

    private async Task CheckHealthAsync(PeriodicTimer timer, CancellationToken ct)
    {
        while (await timer.WaitForNextTickAsync(ct))
        {
            // Metadata/liveness check only: a healthy idle watcher never schedules Git.
            Interlocked.Exchange(ref healthCheck, 1);
            state.Wake.Writer.TryWrite(true);
        }
    }

    private async Task ReconcileAsync(CancellationToken ct)
    {
        var revision = state.CatalogRevision;
        var all = (await workspaces.ListAsync(null, false, ct)).Workspaces;
        var active = new Dictionary<string, DevelopmentWorkspace>(StringComparer.Ordinal);
        foreach (var tree in all)
        {
            if (tree.State == "active" && DevelopmentWorkspaceService.IsBackgroundActive(await workspaces.WorkflowAsync(tree.Owner, ct))) active[tree.Id] = tree;
            else state.SetHealth(tree.Id, "paused");
        }
        foreach (var id in sources.Keys.Where(id => !active.ContainsKey(id)).ToArray())
        {
            sources[id].Watcher.Dispose(); sources.Remove(id); ignoredDirectories.TryRemove(id, out _); lock (changeGate) changes.Remove(id); failed.TryRemove(id, out _);
            if (!all.Any(w => w.Id == id)) state.Remove(id);
        }
        foreach (var id in failed.Keys.Where(id => !active.ContainsKey(id) && !repositories.ContainsKey(id))) failed.TryRemove(id, out _);
        foreach (var common in repositories.Keys.ToArray())
        {
            if (!active.Values.Any(s => workspaces.RepositoryPath(s.Repository) == common) || failed.TryRemove(common, out _))
            {
                repositories[common].Watcher.Dispose(); repositories.Remove(common);
                foreach (var source in sources.Values.Where(s => workspaces.RepositoryPath(s.Tree.Repository) == common)) Failed(source.Tree.Id);
            }
        }
        if (rootFailed)
        {
            roots?.Dispose(); roots = null; rootFailed = false;
            foreach (var id in active.Keys) Failed(id);
        }
        var treeRoot = Path.Combine(paths.CoreRoot, "development", "trees");
        if (roots is null && Directory.Exists(treeRoot))
        {
            rootsIdentity = WorkspaceDirectoryIdentity.Read(treeRoot);
            roots = Watch(treeRoot, false, path =>
            {
                var id = Path.GetFileName(path);
                if (id.Length == 64) Failed(id);
                else state.CatalogChanged();
            }, () => { rootFailed = true; state.Wake.Writer.TryWrite(true); });
        }
        foreach (var tree in active.Values)
        {
            if (sources.TryGetValue(tree.Id, out var existing) && !failed.ContainsKey(tree.Id)
                && Directory.Exists(tree.Path) && WorkspaceDirectoryIdentity.Read(tree.Path) == existing.Identity) continue;
            logger.LogDebug("Rearm workspace {Id}; failed={Failed}; identity={Identity}; prior={Prior}", tree.Id, failed.ContainsKey(tree.Id), WorkspaceDirectoryIdentity.Read(tree.Path), existing?.Identity);
            if (sources.Remove(tree.Id, out existing)) existing.Watcher.Dispose();
            ignoredDirectories.TryRemove(tree.Id, out _);
            try
            {
                await workspaces.ValidateTree(tree, ct);
                var common = workspaces.RepositoryPath(tree.Repository);
                var gitFile = await File.ReadAllTextAsync(Path.Combine(tree.Path, ".git"), ct);
                if (!gitFile.StartsWith("gitdir: ", StringComparison.Ordinal)) throw new IOException("Missing linked-worktree metadata.");
                var git = Path.GetFullPath(gitFile[8..].Trim(), tree.Path);
                if (!git.StartsWith(common + Path.DirectorySeparatorChar, StringComparison.Ordinal)) throw new IOException("Worktree metadata is outside its repository.");
                if (!repositories.ContainsKey(common))
                    repositories[common] = new(WorkspaceDirectoryIdentity.Read(common), Watch(common, true, path => RepositoryChanged(common, path),
                        () => { failed[common] = 0; state.RequestReconcile(); }));
                if (WorkspaceDirectoryIdentity.Read(tree.Path) is null || WorkspaceDirectoryIdentity.Read(git) is null)
                    throw new IOException("Cannot identify workspace directories.");
                var watcher = Watch(tree.Path, true, path => SourceChanged(tree.Id, tree.Path, path), () => Failed(tree.Id));
                sources[tree.Id] = new(tree, git, WorkspaceDirectoryIdentity.Read(tree.Path), WorkspaceDirectoryIdentity.Read(git), watcher);
                failed.TryRemove(tree.Id, out _);
                state.SetHealth(tree.Id, "watching");
                state.Invalidate(tree.Id);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or AppLifecycleException)
            {
                failed[tree.Id] = 0; state.SetHealth(tree.Id, "recovering");
                // Report the unavailable source once per recovery attempt, without fabricating clean state.
                await workspaces.ObserveAvailableAsync(tree.Id, ct);
                logger.LogDebug(ex, "Workspace watcher unavailable for {WorkspaceId}", tree.Id);
            }
        }
        catalog = revision;
    }

    private void Failed(string id)
    {
        if (failed.TryAdd(id, 0)) { state.SetHealth(id, "recovering"); state.Invalidate(id); }
    }
    private void SourceChanged(string id, string root, string path)
    {
        var relative = Path.GetRelativePath(root, path).Replace(Path.DirectorySeparatorChar, '/');
        if (relative == ".git") { Failed(id); return; }
        if (relative == ".gitignore" || relative.EndsWith("/.gitignore", StringComparison.Ordinal)) ignoredDirectories.TryRemove(id, out _);
        if (ignoredDirectories.TryGetValue(id, out var ignored) && ignored.Any(directory => relative == directory || relative.StartsWith(directory + "/", StringComparison.Ordinal))) return;
        Queue(id, relative);
    }
    private void RepositoryChanged(string common, string path)
    {
        var relative = Path.GetRelativePath(common, path).Replace(Path.DirectorySeparatorChar, '/');
        if (relative is "objects" or "logs" || relative.StartsWith("objects/", StringComparison.Ordinal) || relative.StartsWith("logs/", StringComparison.Ordinal)
            || relative.EndsWith(".lock", StringComparison.Ordinal)) return;
        // Callbacks do not enumerate mutable registrations. Queue a repository invalidation.
        Queue("repository:" + common, relative);
    }
    private void Queue(string id, string path)
    {
        lock (changeGate)
        {
            if (!changes.TryGetValue(id, out var pending)) changes[id] = pending = new(StringComparer.Ordinal);
            if (pending.Contains("*")) return;
            var subtree = pending.FirstOrDefault(p => p.StartsWith(SubtreePrefix, StringComparison.Ordinal));
            if (pending.Count >= 128 || subtree is not null)
            {
                var candidates = pending.Select(p => p.StartsWith(SubtreePrefix, StringComparison.Ordinal) ? p[SubtreePrefix.Length..] + "/" : p).Append(path).ToArray();
                var prefix = candidates[0];
                foreach (var candidate in candidates.Skip(1))
                    while (prefix.Length > 0 && !candidate.StartsWith(prefix, StringComparison.Ordinal)) prefix = prefix[..^1];
                var wholeDirectory = prefix.Length > 0 && candidates.All(p => p == prefix || p.StartsWith(prefix + "/", StringComparison.Ordinal));
                var slash = prefix.LastIndexOf('/');
                pending.Clear(); pending.Add(wholeDirectory ? SubtreePrefix + prefix : slash < 0 ? "*" : SubtreePrefix + prefix[..slash]);
            }
            else pending.Add(path);
        }
        state.Wake.Writer.TryWrite(true);
    }
    internal static async Task<bool> RelevantAsync(string root, string[] paths, CancellationToken ct, Action<string[]>? remember = null)
    {
        if (paths.Length == 0) return false;
        if (paths.Any(p => p is "*" or ".git" or ".gitignore" || p.EndsWith("/.gitignore", StringComparison.Ordinal))) return true;
        paths = paths.Select(p => p.StartsWith(SubtreePrefix, StringComparison.Ordinal) ? p[SubtreePrefix.Length..] : p).ToArray();
        var candidates = paths.ToHashSet(StringComparer.Ordinal);
        foreach (var path in paths)
        {
            var parent = path;
            while (parent.LastIndexOf('/') is var slash && slash > 0)
            { parent = parent[..slash]; candidates.Add(parent); }
        }
        if (candidates.Sum(p => p.Length) > 24000) return true;
        // check-ignore rejects Git's global literal-pathspec mode; it reads names, not patterns.
        // Git owns ignore semantics. Ancestor results allow us to suppress generated-file storms,
        // but only after verifying that the ignored directory contains no tracked paths.
        var result = await DevelopmentWorkspaceService.Git(root, ["--no-literal-pathspecs", "-c", "core.quotePath=false", "check-ignore", "--", .. candidates], ct, true);
        if (result.ExitCode is not (0 or 1)) return true;
        // Git quotes unusual control-character paths; an unmatched name conservatively invalidates.
        var ignored = result.StandardOutput.Split('\n', StringSplitOptions.RemoveEmptyEntries).ToHashSet(StringComparer.Ordinal);
        if (paths.Any(p => !ignored.Contains(p))) return true;
        var trackedResult = await DevelopmentWorkspaceService.Git(root, ["ls-files", "-z", "--", .. ignored], ct);
        var tracked = trackedResult.StandardOutput.Split('\0', StringSplitOptions.RemoveEmptyEntries);
        bool ContainsTracked(string directory) => tracked.Any(p => p == directory || p.StartsWith(directory + "/", StringComparison.Ordinal));
        remember?.Invoke(ignored.Where(p => Directory.Exists(Path.Combine(root, p)) && !ContainsTracked(p)).ToArray());
        return paths.Any(ContainsTracked);
    }
    private static FileSystemWatcher Watch(string path, bool recursive, Action<string> changed, Action failed)
    {
        var watcher = new FileSystemWatcher(path) { IncludeSubdirectories = recursive,
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | (recursive ? NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.Attributes : 0) };
        watcher.Changed += (_, e) => changed(e.FullPath);
        watcher.Created += (_, e) => changed(e.FullPath);
        watcher.Deleted += (_, e) => changed(e.FullPath);
        watcher.Renamed += (_, e) => { changed(e.OldFullPath); changed(e.FullPath); };
        watcher.Error += (_, _) => failed();
        try { watcher.EnableRaisingEvents = true; return watcher; }
        catch { watcher.Dispose(); throw; }
    }
    private sealed record RepositoryWatch(WorkspaceDirectoryIdentity? Identity, FileSystemWatcher Watcher);
    private sealed record SourceWatch(DevelopmentWorkspace Tree, string GitDirectory, WorkspaceDirectoryIdentity? Identity, WorkspaceDirectoryIdentity? GitIdentity, FileSystemWatcher Watcher);
}
