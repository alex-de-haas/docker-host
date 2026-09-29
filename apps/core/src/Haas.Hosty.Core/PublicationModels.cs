namespace Haas.Hosty.Core;

internal sealed record PublicationPolicy(string[] RequiredChecks, long[] RequiredWorkflows, PublicationArtifact[] Artifacts);
internal sealed record PublicationArtifact(string? Tag = null, string? Asset = null, string Kind = "release", string? Package = null, string? Version = null);
internal sealed record PublicationCommand(string RequestId, string? ExpectedHead = null, string? ConnectionId = null,
    string? Title = null, string? Body = null, bool Draft = true, bool Fork = false, int? Number = null,
    string? MergeMethod = null, string? Outcome = null, bool Cleanup = false,
    PublicationPolicy? Policy = null, string[]? Dependencies = null, string? Message = null, string[]? Paths = null, string[]? Contributors = null, string? ThreadId = null);
internal sealed record PublicationReview(string Id, string? Path, int? Line, bool Resolved, string[] Comments);
internal sealed record PublicationCheck(string Name, string State);
internal sealed record PublicationObservation(DateTimeOffset At, string State, string? Head = null,
    string? Base = null, string? MergeCommit = null, bool Draft = false, string? MergeState = null,
    string? ReviewDecision = null, int UnresolvedThreads = 0, bool Complete = false,
    PublicationCheck[]? Checks = null, string? Error = null, PublicationReview[]? Reviews = null);
internal sealed record PublicationOperation(string Id, string Kind, string Fingerprint, string State,
    PublicationCommand Input, string? Error = null, PublicationIdentity? Author = null);
internal sealed record PublicationRecord
{
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
internal sealed record PublicationReference(int Number, string Url, string? Head, string? MergeCommit);
internal sealed record PublicationList(PublicationRecord[] Publications);
internal sealed record PublicationConnections(UserConnectionSummary[] Connections);
internal sealed record PublicationIdentity(string Name, string Email);
internal sealed class PublicationException(string code, string message) : Exception(message)
{
    public string Code { get; } = "publication_" + code;
}
internal interface IPublicationProvider
{
    Task<string> DestinationAsync(UserProviderConnection connection, string repository, bool fork, CancellationToken ct);
    Task PushAsync(UserProviderConnection connection, DevelopmentWorkspace workspace, string destination, string branch, string head, CancellationToken ct);
    Task<PublicationReference?> FindAsync(UserProviderConnection connection, PublicationRecord record, CancellationToken ct);
    Task<PublicationReference> PublishAsync(UserProviderConnection connection, PublicationRecord record, PublicationCommand input, CancellationToken ct);
    Task<PublicationObservation> ObserveAsync(UserProviderConnection connection, PublicationRecord record, CancellationToken ct);
    Task MergeAsync(UserProviderConnection connection, PublicationRecord record, string head, string method, CancellationToken ct);
    Task ReadyAsync(UserProviderConnection connection, PublicationRecord record, CancellationToken ct);
    Task ResolveReviewAsync(UserProviderConnection connection, PublicationRecord record, string threadId, string head, CancellationToken ct);
    Task<PublicationIdentity> IdentityAsync(UserProviderConnection connection, CancellationToken ct);
}
