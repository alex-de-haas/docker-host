namespace Haas.Hosty.Core;

// Source identities are observed by Core. Browser input never supplies revisions or arbitrary refs.
internal sealed record WorkspaceReviewSource(string Scope, string Label, string Base, string Head,
    string? MergeBase, string? TargetBranch, string? PullRequestUrl, DateTimeOffset ObservedAt,
    string Revision, bool Published, string? LocalHead, bool NotPublished,
    string? PublishedComparisonUrl = null, string? PublishedComparisonHead = null);
internal sealed record WorkspaceReview(WorkspaceReviewSource Source, AppSourceFile[] Files,
    PublicationReview[] Threads, bool Truncated = false, string? Unavailable = null,
    PublicationObservation? Observation = null);
internal sealed record WorkspaceReviewLineRange(int StartLine, int EndLine);
internal sealed record WorkspaceReviewDiff(WorkspaceReviewSource Source, AppSourceDiff Diff,
    WorkspaceReviewLineRange[] LocalRanges, bool LocalRangesComplete,
    WorkspaceReviewPublishedEvidence? PublishedEvidence = null);
internal sealed record WorkspaceReviewPublishedEvidence(string PullRequestUrl, string Head, bool Complete,
    WorkspaceReviewLineRange[] UnpublishedRanges, string? Unavailable = null);
