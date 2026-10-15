namespace Haas.Hosty.Core;

// This descriptor is coordinator-only, not an agent tool. Its administrator-wide source visibility
// is intentional: the shared worker is not an isolation boundary between workspaces or users.
internal sealed record DevelopmentWorkerBindings(string InstanceId, string InstallationId,
    string TreesRoot, string RepositoriesRoot, string[] WorktreePaths);
internal sealed record DevelopmentWorkerLeaseRequest(string LeaseId, bool Acquire);
internal sealed record DevelopmentWorkerLease(WorkspaceOwner Owner, string LeaseId, bool Active);

internal sealed partial class DevelopmentWorkspaceService
{
    private string WorkerLeases => System.IO.Path.Combine(Root, "worker-leases");

    internal Task<DevelopmentWorkerBindings> WorkerBindingsAsync(WorkspaceOwner owner, CancellationToken ct)
        => Locked("shared-worker-bindings", () => DescribeWorkerBindingsAsync(owner, ct), ct);

    private async Task<DevelopmentWorkerBindings> DescribeWorkerBindingsAsync(WorkspaceOwner owner, CancellationToken ct)
    {
        if (owner.IsExternal) throw Error("forbidden", "Shared worker bindings require an installed assistant.");
        var trees = System.IO.Path.Combine(Root, "trees");
        var repositories = System.IO.Path.Combine(Root, "repositories");
        Directory.CreateDirectory(trees);
        Directory.CreateDirectory(repositories);
        if (MountPathPolicy.ResolveRealPath(trees) != trees || MountPathPolicy.ResolveRealPath(repositories) != repositories)
            throw Error("binding_invalid", "Shared source roots must not redirect through symbolic links.");
        var verified = new List<string>();
        foreach (var workspace in (await ListRecordsAsync(null, false, ct)).Workspaces)
        {
            if (workspace.State != "active" || !Directory.Exists(workspace.Path)) continue;
            await ValidateTree(workspace, ct);
            if (MountPathPolicy.ResolveRealPath(workspace.Path) != workspace.Path)
                throw Error("binding_invalid", "A registered worktree redirects through a symbolic link.");
            verified.Add(workspace.Path);
        }
        // Include the canonical root: even a copied Core data root is a distinct worker authority.
        var instance = Hash(MountPathPolicy.ResolveRealPath(paths.DataRoot));
        return new(instance, Hash(owner.AppId + "\n" + owner.Installation.ToString("O")), trees, repositories, verified.ToArray());
    }

    internal Task<DevelopmentWorkerBindings?> WorkerLeaseAsync(WorkspaceOwner owner,
        DevelopmentWorkerLeaseRequest input, CancellationToken ct)
        => Locked("shared-worker-bindings", async () =>
        {
            if (owner.IsExternal) throw Error("forbidden", "Shared worker leases require an installed assistant.");
            if (!Guid.TryParseExact(input.LeaseId, "D", out var lease)) throw Error("request_invalid", "A UUID leaseId is required.");
            var file = System.IO.Path.Combine(WorkerLeases, lease.ToString("D") + ".json");
            var current = await JsonStorage.ReadAsync<DevelopmentWorkerLease>(file, ct);
            if (current is not null && !current.Owner.SameIdentity(owner))
                throw Error("forbidden", "This worker lease belongs to another session or installation.");
            if (input.Acquire && current is { Active: false })
                throw Error("lease_retired", "This generation was already stopped. Allocate a new lease for a new worker.");
            var bindings = input.Acquire ? await DescribeWorkerBindingsAsync(owner, ct) : null;
            // Keep a tombstone: a delayed acquire cannot resurrect a generation after Stop.
            await JsonStorage.WriteAsync(file, new DevelopmentWorkerLease(owner, input.LeaseId, input.Acquire), restrictToOwner: true);
            return bindings;
        }, ct);

    private async Task CheckSharedWorkersAsync(CancellationToken ct)
    {
        if (!Directory.Exists(WorkerLeases)) return;
        foreach (var file in Directory.EnumerateFiles(WorkerLeases, "*.json"))
        {
            var lease = await JsonStorage.ReadAsync<DevelopmentWorkerLease>(file, ct)
                ?? throw Error("consumer_unavailable", "Cannot verify the shared worker lease.");
            if (lease.Active) throw Error("in_use", "A shared agent worker still consumes the Core worktree area. Stop it before cleanup.");
        }
    }
}

internal sealed partial class SandboxDockerRuntime
{
    // A label alone grants no accounting exemption. Match an active Core-owned lease and the
    // derived container name, then credit only the part already reserved by the sandbox policy.
    internal static async Task<long> SharedWorkerReservationAsync(System.Text.Json.JsonElement container,
        string dataRoot, long remainingReservation, CancellationToken ct)
    {
        if (remainingReservation <= 0 || !container.TryGetProperty("Config", out var config)
            || !config.TryGetProperty("Labels", out var labels) || labels.ValueKind != System.Text.Json.JsonValueKind.Object
            || !labels.TryGetProperty("hosty.agent-worker", out var worker) || worker.GetString() != "1"
            || !labels.TryGetProperty("hosty.agent-worker.generation", out var generation)
            || !Guid.TryParseExact(generation.GetString(), "D", out var leaseId)) return 0;
        var root = MountPathPolicy.ResolveRealPath(dataRoot);
        var file = System.IO.Path.Combine(root, "core", "development", "worker-leases", leaseId.ToString("D") + ".json");
        var lease = await JsonStorage.ReadAsync<DevelopmentWorkerLease>(file, ct);
        if (lease is not { Active: true }) return 0;
        var instance = DevelopmentWorkspaceService.Hash(root);
        var installation = DevelopmentWorkspaceService.Hash(lease.Owner.AppId + "\n" + lease.Owner.Installation.ToString("O"));
        if (!labels.TryGetProperty("hosty.agent-worker.instance", out var actualInstance) || actualInstance.GetString() != instance
            || !labels.TryGetProperty("hosty.agent-worker.installation", out var actualInstallation) || actualInstallation.GetString() != installation
            || !container.TryGetProperty("Name", out var name)
            || name.GetString() != $"/hosty-agent-{instance[..12]}-{installation[..12]}-{leaseId:D}") return 0;
        var memory = container.GetProperty("HostConfig").GetProperty("Memory").GetInt64();
        return Math.Min(remainingReservation, Math.Max(0, memory));
    }
}
