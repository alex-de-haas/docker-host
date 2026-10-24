using System.Text.Json.Serialization;

namespace Haas.Hosty.Core;

internal sealed record PublicationPolicy(string[] RequiredChecks, long[] RequiredWorkflows, PublicationArtifact[] Artifacts);
internal sealed record PublicationArtifact(string? Tag = null, string? Asset = null, string Kind = "release", string? Package = null, string? Version = null);
internal sealed record PublicationCommand(string RequestId, string? ExpectedHead = null, string? ConnectionId = null,
    string? Title = null, string? Body = null, bool Draft = true, bool Fork = false, int? Number = null,
    string? MergeMethod = null, string? Outcome = null, bool Cleanup = false,
    PublicationPolicy? Policy = null, string[]? Dependencies = null, string? Message = null, string[]? Paths = null, string[]? Contributors = null, string? ThreadId = null);
internal sealed record PublicationReviewComment(string Id, string Body, string? AuthorLogin = null,
    string? AuthorKind = null, DateTimeOffset? CreatedAt = null, string? Url = null, long? DatabaseId = null);
internal sealed record PublicationReview(string Id, string? Path, int? Line, bool Resolved, string[] Comments,
    int? OriginalLine = null, int? StartLine = null, int? OriginalStartLine = null,
    string? DiffSide = null, string? StartDiffSide = null, bool Outdated = false, string? SubjectType = null,
    bool CommentsComplete = true, PublicationReviewComment[]? Details = null);
internal sealed record PublicationReviewCommand(string RequestId, string PullRequestUrl, string ExpectedHead,
    string ThreadId = "", string? ConnectionId = null, string? Body = null, bool AuthorIntent = false,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Path = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? DiffSide = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? StartLine = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? Line = null);
internal sealed record PublicationReviewCommentCreated(string ThreadId, string CommentId);
internal sealed record PublicationReviewResult(string RequestId, string Kind, string State, string ThreadId,
    string? CommentId = null, string? Error = null, PublicationObservation? Observation = null);
internal sealed record PublicationReviewOperation(string RequestId, string Fingerprint, string UserId,
    string ConnectionId, string Repository, string PullRequestUrl, string Kind, string ExpectedHead,
    string ThreadId, string State, bool MutationStarted = false, string? CommentId = null, string? Error = null);
internal sealed record PublicationReviewJournal(string WorkspaceId, WorkspaceOwner Owner,
    PublicationReviewOperation[] Operations);
internal sealed record PublicationReviewFile(string Path, string Status, string? PreviousPath, string? Patch,
    int Additions, int Deletions, bool Binary = false);
internal sealed record PublicationReviewSnapshot(string Url, string Repository, string BaseBranch,
    string Base, string MergeBase, string Head, PublicationObservation Observation,
    PublicationReviewFile[] Files, bool Truncated = false);
internal sealed record PublicationCheck(string Name, string State);
internal sealed record PublicationObservation(DateTimeOffset At, string State, string? Head = null,
    string? Base = null, string? MergeCommit = null, bool Draft = false, string? MergeState = null,
    string? ReviewDecision = null, int UnresolvedThreads = 0, bool Complete = false,
    PublicationCheck[]? Checks = null, string? Error = null, PublicationReview[]? Reviews = null,
    string? Title = null, int? CommentCount = null, string? BaseHead = null, DateTimeOffset? MergedAt = null);
internal sealed record PublicationOperation(string Id, string Kind, string Fingerprint, string State,
    PublicationCommand Input, string? Error = null, PublicationIdentity? Author = null);
internal sealed record PublicationRecord
{
    public string Provider { get; init; } = "github";
    public required string WorkspaceId { get; init; }
    public required WorkspaceOwner Owner { get; init; }
    public required string Repository { get; init; }
    public required string ConnectionId { get; init; }
    public required string HeadRepository { get; init; }
    public required string Branch { get; init; }
    public required string TargetBranch { get; init; }
    public PublicationPolicy Policy { get; init; } = new([], [], []);
    public string[] Contributors { get; init; } = [];
    public string[] Dependencies { get; init; } = [];
    public int? Number { get; init; }
    public string? Url { get; init; }
    public string? PublishedHead { get; init; }
    public bool CleanupRequested { get; init; }
    public string? Outcome { get; init; }
    public DateTimeOffset? CompletedAt { get; init; }
    public PublicationObservation? Observation { get; init; }
    public PublicationOperation[] Operations { get; init; } = [];
    public PublicationReference[] History { get; init; } = [];
}
internal sealed record PublicationReference(int Number, string Url, string? Head, string? MergeCommit,
    PublicationObservation? Observation = null);
internal sealed record PublicationList(PublicationRecord[] Publications);
internal sealed record PublicationConnections(UserConnectionSummary[] Connections);
internal sealed record PublicationIdentity(string Name, string Email);
internal sealed class PublicationException(string code, string message) : Exception(message)
{
    public string Code { get; } = "publication_" + code;
}
internal interface IPublicationProvider
{
    string NormalizeRepository(string url);
    string PullRequestUrl(string repository, int number);
    Task<string> DestinationAsync(UserProviderConnection connection, string repository, bool fork, CancellationToken ct);
    Task PushAsync(UserProviderConnection connection, DevelopmentWorkspace workspace, string destination, string branch, string head, CancellationToken ct);
    Task<PublicationReference?> FindAsync(UserProviderConnection connection, PublicationRecord record, CancellationToken ct);
    Task<PublicationReference> PublishAsync(UserProviderConnection connection, PublicationRecord record, PublicationCommand input, CancellationToken ct);
    Task<PublicationObservation> ObserveAsync(UserProviderConnection connection, PublicationRecord record, CancellationToken ct);
    // Linked-reference display is not exact-workspace publication or cleanup evidence.
    Task<PublicationObservation> ObserveReferenceAsync(UserProviderConnection connection, PublicationRecord record, CancellationToken ct)
        => throw new PublicationException("provider_unsupported", "This source provider does not support linked PR observations.");
    Task MergeAsync(UserProviderConnection connection, PublicationRecord record, string head, string method, CancellationToken ct);
    Task ReadyAsync(UserProviderConnection connection, PublicationRecord record, CancellationToken ct);
    Task ResolveReviewAsync(UserProviderConnection connection, PublicationRecord record, string threadId, string head, CancellationToken ct);
    Task ResolveReviewAsync(UserProviderConnection connection, PublicationRecord record, string threadId, string head,
        Func<Task> admitMutation, CancellationToken ct)
        => throw new PublicationException("provider_unsupported", "This source provider does not support review resolution admission.");
    Task<PublicationReviewSnapshot> ReadReviewSnapshotAsync(UserProviderConnection connection, PublicationRecord record, CancellationToken ct)
        => throw new PublicationException("provider_unsupported", "This source provider does not support PR review snapshots.");
    Task<string> ReplyReviewAsync(UserProviderConnection connection, PublicationRecord record, string threadId,
        string head, string body, string marker, bool recoverOnly, Func<Task> admitMutation, CancellationToken ct)
        => throw new PublicationException("provider_unsupported", "This source provider does not support review replies.");
    Task<PublicationReviewCommentCreated> CreateReviewCommentAsync(UserProviderConnection connection, PublicationRecord record,
        PublicationReviewCommand command, string marker, bool recoverOnly, Func<Task> admitMutation, CancellationToken ct)
        => throw new PublicationException("provider_unsupported", "This source provider does not support new review comments.");
    Task<PublicationIdentity> IdentityAsync(UserProviderConnection connection, CancellationToken ct);
}
