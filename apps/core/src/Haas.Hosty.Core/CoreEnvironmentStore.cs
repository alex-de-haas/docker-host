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
    public void VerifyRoot(CoreEnvironmentRecord record)
    {
        var root = Root(record.Id);
        if (!Directory.Exists(root)) return;
        var identity = CoreInstanceId.BuildPath(root);
        if (!File.Exists(identity) || File.ReadAllText(identity).Trim() != record.Id)
            throw new SandboxException("environment_owner_mismatch", "The environment root no longer has its recorded Core identity.", 409);
    }
    public void DeleteRoot(CoreEnvironmentRecord record)
    {
        VerifyRoot(record);
        var root = Root(record.Id);
        // Directory.Delete unlinks directory symlinks; it does not traverse borrowed mounts/sources.
        if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
    }
}
