namespace Haas.Hosty.Core;

internal sealed partial class SourceDocumentService
{
    private sealed record WorkspaceDocumentSnapshot(string BaseCommit, SourceDocumentChange[] Changes);
    private readonly SourceDocumentSnapshotCache workspaceInventory = new(128, 16 * 1024 * 1024);
    private readonly SemaphoreSlim[] inventoryGates = Enumerable.Range(0, 32).Select(_ => new SemaphoreSlim(1)).ToArray();
    private int inventoryLoads;
    internal int WorkspaceInventoryLoads => Volatile.Read(ref inventoryLoads);

    private async Task<WorkspaceDocumentSnapshot> WorkspaceChangesAsync(DevelopmentWorkspace tree, string target, CancellationToken ct)
    {
        var gate = inventoryGates[(uint)StringComparer.Ordinal.GetHashCode(tree.Id) % inventoryGates.Length];
        await gate.WaitAsync(ct);
        try
        {
            // Only a healthy, settled observer can attest that a mutable summary is unchanged.
            // Paused/recovering/unobserved trees and concurrent invalidations never populate it.
            var revision = workspaces.StableObservationKey(tree);
            var key = tree.Id + ":" + target + ":" + revision;
            if (revision is not null && workspaceInventory.TryGet<WorkspaceDocumentSnapshot>(key, out var cached)) return cached;
            await workspaces.ValidateTree(tree, ct);
            Interlocked.Increment(ref inventoryLoads);
            var baseCommit = await MergeBaseAsync(tree, target, ct);
            var changes = await ChangesAsync(tree, baseCommit, target, ct);
            var snapshot = new WorkspaceDocumentSnapshot(baseCommit, changes);
            if (revision is not null && revision == workspaces.StableObservationKey(tree))
                workspaceInventory.Set(key, snapshot, 128 + changes.Sum(c => 256L + c.Path.Length * 2L));
            return snapshot;
        }
        finally { gate.Release(); }
    }
}
