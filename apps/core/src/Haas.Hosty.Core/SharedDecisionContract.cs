// Platform-owned wire contracts, linked into the .NET SDK.
namespace HostySdk.App;

// Decisions are addressed input, never installation, tool, or task-review authorization.
/// <summary>Version-one decision option contract.</summary>
public sealed record HostyDecisionOption(string Id, string Label, string? Description = null);
/// <summary>Version-one decision question contract.</summary>
public sealed record HostyDecisionQuestion(string Id, string Question, IReadOnlyList<HostyDecisionOption>? Options = null,
    bool AllowText = true, bool Multiple = false, string? Header = null);
/// <summary>Version-one decision reference contract.</summary>
public sealed record HostyDecisionReference(string Kind, string Id, string? Revision = null);
/// <summary>Version-one decision input contract.</summary>
public sealed record HostyDecisionInput(string CorrelationKey, string Title, IReadOnlyList<HostyDecisionQuestion> Questions,
    string? Reason = null, HostyDecisionReference? Subject = null, HostyDecisionReference? Task = null,
    IReadOnlyList<HostyDecisionReference>? Materials = null, string? OriginPath = null, string? WaitReference = null,
    DateTimeOffset? ExpiresAt = null, string? PredecessorId = null);
/// <summary>Version-one decision create contract.</summary>
public sealed record HostyDecisionCreate(string RequestId, HostyDecisionInput Input);
/// <summary>Version-one decision answer contract.</summary>
public sealed record HostyDecisionAnswer(IReadOnlyList<string>? OptionIds = null, string? Text = null);
/// <summary>Version-one decision resolve contract.</summary>
public sealed record HostyDecisionResolve(string RequestId, long ExpectedRevision, IReadOnlyDictionary<string, HostyDecisionAnswer> Answers);
/// <summary>Version-one decision withdraw contract.</summary>
public sealed record HostyDecisionWithdraw(string RequestId, long ExpectedRevision, string Reason, string? CurrentSubjectRevision = null, bool RemoveContent = false);
/// <summary>Version-one decision ack contract.</summary>
public sealed record HostyDecisionAck(string RequestId, long ResolutionRevision);
/// <summary>Version-one decision continue contract.</summary>
public sealed record HostyDecisionContinue(string RequestId, string CommandId, long ExpectedRevision, string State,
    string? Reason = null, string? Outcome = null);
/// <summary>Version-one decision query contract.</summary>
public sealed record HostyDecisionQuery(string? Cursor = null, int Limit = 50, string? State = null,
    string? Subject = null, string? Task = null);
/// <summary>Version-one decision resolution contract.</summary>
public sealed record HostyDecisionResolution(long Revision, string UserId, string PrincipalId,
    IReadOnlyDictionary<string, HostyDecisionAnswer> Answers, DateTimeOffset AnsweredAt);
/// <summary>Version-one decision continuation contract.</summary>
public sealed record HostyDecisionContinuation(long Revision, string? CommandId, string State,
    DateTimeOffset UpdatedAt, string? Reason = null, string? Outcome = null);
/// <summary>Version-one decision delivery contract.</summary>
public sealed record HostyDecisionDelivery(long ResolutionRevision, DateTimeOffset? ReceivedAt = null);
/// <summary>Version-one decision record contract.</summary>
public sealed record HostyDecisionRecord(string Id, long Sequence, long Revision, string UserId, string CorrelationHash,
    string? SourceAppId, DateTimeOffset? SourceInstallation, string SourcePrincipal, HostyDecisionInput? Input,
    string State, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, HostyDecisionResolution? Resolution = null,
    HostyDecisionDelivery? Delivery = null, HostyDecisionContinuation? Continuation = null, string? Reason = null,
    DateTimeOffset? ContentRemovedAt = null);
/// <summary>Version-one decision page contract.</summary>
public sealed record HostyDecisionPage(IReadOnlyList<HostyDecisionRecord> Items, int PendingCount, string? Cursor);
