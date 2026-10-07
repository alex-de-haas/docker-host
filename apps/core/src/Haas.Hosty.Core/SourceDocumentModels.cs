namespace Haas.Hosty.Core;

internal sealed record SourceRepositoryApp(string AppId, string Name, string? ManifestSubpath, string[] Paths);
internal sealed record SourceRepository(string Id, string Repository, string Branch, bool WorkspaceDerived,
    SourceRepositoryApp[] Apps, string State, string? Error = null, string? Commit = null, DateTimeOffset? FetchedAt = null);
internal sealed record SourceRepositoryList(SourceRepository[] Repositories);
internal sealed record SourceDocumentReference(string Path, bool Exists, bool IsDirectory);
internal sealed record SourceDocument(string Path, string Sha, long Size, DateTimeOffset? ModifiedAt = null,
    SourceDocumentReference[]? ReferencePaths = null);
internal sealed record SourceDocumentList(string RepositoryId, string Version, string? WorkspaceId, string? Commit,
    SourceDocument[] Documents, string State = "available", string? Error = null);
internal sealed record SourceDocumentRead(string Path, string Version = "target", string? WorkspaceId = null,
    string? Commit = null, string? ExpectedSha = null);
internal sealed record SourceDocumentContent(string Path, string Sha, string Content, string? Commit,
    string Version, string? WorkspaceId, SourceDocumentReference[]? ReferencePaths = null);
internal sealed record SourceDocumentChange(string Path, string Kind, DateTimeOffset? ModifiedAt,
    bool TargetChanged, string? BaseSha, string? WorktreeSha, string? TargetSha);
internal sealed record SourceWorkspace(string Id, string RepositoryId, string Repository, string TargetBranch,
    string Branch, string State, string AdministratorId, string AssistantAppId, string SessionId,
    string? SessionUrl, string? SessionUrlError, DateTimeOffset? ObservationAt, string? ObservationState,
    string[] PullRequests, string? BaseCommit, string? TargetCommit, SourceDocumentChange[]? Changes, string? Error = null);
internal sealed record SourceWorkspaceList(SourceWorkspace[] Workspaces);
