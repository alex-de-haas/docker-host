namespace Haas.Hosty.Core;

internal sealed record WorkspaceNameCommand(string RequestId, string Name);
internal sealed record WorkspaceNameOperation(string Id, string Name);
internal sealed record WorkspaceMetadata(string? Name = null, long Revision = 0, DateTimeOffset? UpdatedAt = null,
    WorkspaceNameOperation[]? Operations = null);

internal sealed partial class DevelopmentWorkspaceService
{
    private string MetadataPath(WorkspaceOwner owner)
        => System.IO.Path.Combine(Root, "metadata", WorkspaceIdFor(owner) + ".json");

    internal Task<WorkspaceMetadata?> ReadMetadataAsync(WorkspaceOwner owner, CancellationToken ct)
        => JsonStorage.ReadAsync<WorkspaceMetadata>(MetadataPath(owner), ct);

    internal async Task<WorkspaceMetadata> MetadataAsync(WorkspaceOwner owner, CancellationToken ct)
        => await ReadMetadataAsync(owner, ct) ?? new();

    internal static string ValidateWorkspaceName(string name)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Length > 120 || name != name.Trim() || name.Any(char.IsControl))
            throw Error("name_invalid", "Use a nonempty plain-text workspace name of at most 120 characters, without surrounding whitespace.");
        return name;
    }

    // Old clients remain compatible. Preserve meaningful legacy task labels, never expose hashes
    // as a purpose. Creating agents supply the task name explicitly through their tool contract.
    private static string LegacyWorkspaceName(WorkspaceOwner owner)
    {
        var label = owner.External?.Label;
        if (!string.IsNullOrWhiteSpace(label) && label.Length <= 120 && !label.Any(char.IsControl)
            && label is not ("Codex" or "Claude" or "Development" or "Core development")) return label;
        return "Workspace";
    }

    private async Task<DevelopmentWorkspace> WithNameAsync(DevelopmentWorkspace tree, CancellationToken ct)
        => tree with { Name = (await MetadataAsync(tree.Owner, ct)).Name ?? LegacyWorkspaceName(tree.Owner) };

    // Called under the source-owner gate during prepare. A supplied name initializes the logical
    // workspace once; an explicit rename is required thereafter, including during request replay.
    private async Task EnsureWorkspaceNameAsync(WorkspaceOwner owner, string? name, CancellationToken ct)
    {
        if (name is null || (await MetadataAsync(owner, ct)).Name is not null) return;
        await JsonStorage.WriteAsync(MetadataPath(owner), new WorkspaceMetadata(ValidateWorkspaceName(name), 1, clock.UtcNow), restrictToOwner: true);
        observationState?.CatalogChanged();
    }

    internal Task<WorkspaceMetadata> RenameAsync(WorkspaceOwner owner, WorkspaceNameCommand input, CancellationToken ct)
        => Locked(Hash(OwnerIdentity(owner)), async () =>
        {
            RequestId(input.RequestId);
            ValidateWorkspaceName(input.Name);
            // Source authority is checked even during replay. The identity comes from authenticated
            // caller context; neither request IDs nor display names grant access to another owner.
            var trees = (await ListAsync(null, true, ct)).Workspaces.Where(t => t.Owner.SameIdentity(owner)).ToArray();
            if (trees.Length == 0) throw Error("not_found", "Workspace not found.");
            foreach (var tree in trees)
                if (!await RequireParticipationSourceAsync(tree, owner.UserId, ct)) await Read(tree.Id, owner, ct);
            var metadata = await MetadataAsync(owner, ct);
            var previous = metadata.Operations?.FirstOrDefault(o => o.Id == input.RequestId);
            if (previous is not null)
            {
                if (previous.Name != input.Name) throw Error("request_conflict", "Reuse the original name with this rename requestId.");
                return metadata;
            }
            var next = metadata with { Name = input.Name, Revision = metadata.Revision + 1, UpdatedAt = clock.UtcNow,
                Operations = [.. metadata.Operations ?? [], new(input.RequestId, input.Name)] };
            // One atomic metadata write is the durable receipt. No worktree, source stamp,
            // admission, Git operation, lease, permission or runtime record is rewritten.
            await JsonStorage.WriteAsync(MetadataPath(owner), next, restrictToOwner: true);
            observationState?.CatalogChanged();
            return next;
        }, ct);
}
