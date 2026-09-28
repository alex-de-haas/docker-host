namespace Haas.Hosty.Core;

internal sealed record WorkspaceOwner(string AppId, DateTimeOffset Installation, string UserId, string SessionId);
internal sealed record WorkspaceApp(string AppId, DateTimeOffset Installation, string? Subpath);
internal sealed record WorkspacePrepare(string RequestId, string SessionId, string AppId, string SessionPath, string? TargetBranch = null, string? LeaseId = null);
internal sealed record WorkspaceCommand(string RequestId, string? ExpectedHead = null, string? Message = null,
    string[]? Paths = null, string? AuthorName = null, string? AuthorEmail = null, string? LeaseId = null,
    string[]? PullRequests = null);
internal sealed record WorkspaceDiffRequest(string Path, string View = "session");
internal sealed record WorkspaceOperation(string Id, string Kind, string Fingerprint, string State,
    string? BeforeHead = null, string? ResultHead = null, string? Error = null, WorkspaceCommand? Command = null);
internal sealed record WorkspaceObservation(DateTimeOffset At, string State, string? Head = null,
    string? TargetHead = null, int? Ahead = null, int? Behind = null, bool Conflict = false,
    AppSourceStatus? Local = null, string[]? SessionFiles = null, string? Error = null);
internal sealed record DevelopmentWorkspace
{
    public required string Id { get; init; }
    public required WorkspaceOwner Owner { get; init; }
    public required string Repository { get; init; }
    public required string RepositoryId { get; init; }
    public required string Path { get; init; }
    public required string Branch { get; init; }
    public required string TargetBranch { get; init; }
    public required string OriginalBase { get; init; }
    public required string IntegrationBase { get; init; }
    public required string SessionPath { get; init; }
    public SourceReadGrant? SourceGrant { get; init; }
    public string State { get; init; } = "preparing";
    public WorkspaceApp[] Apps { get; init; } = [];
    public WorkspaceOperation[] Operations { get; init; } = [];
    public string[] Leases { get; init; } = [];
    public string[] PullRequests { get; init; } = [];
    public WorkspaceObservation? Observation { get; init; }
}
internal sealed record WorkspaceList(DevelopmentWorkspace[] Workspaces);
