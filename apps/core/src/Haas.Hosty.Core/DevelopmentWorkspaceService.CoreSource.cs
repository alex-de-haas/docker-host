using Haas.Hosty.Launch;

namespace Haas.Hosty.Core;

internal sealed record CoreWorkspacePrepare(string RequestId, string TaskId, string LeaseId,
    string SourceRevision, string? TargetBranch = null, string? Label = null);

internal sealed partial class DevelopmentWorkspaceService
{
    internal async Task RequireCoreSourceAsync(DevelopmentWorkspace tree, string userId, CancellationToken ct, UserProviderConnection? heldConnection = null, bool localOnly = false)
    {
        if (tree.Core is null || coreDevelopment is null) return;
        var source = await coreDevelopment.SourceSettingsAsync(ct);
        if (source.ConnectionId is not null && source.RepositoryUrl is not null
            && LogicalRepositoryIdentity(tree.Repository) == LogicalRepositoryIdentity(source.RepositoryUrl))
            _ = await coreDevelopment.SourceGrantAsync(source, userId, ct, heldConnection, localOnly);
    }

    internal void ValidateHeldSourceGrant(SourceReadGrant grant, UserProviderConnection connection)
        => (privateSources ?? throw PrivateSourceService.Denied()).ValidateWithConnection(new(Git: grant), connection);

    private async Task ValidateSourceGrantAsync(SourceReadGrant grant, CancellationToken ct, UserProviderConnection? heldConnection, bool localOnly = false)
    {
        var access = privateSources ?? throw PrivateSourceService.Denied();
        if (heldConnection is null && localOnly) await access.ValidateLocalAsync(new(Git: grant), ct);
        else if (heldConnection is null) await access.ValidateAsync(new(Git: grant), ct);
        else access.ValidateWithConnection(new(Git: grant), heldConnection);
    }

    // Caller must have explicit Core configuration authority; ordinary prepare_workspace never enters here.
    internal async Task<DevelopmentWorkspace> PrepareCoreSourceAsync(WorkspaceOwner owner, CoreWorkspacePrepare input,
        CancellationToken ct)
    {
        var development = coreDevelopment ?? throw Error("core_unavailable", "Core source management is unavailable.");
        using var sourceLock = CoreLaunchFiles.Lock(paths.DataRoot);
        CoreLaunchFiles.AssertNoPendingOperations(paths.DataRoot);
        var source = await development.SourceSettingsAsync(ct);
        if (source.Revision != input.SourceRevision) throw Error("core_source_changed", "Core source changed; refresh before preparing.");
        if (source.RepositoryUrl is null) throw Error("core_source_missing", "Configure Core's repository URL first.");
        _ = CoreDevelopmentService.Project(paths.DataRoot, source.ProjectPath);
        _ = await development.SourceGrantAsync(source, owner.UserId, ct);
        return await PrepareCoreAsync(owner,
            new(input.RequestId, input.TaskId, "", null, input.TargetBranch, input.LeaseId, input.Label), ct, source);
    }
}
