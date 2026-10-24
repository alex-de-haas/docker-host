namespace Haas.Hosty.Core;

internal sealed partial class PublicationService
{
    internal async Task<PublicationReviewSnapshot> ReadReviewSnapshotAsync(DevelopmentWorkspace tree,
        string userId, string url, CancellationToken ct)
    {
        var binding = await RequireReviewBindingAsync(tree, userId, url, ct);
        var provider = Publication(binding.Record.Provider);
        var snapshot = await connections.UseForSourceAsync(userId, binding.Connection.Id,
            connection => provider.ReadReviewSnapshotAsync(connection, binding.Record, ct), ct);
        if (snapshot.Url != binding.Record.Url || snapshot.Repository != binding.Record.Repository ||
            snapshot.BaseBranch != binding.Record.TargetBranch || snapshot.Observation.Head != snapshot.Head)
            throw new PublicationException("review_invalid", "The provider snapshot does not match the selected PR and source.");
        // Neither an in-flight provider request nor a cached workspace reference retains authority.
        var current = await workspaces.Read(tree.Id, null, ct);
        var finalBinding = await RequireReviewBindingAsync(current, userId, url, ct);
        if (finalBinding.Connection.Id != binding.Connection.Id || finalBinding.Record.Repository != binding.Record.Repository ||
            finalBinding.Record.Number != binding.Record.Number || finalBinding.Record.Provider != binding.Record.Provider ||
            finalBinding.Record.Branch != binding.Record.Branch || finalBinding.Record.TargetBranch != binding.Record.TargetBranch ||
            finalBinding.Record.HeadRepository != binding.Record.HeadRepository || !finalBinding.Record.Owner.SameIdentity(binding.Record.Owner))
            throw new PublicationException("review_stale", "The PR source connection changed. Refresh the review.");
        return snapshot;
    }
}
