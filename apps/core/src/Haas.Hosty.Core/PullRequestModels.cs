namespace Haas.Hosty.Core;

// These are display facts, never publication completion or merge authority.
internal sealed record PullRequestReceipt(string Revision, DateTimeOffset? ObservedAt = null,
    DateTimeOffset? LastSuccessAt = null, DateTimeOffset? NextAttemptAt = null,
    string Freshness = "refreshing", string Completeness = "unknown", string? Reason = null, int SchemaVersion = 1);
internal sealed record PullRequestApp(string Id, string Name);
internal sealed record PullRequestRepository(string Id, string Provider, string Name, string Url,
    PullRequestApp[] Apps, PullRequestReceipt Receipt);
internal sealed record PullRequestCoverage(PullRequestApp[] Apps, string State, string Message);
internal sealed record PullRequestRepositories(PullRequestRepository[] Repositories, PullRequestCoverage[] Coverage, PullRequestReceipt Receipt, string StorageScope);
internal sealed record PullRequestRef(string RepositoryId, int Number);
internal sealed record PullRequestCheck(string Id, string Name, string State, string? Url);
internal sealed record PullRequestChecks(PullRequestCheck[] Items, int? Total, string Completeness, string? Cursor = null);
internal sealed record PullRequestSummary(string RepositoryId, int Number, string ProviderId, string Title,
    string Url, string Author, bool Bot, bool Draft, string State, DateTimeOffset UpdatedAt,
    string Head, string Base, string HeadBranch, string BaseBranch, string ReviewDecision,
    string MergeState, int? CommentCount, PullRequestChecks Checks, PullRequestReceipt Receipt, string? HeadRepository = null)
{
    public PullRequestContextReference Reference => new(1, "github", "github.com", RepositoryId, Number, ProviderId, Url, Head, Receipt.Revision);
}
// Domain-neutral references can also describe game positions or delegated task results.
internal sealed record ObservationResourceReference(int SchemaVersion, string Kind, string Id, string? Revision = null);
internal sealed record ObservationInvalidation(ObservationResourceReference Subject, string Reason);
internal sealed record PullRequestContextReference(int SchemaVersion, string Provider, string Host, string RepositoryId,
    int Number, string ProviderId, string Url, string Head, string ObservationRevision);
internal sealed record PullRequestPage(PullRequestSummary[] Items, string? Cursor, int Loaded,
    int? Total, PullRequestReceipt Receipt);
internal sealed record PullRequestDetail(PullRequestSummary PullRequest, string? Description,
    bool DescriptionTruncated, PullRequestRelatedLink[] Links, PullRequestReceipt Receipt);
internal sealed record PullRequestRelatedLink(string Kind, string Id, string Label);
internal sealed record PullRequestReviewItem(string Id, string Author, string State, string? Body, string? Url);
internal sealed record PullRequestReview(PullRequestReviewItem[] Items, int? Total, string? Cursor, PullRequestReceipt Receipt);
internal sealed record PullRequestDiff(string Head, string Base, string MergeBase,
    PublicationReviewFile[] Files, PullRequestReceipt Receipt);
internal sealed record PullRequestScope(bool AllInstalled = false, string[]? Repositories = null,
    PullRequestRef[]? PullRequests = null, string[]? Workspaces = null);
internal sealed record PullRequestSubscription(string Id, DateTimeOffset ExpiresAt);
internal sealed record PullRequestRefresh(string RequestId, string[]? Repositories = null, PullRequestRef[]? PullRequests = null);
internal sealed record PullRequestRefreshResult(string State, DateTimeOffset? NextAttemptAt);
internal sealed record PullRequestChanged(string Revision, string[] Repositories, PullRequestRef[] PullRequests);
internal sealed record PullRequestQuery(string? Repository = null, string? App = null, string? Author = null,
    bool? Bot = null, bool? Draft = null, string? Ci = null, string? Review = null,
    string? Search = null, int Limit = 50, string? Cursor = null);
internal sealed record PullRequestActor(string UserId, string? AppId = null, DateTimeOffset? Installation = null)
{
    public string Key => UserId + "/" + AppId + "/" + Installation?.ToString("O");
}
internal sealed class PullRequestException(string code, string message, int status = 409,
    DateTimeOffset? retryAt = null) : Exception(message)
{
    public string Code { get; } = code;
    public int Status { get; } = status;
    public DateTimeOffset? RetryAt { get; } = retryAt;
}

internal sealed record PullRequestRemoteRepository(string ProviderId, string Name, string Url);
internal sealed record PullRequestRemotePage(PullRequestSummary[] Items, string? ETag, bool NotModified, bool HasNext);
internal sealed record PullRequestRemoteDetail(PullRequestSummary Summary, string Description, bool Truncated);
internal interface IPullRequestProvider
{
    Task<PullRequestRemoteRepository> RepositoryAsync(UserProviderConnection connection, string repository, CancellationToken ct);
    Task<PullRequestRemotePage> ListPullRequestsAsync(UserProviderConnection connection, string repository,
        string repositoryId, int page, string? etag, CancellationToken ct);
    Task<PullRequestSummary[]> ReadPullRequestsAsync(UserProviderConnection connection, string repository,
        string repositoryId, int[] numbers, CancellationToken ct);
    Task<PullRequestRemoteDetail> ReadPullRequestAsync(UserProviderConnection connection, string repository,
        string repositoryId, int number, CancellationToken ct);
    Task<PullRequestChecks> ReadChecksAsync(UserProviderConnection connection, string repository,
        int number, string head, string? cursor, CancellationToken ct);
    Task<PullRequestReview> ReadDiscussionAsync(UserProviderConnection connection, string repository,
        int number, string head, string? cursor, CancellationToken ct);
    Task<PullRequestDiff> ReadDiffAsync(UserProviderConnection connection, string repository,
        string repositoryId, int number, string head, string basis, CancellationToken ct);
}
