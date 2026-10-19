using System.Collections.Concurrent;
using System.Threading.Channels;

namespace Haas.Hosty.Core;

// Registry writes and selected live files invalidate only the affected app. No idle manifest sweep.
internal sealed class AppPermissionObserver(CoreLifecycleService lifecycle, AppRegistryStore apps,
    AppManifestService manifests, ILogger<AppPermissionObserver> logger) : BackgroundService
{
    private sealed record Binding(string Identity, string? InstalledPath);
    private sealed record Pending(bool Force, DateTimeOffset Due);
    private readonly ConcurrentDictionary<string, Binding> bindings = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Pending> pending = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> retries = new(StringComparer.Ordinal);
    private readonly object gate = new();
    private readonly Channel<bool> wake = Channel.CreateBounded<bool>(new BoundedChannelOptions(1)
        { SingleReader = true, FullMode = BoundedChannelFullMode.DropWrite });
    private static readonly TimeSpan Debounce = TimeSpan.FromMilliseconds(150);

    private void Queue(string id, bool force, TimeSpan delay)
    {
        lock (gate)
        {
            var item = new Pending(force, DateTimeOffset.UtcNow + delay);
            if (pending.TryGetValue(id, out var previous))
                item = new(force || previous.Force, item.Due < previous.Due ? item.Due : previous.Due);
            pending[id] = item;
        }
        wake.Writer.TryWrite(true);
    }

    private void RegistryChanged(string id) => Queue(id, false, Debounce);
    private void LiveChanged(string id) => Queue(id, true, Debounce);
    private void ManifestSaved(string path)
    {
        foreach (var (id, binding) in bindings)
            if (LiveManifestWatches.PathComparer.Equals(binding.InstalledPath, path)) Queue(id, true, Debounce);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var watches = new LiveManifestWatches(LiveChanged);
        apps.Changed += RegistryChanged;
        manifests.InstalledManifestSaved += ManifestSaved;
        try
        {
            // Subscribe before enumerating so installs/removals during startup cannot be missed.
            while (true)
            {
                try
                {
                    foreach (var app in await apps.ListAppRecordsAsync(stoppingToken)) Queue(app.Id, true, TimeSpan.Zero);
                    break;
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.LogWarning(ex, "Could not initialize permission observations; retrying registry discovery.");
                    await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
                }
            }
            while (!stoppingToken.IsCancellationRequested)
            {
                while (wake.Reader.TryRead(out _)) { }
                KeyValuePair<string, Pending>[] ready;
                DateTimeOffset? next;
                lock (gate)
                {
                    var now = DateTimeOffset.UtcNow;
                    ready = pending.Where(p => p.Value.Due <= now).ToArray();
                    foreach (var item in ready) pending.Remove(item.Key);
                    next = pending.Count == 0 ? null : pending.Values.Min(p => p.Due);
                }
                if (ready.Length > 0)
                {
                    foreach (var (id, item) in ready)
                    {
                        try
                        {
                            if (await ObserveAsync(id, item.Force, watches, stoppingToken)) retries.Remove(id);
                            else Retry(id, item.Force);
                        }
                        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { return; }
                        catch (Exception ex)
                        {
                            logger.LogWarning(ex, "Could not observe permission declarations for {AppId}; retrying this app.", id);
                            Retry(id, true);
                        }
                    }
                    continue;
                }
                using var wait = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                if (next is { } due)
                {
                    var delay = due - DateTimeOffset.UtcNow;
                    wait.CancelAfter(delay > TimeSpan.Zero ? delay : TimeSpan.Zero);
                }
                try { await wake.Reader.WaitToReadAsync(wait.Token); }
                catch (OperationCanceledException) when (!stoppingToken.IsCancellationRequested) { }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        finally
        {
            apps.Changed -= RegistryChanged;
            manifests.InstalledManifestSaved -= ManifestSaved;
            bindings.Clear();
            lock (gate) pending.Clear();
        }
    }

    private void Retry(string id, bool force)
    {
        var attempt = Math.Min(retries.GetValueOrDefault(id) + 1, 6);
        retries[id] = attempt;
        Queue(id, force, TimeSpan.FromSeconds(Math.Min(30, 1 << (attempt - 1))));
    }

    private async Task<bool> ObserveAsync(string id, bool force, LiveManifestWatches watches, CancellationToken ct)
    {
        var mutex = apps.OperationLock(id);
        if (!await mutex.WaitAsync(0, ct)) return false;
        try
        {
            var app = await apps.GetAppAsync(id, ct);
            if (app is null)
            {
                bindings.TryRemove(id, out _);
                watches.Set(id, null);
                lifecycle.ForgetPermissionObservation(id);
                return true;
            }
            var identity = CoreLifecycleService.PermissionIdentity(app) + "\n" + app.RuntimeState;
            if (!force && bindings.TryGetValue(id, out var previous) && previous.Identity == identity) return true;
            var source = await lifecycle.ResolvePermissionManifestAsync(app, ct);
            var live = source.WatchPath is not null ? Path.GetFullPath(source.WatchPath) : null;
            // Arm/recover watchers before reading. Edits during observation remain queued for another pass.
            watches.Set(id, live, source.LiveRoot);
            await lifecycle.ObservePermissionsAsync(id, true, ct, forceRead: true);
            bindings[id] = new(identity, app.ManifestPath is null ? null : Path.GetFullPath(app.ManifestPath));
            return true;
        }
        finally { mutex.Release(); }
    }
}

// Non-recursive directory subscriptions are shared by live manifests. Ancestor entry events recover
// missing/replaced source directories without watching every file in a repository or polling disk.
internal sealed class LiveManifestWatches(Action<string> changed) : IDisposable
{
    internal static StringComparer PathComparer { get; } = OperatingSystem.IsWindows()
        ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;
    private static StringComparison PathComparison => OperatingSystem.IsWindows()
        ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
    private sealed record Target(string File, string Root);
    private readonly ConcurrentDictionary<string, Target> targets = new(StringComparer.Ordinal);
    private readonly Dictionary<string, FileSystemWatcher> directories = new(PathComparer);
    private readonly ConcurrentDictionary<string, byte> failed = new(PathComparer);
    private volatile bool disposed;

    internal int DirectoryCount => directories.Count;

    internal void Set(string id, string? file, string? sourceRoot = null)
    {
        if (file is null) targets.TryRemove(id, out _);
        else targets[id] = new(Path.GetFullPath(file), Path.TrimEndingDirectorySeparator(
            Path.GetFullPath(sourceRoot ?? Path.GetDirectoryName(file)!)));
        var needed = new HashSet<string>(PathComparer);
        foreach (var target in targets.Values)
        {
            // Observe the selected source and its parent entry, never every ancestor up to the
            // filesystem root (especially costly with macOS FSEvents). If absent, use the nearest
            // existing parent only until the source is recreated.
            var anchor = Path.GetDirectoryName(target.Root) ?? target.Root;
            while (!Directory.Exists(anchor) && Path.GetDirectoryName(anchor) is { } parent) anchor = parent;
            for (var directory = Path.GetDirectoryName(target.File); directory is not null; directory = Path.GetDirectoryName(directory))
            {
                if (Directory.Exists(directory)) needed.Add(directory);
                if (PathComparer.Equals(directory, anchor)) break;
            }
        }
        var invalidated = failed.Keys.ToArray();
        foreach (var path in invalidated) failed.TryRemove(path, out _);
        foreach (var directory in directories.Keys.ToArray())
            if (!needed.Contains(directory) || invalidated.Any(path => PathComparer.Equals(path, directory) || Under(directory, path)))
            {
                directories[directory].Dispose();
                directories.Remove(directory);
            }
        foreach (var directory in needed)
        {
            if (directories.ContainsKey(directory)) continue;
            var watcher = new FileSystemWatcher(directory)
            {
                IncludeSubdirectories = false,
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.Size,
            };
            watcher.Changed += (_, e) => Changed(e.FullPath, false);
            watcher.Created += (_, e) => Changed(e.FullPath, true);
            watcher.Deleted += (_, e) => Changed(e.FullPath, true);
            watcher.Renamed += (_, e) => { Changed(e.OldFullPath, true); Changed(e.FullPath, true); };
            watcher.Error += (_, _) => Failed(directory);
            try { watcher.EnableRaisingEvents = true; directories.Add(directory, watcher); }
            catch { watcher.Dispose(); throw; }
        }
    }

    private void Changed(string path, bool entry)
    {
        if (disposed) return;
        foreach (var (id, target) in targets)
            if (PathComparer.Equals(path, target.File)) changed(id);
            else if (entry && Under(target.File, path))
            {
                // A directory can be replaced before the worker runs. Its old watcher may still
                // follow the old inode even though the path exists again; replace it explicitly.
                failed[path] = 0;
                changed(id);
            }
    }

    // Overflow means event history is incomplete. Re-arm the watcher and reread only its consumers.
    internal void Failed(string directory)
    {
        if (disposed) return;
        failed[directory] = 0;
        foreach (var (id, target) in targets)
            if (Under(target.File, directory)) changed(id);
    }

    private static bool Under(string file, string directory) => file.StartsWith(
        Path.EndsInDirectorySeparator(directory) ? directory : directory + Path.DirectorySeparatorChar, PathComparison);

    public void Dispose()
    {
        disposed = true;
        foreach (var watcher in directories.Values) watcher.Dispose();
        directories.Clear();
        targets.Clear();
    }
}
