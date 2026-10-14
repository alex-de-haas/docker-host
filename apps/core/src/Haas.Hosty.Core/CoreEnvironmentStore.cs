namespace Haas.Hosty.Core;

internal sealed class CoreEnvironmentStore(CoreDataPaths paths)
{
    public string RegistryRoot => Path.Combine(paths.CoreRoot, "environments");
    public string Roots => Path.Combine(paths.DataRoot, "environments");
    public string Root(string id) => Checked(Roots, id);
    public string RecordPath(string id) => Checked(RegistryRoot, id + ".json", id);
    private string Checked(string root, string segment, string? id = null)
    {
        SandboxValidation.Id(id ?? segment);
        var path = CoreDataPaths.ResolveContainedPath(root, segment);
        if (CoreDataPaths.ContainsSymbolicLink(paths.DataRoot, path))
            throw new SandboxException("environment_path_invalid", "Environment storage must not contain symbolic links.");
        return path;
    }
    public Task<CoreEnvironmentRecord?> ReadAsync(string id, CancellationToken ct)
        => JsonStorage.ReadAsync<CoreEnvironmentRecord>(RecordPath(id), ct);
    public Task WriteAsync(CoreEnvironmentRecord record, CancellationToken ct)
        => JsonStorage.WriteAsync(RecordPath(record.Id), record, true, ct);
    public async Task<CoreEnvironmentRecord[]> ListAsync(CancellationToken ct)
    {
        if (!Directory.Exists(RegistryRoot)) return [];
        var result = new List<CoreEnvironmentRecord>();
        foreach (var path in Directory.EnumerateFiles(RegistryRoot, "*.json"))
            if (await ReadAsync(Path.GetFileNameWithoutExtension(path), ct) is { } record) result.Add(record);
        return result.ToArray();
    }
    private CoreEnvironmentStore AtRoot(string root) => new(paths with { DataRoot = root, CoreRoot = Path.Combine(root, "core") });

    // The on-disk parent relationship survives child/CLI restarts without ambient environment flags.
    internal async Task<CoreEnvironmentStore> BudgetStoreAsync(CancellationToken ct)
    {
        var current = this;
        for (var depth = 0; depth < 64; depth++)
        {
            var root = new DirectoryInfo(Path.GetFullPath(current.DataRoot));
            if (root.Parent?.Name != "environments" || !Guid.TryParseExact(root.Name, "N", out _)) return current;
            var parent = AtRoot(root.Parent.Parent!.FullName);
            var record = await parent.ReadAsync(root.Name, ct);
            if (record is null || record.State is "finished" or "finishing" or "cleanup-failed")
                throw new SandboxException("environment_parent_unavailable", "The parent environment is unavailable for allocation.", 409);
            parent.VerifyRoot(record);
            current = parent;
        }
        throw new SandboxException("environment_capacity", "The environment ancestry exceeds the supported bound.", 409);
    }
    private string DataRoot => paths.DataRoot;

    internal async Task<FileStream> LockAllocationAsync(CancellationToken ct)
    {
        var file = Path.Combine(RegistryRoot, "allocation.lock");
        if (CoreDataPaths.ContainsSymbolicLink(paths.DataRoot, file))
            throw new SandboxException("environment_path_invalid", "Environment allocation storage must not contain symbolic links.");
        Directory.CreateDirectory(RegistryRoot);
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (true)
        {
            ct.ThrowIfCancellationRequested();
            try { return new FileStream(file, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) when (DateTime.UtcNow < deadline) { await Task.Delay(50, ct); }
        }
    }

    internal async Task<List<CoreEnvironmentRecord>> ListUnfinishedTreeAsync(CancellationToken ct)
    {
        var result = new List<CoreEnvironmentRecord>();
        var pending = new Queue<CoreEnvironmentStore>(); pending.Enqueue(this);
        while (pending.TryDequeue(out var owner))
            foreach (var record in await owner.ListAsync(ct))
            {
                if (record.State == "finished") continue;
                result.Add(record);
                if (result.Count > 128) throw new SandboxException("environment_capacity", "Environment tree exceeds the supported bound.", 409);
                owner.VerifyRoot(record);
                pending.Enqueue(AtRoot(owner.Root(record.Id)));
            }
        return result;
    }
    public void VerifyRoot(CoreEnvironmentRecord record)
    {
        var root = Root(record.Id);
        if (!Directory.Exists(root)) return;
        var identity = CoreInstanceId.BuildPath(root);
        if ((!File.Exists(identity) && !record.RootDeletionStarted) || (File.Exists(identity) && File.ReadAllText(identity).Trim() != record.Id))
            throw new SandboxException("environment_owner_mismatch", "The environment root no longer has its recorded Core identity.", 409);
    }
    internal async Task<string[]> CleanupOwnersAsync(CoreEnvironmentRecord record, CancellationToken ct)
    {
        var children = await AtRoot(Root(record.Id)).ListUnfinishedTreeAsync(ct);
        return children.Select(r => r.Id).Append(record.Id).Distinct(StringComparer.Ordinal).ToArray();
    }
    public void DeleteRoot(CoreEnvironmentRecord record)
    {
        VerifyRoot(record);
        var root = Root(record.Id);
        // Directory.Delete unlinks directory symlinks; it does not traverse borrowed mounts/sources.
        if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
    }
}
