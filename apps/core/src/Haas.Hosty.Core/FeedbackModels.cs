namespace Haas.Hosty.Core;

internal sealed record FeedbackRect(double X, double Y, double Width, double Height);
internal sealed record FeedbackViewport(double Width, double Height, double Scale);
internal sealed record FeedbackTarget(string Kind, string? Label = null, string? Selector = null,
    FeedbackRect? Bounds = null, FeedbackViewport? Viewport = null);
internal sealed record FeedbackImage(string MediaType, string Data);
internal sealed record FeedbackNoteInput(string Id, string Text, string Route, DateTimeOffset CapturedAt,
    FeedbackTarget? Target = null, FeedbackImage? Image = null);
internal sealed record FeedbackScope(string CoreId, string AppId, string Installation, string UserId);
internal sealed record FeedbackSubmit(string RequestId, string Comment, FeedbackNoteInput[] Annotations, FeedbackScope? Scope = null);
internal sealed record FeedbackNote(string Id, string Text, string Route, DateTimeOffset CapturedAt,
    FeedbackTarget? Target, string? MediaType);
internal sealed record FeedbackObservation(string AppId, string AppName, string Installation,
    string? Version, DateTimeOffset ObservedAt, string ExecutionKind, string? WorkspaceId, string? SourceRevision);
internal sealed record FeedbackReport(string Id, string ReporterId, FeedbackObservation Context, string Comment,
    FeedbackNote[] Annotations, string? WorkspaceId, long Revision = 1, string Status = "unprocessed",
    string? CurrentAttemptId = null, string? Disposition = null);
internal sealed record FeedbackReceipt(string Id, string Fingerprint, bool Deleted = false);
internal sealed record FeedbackSelection(string Id, long Revision);
internal sealed record FeedbackDispatchInput(string RequestId, string SessionId, string? WorkspaceId,
    FeedbackSelection[] Reports, string Instruction, long AppContextRevision = 0, long SelectionRevision = 0);
internal sealed record FeedbackOutcome(string ReportId, string Summary, string[] HandledAnnotationIds, bool Handled = false);
internal sealed record FeedbackDispatch(string Id, string CallerAppId, string CallerInstallation, string ActorId,
    FeedbackDispatchInput Input, FeedbackReport[] Snapshot, DateTimeOffset CreatedAt,
    string State = "reserved", long? MessageSequence = null, string? WorkspaceId = null,
    FeedbackOutcome[]? Outcomes = null, string? Error = null);
internal sealed record FeedbackDelivery(string State, long? MessageSequence = null, string? WorkspaceId = null, string? Error = null);
internal sealed record FeedbackResults(FeedbackOutcome[] Outcomes);
internal sealed record FeedbackChange(long ExpectedRevision, string? WorkspaceId, string? Disposition = null);
internal sealed record FeedbackState(FeedbackReport[] Reports, FeedbackReceipt[] Receipts,
    FeedbackDispatch[] Dispatches, string[] DeletedWorkspaces);
internal sealed record FeedbackCollection(FeedbackReport[] Reports, FeedbackDispatch[] Dispatches);
internal sealed record FeedbackSubmissionReceipt(string Id, string Status);
internal sealed record FeedbackCapabilities(int Version, string CoreId, string AppId, string Installation, string UserId,
    int MaxAnnotations = 20, int MaxImageBytes = 2097152, int MaxTotalImageBytes = 8388608, bool Administrator = false);
internal sealed record FeedbackReviewTarget(string Label, string Href);
internal sealed record FeedbackReviewTargets(FeedbackReviewTarget[] Targets);
internal sealed class FeedbackException(string code, string message, int status = 409) : Exception(message)
{
    public string Code { get; } = code;
    public int Status { get; } = status;
}
