namespace Haas.Hosty.Core;

internal sealed class SandboxStore(CoreDataPaths paths)
{
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, SemaphoreSlim> gates = new(StringComparer.Ordinal);
    internal SemaphoreSlim Gate(string id) { SandboxValidation.Id(id); return gates.GetOrAdd(id, _ => new(1, 1)); }
    // Core's root lock provides process exclusivity. The service serializes state transitions;
    // atomic writes preserve journals through process termination and uncertain HTTP responses.
    public string Root => Path.Combine(MountPathPolicy.ResolveRealPath(paths.CoreRoot), "sandboxes");
    public string TemporaryRoot => Path.Combine(MountPathPolicy.ResolveRealPath(paths.DataRoot), "sandboxes");
    public string InstanceRoot(string id) { SandboxValidation.Id(id); return Checked(Path.Combine(Root, "instances"), id); }
    public string DataRoot(string id) { SandboxValidation.Id(id); return Checked(TemporaryRoot, id); }
    public string DataPath(string id, string child) => Checked(DataRoot(id), child);
    public string PlanPath(string id) { SandboxValidation.Id(id); return Checked(Path.Combine(Root, "plans"), id + ".json"); }
    public string ReceiptPath(string id) { SandboxValidation.Id(id); return Checked(Path.Combine(Root, "receipts"), id + ".json"); }
    public string AllocationPath(SandboxActor actor) => Checked(Path.Combine(Root, "allocations"), actor.Key + ".json");
    private string Checked(string root, string child)
    {
        var path = CoreDataPaths.ResolveContainedPath(root, child);
        if (CoreDataPaths.ContainsSymbolicLink(MountPathPolicy.ResolveRealPath(paths.DataRoot), path))
            throw new SandboxException("sandbox_path_invalid", "Sandbox storage cannot contain symbolic links.");
        return path;
    }
    internal bool EmergencyRevoked(string id) => File.Exists(Path.Combine(InstanceRoot(id), "access-revoked"));
    internal Task RevokeEmergencyAsync(string id, CancellationToken ct)
        => JsonStorage.WriteTextAsync(Path.Combine(InstanceRoot(id), "access-revoked"), "storage_budget_exceeded", ct);
    internal void ClearEmergency(string id) => File.Delete(Path.Combine(InstanceRoot(id), "access-revoked"));
    internal void RequireNotRevoked(string id)
    {
        if (EmergencyRevoked(id)) throw new SandboxException("storage_budget_exceeded", "Reduce retained storage and explicitly restart the instance.");
    }
    public Task<SandboxInstance?> ReadAsync(string id, CancellationToken ct)
        => JsonStorage.ReadAsync<SandboxInstance>(Path.Combine(InstanceRoot(id), "instance.json"), ct);
    public Task WriteAsync(SandboxInstance instance, CancellationToken ct)
        => JsonStorage.WriteAsync(Path.Combine(InstanceRoot(instance.Id), "instance.json"), instance, true, ct);
    public async Task<SandboxInstance[]> ListAsync(CancellationToken ct)
    {
        var root = Path.Combine(Root, "instances");
        if (!Directory.Exists(root)) return [];
        var result = new List<SandboxInstance>();
        foreach (var directory in Directory.EnumerateDirectories(root))
        {
            var instance = await ReadAsync(Path.GetFileName(directory), ct);
            if (instance is not null) result.Add(instance);
        }
        return result.ToArray();
    }
    // Expired plans have no runtime authority. Receipts/allocation identities remain durable:
    // stop new metadata growth instead of silently weakening replay guarantees through eviction.
    internal async Task PrunePlansAndCheckCapacityAsync(DateTimeOffset now, CancellationToken ct)
    {
        if (SandboxSupervisor.Size(Root) >= 67108864)
            throw new SandboxException("sandbox_metadata_quota", "The sandbox metadata journal reached 64 MiB; operator retention review is required.");
        var plans = Path.Combine(Root, "plans");
        if (Directory.Exists(plans))
        {
            foreach (var path in Directory.EnumerateFiles(plans, "*.json"))
            {
                var id = Path.GetFileNameWithoutExtension(path);
                var record = await JsonStorage.ReadAsync<SandboxPlanRecord>(PlanPath(id), ct);
                if (record is not null && record.Plan.ExpiresAt <= now) File.Delete(PlanPath(id));
            }
            if (Directory.EnumerateFiles(plans, "*.json").Take(512).Count() >= 512)
                throw new SandboxException("sandbox_metadata_quota", "Finish pending reviews or wait for unused sandbox plans to expire.");
        }
        var allocations = Path.Combine(Root, "allocations");
        if (Directory.Exists(allocations) && Directory.EnumerateFiles(allocations, "*.json").Take(1024).Count() >= 1024)
            throw new SandboxException("sandbox_metadata_quota", "The sandbox allocation journal reached its supported owner limit; operator retention review is required.");
    }
    public void AllocateData(string id)
    {
        foreach (var name in new[] { "data", "seeds", "cache", "logs", "evidence" })
            Directory.CreateDirectory(DataPath(id, name));
    }
    // Called only after all recorded consumers have been verified stopped by the runtime.
    // Directory.Delete does not traverse linked children. Reject a replaced root before deletion.
    public void RemoveTemporary(string id)
    {
        var root = DataRoot(id);
        if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
    }
    public void RemoveMetadata(string id)
    {
        var root = InstanceRoot(id);
        if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
    }
}
