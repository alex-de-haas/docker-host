namespace Haas.Hosty.Core;

// A read projection, deliberately excluding source credentials, transcripts and replay command bodies.
internal sealed record WorkspaceInventory(InspectedWorkspace[] Workspaces, DateTimeOffset ObservedAt);
internal sealed record InspectedWorkspace(string Id, string State, InspectionOwner Owner, InspectedWorktree[] Worktrees);
internal sealed record InspectionOwner(string Kind, string Label, string Reference, string? AppId, string? SessionUrl, string? SessionUnavailable);
internal sealed record WorkspaceDestination(string? Url, string? Unavailable);
internal sealed record InspectionApp(string AppId, string Name, string? Subpath, bool Installed);
internal sealed record InspectionOperation(string Id, string Kind, string State, string? Error);
internal sealed record InspectionCommit(string Sha, string Author, string At, string Subject);
internal sealed record InspectionConsumer(string Kind, string Reference);
internal sealed record InspectionPullRequest(string Url, string? PublishedHead, PublicationObservation? Observation, string? Unavailable);
internal sealed record InspectedWorktree(string Id, string WorkspaceId, string Repository, string Branch, string TargetBranch,
    string OriginalBase, string IntegrationBase, string Path, string State, InspectionApp[] Apps,
    WorkspaceObservation? Observation, InspectionOperation[] Operations, string[] Leases,
    InspectionPullRequest[] PullRequests, InspectionConsumer[] Consumers, InspectionCommit[] Commits,
    bool CommitsTruncated = false, string? DetailError = null)
{
    public AppSourceFile[] SessionChanges { get; init; } = [];
}
