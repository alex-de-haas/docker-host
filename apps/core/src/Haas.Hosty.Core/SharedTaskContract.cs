// Platform-owned wire types; linked into HostySdk.App so Core and .NET applications share v1.
using System.Text.Json.Serialization;

namespace HostySdk.App;

/// <summary>An explicitly selected provider installation and interface.</summary>
public record HostyTaskProviderRef(string AppId, string InstallationId, string Key);
/// <summary>A task UUID qualified by its supplying installation; Number is never an identifier.</summary>
public record HostyTaskRef(string AppId, string InstallationId, string Key, string Id);
/// <summary>A live reference or a pinned revision, without copied content or access authority.</summary>
public record HostyTaskResourceVersion(string Mode, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Revision = null);
/// <summary>An app, workspace or external material reference. It grants no execution authority.</summary>
public record HostyTaskResource(string Kind, string Owner, string Id, HostyTaskResourceVersion Version, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Label = null);
/// <summary>An opaque executor option or prepared configuration at its exact revision.</summary>
public record HostyTaskSelection(string Kind, string Id, long Revision);
/// <summary>A human user or an application with an executor-owned selection.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public record HostyTaskAssignee(string Kind, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? UserId = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskProviderRef? Executor = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskSelection? Selection = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Name = null);
/// <summary>Review by nobody, the owner, or the current delegator.</summary>
public record HostyTaskReview(string Mode);
/// <summary>Universal work inputs. Source, profiles and sessions are owned by executors.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public record HostyTaskInput(string Title, string Markdown,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] HostyTaskAssignee? Assignee, HostyTaskResource[] Resources,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskReview? Review = null,
    HostyTaskRef? ParentTaskRef = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskRef[]? DependsOn = null);
/// <summary>Authenticated attribution supplied by the transport, never the model.</summary>
public record HostyTaskActor(string? UserId, string? AppId, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? InstallationId = null);
/// <summary>An explicit business outcome, distinct from completion of a model turn.</summary>
public record HostyTaskResult(string Markdown, HostyTaskResource[] Resources);
/// <summary>Exact result identity; human outcomes have a null execution ID.</summary>
public record HostyTaskOutcomeRef(HostyTaskRef TaskRef, long InputRevision, [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? ExecutionId, long ResultRevision);
/// <summary>Immutable content with no credentials or source authority.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public record HostyTaskExecutionContent(string Title, string Markdown, HostyTaskResource[] Resources, HostyTaskReview Review);
/// <summary>The ancestry admitted with this attempt.</summary>
public record HostyTaskRelations(HostyTaskRef RootTaskRef, [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] HostyTaskRef? ParentTaskRef, long RelationRevision);
/// <summary>The immutable acceptance payload for one durable execution ID.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public record HostyTaskExecutionInput(int Version, HostyTaskRef TaskRef, long InputRevision, HostyTaskExecutionContent Content,
    HostyTaskRelations Relations, HostyTaskOutcomeRef[] PrerequisiteOutcomes,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskSelection? Selection = null);
/// <summary>An execution failure with a stable code.</summary>
public record HostyTaskExecutionError(string Code, string Message);
/// <summary>A private session link whose destination enforces access.</summary>
public record HostyTaskSessionRef(string Id, string Path);
/// <summary>A wait observation, never a grant to resume.</summary>
public record HostyTaskExecutionWait(string Kind, string Reference);
/// <summary>Terminal state alone does not establish native stop confirmation.</summary>
public record HostyTaskExecutionReceipt(string ExecutionId, long Revision, string State, bool StopConfirmed, string CreatedAt, string UpdatedAt,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskResult? Result = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskExecutionError? Error = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskSessionRef? SessionRef = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? NativeStopConfirmed = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskExecutionWait? Wait = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskOutcomeRef[]? ChildOutcomes = null);
/// <summary>One immutable attempt, retained through retries and rework.</summary>
public record HostyTaskAttempt(string ExecutionId, HostyTaskProviderRef Executor, HostyTaskExecutionInput Request, bool CancelRequested,
    string CreatedAt, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskExecutionReceipt? Receipt = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? Invalidated = null);
/// <summary>Why work is waiting or requires intervention.</summary>
public record HostyTaskBlocked(string Reason, string Message);
/// <summary>An outcome retained when current work is reopened or superseded.</summary>
public record HostyTaskOutcome(HostyTaskOutcomeRef Ref, HostyTaskResult Result, string RecordedAt,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskOutcomeRef[]? ChildOutcomes = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? AcceptedAt = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? Invalidated = null);
/// <summary>Explicit disposition of a stopped child, with rationale and replacement tasks.</summary>
public record HostyTaskDisposition(string Kind, string Reason, HostyTaskRef[] ReplacementRefs);
/// <summary>A provider-owned task with computed ancestry and retained execution history.</summary>
public record HostyTaskCoordination(long RootGeneration, long CoordinatorEpoch, string ExecutionId);
/// <summary>Recoverable removal metadata; source and execution history remain intact.</summary>
public record HostyTaskRemoval(string BatchId, string At, HostyTaskActor By);
/// <summary>One explicitly reviewed task and revision in a removal or restoration scope.</summary>
public record HostyTaskRemovalTarget(HostyTaskRef TaskRef, long Revision);
/// <summary>Provider-owned task and optional coordinated execution identity.</summary>
public record HostyTaskRecord(HostyTaskRef Ref, string Number, long Revision, long InputRevision, string Status, string Title, string Markdown,
    HostyTaskAssignee? Assignee, HostyTaskReview Review, HostyTaskResource[] Resources, HostyTaskActor CreatedBy, HostyTaskActor Owner,
    string CreatedAt, string UpdatedAt, bool CancelRequested, HostyTaskAttempt[] Attempts,
    HostyTaskRef RootTaskRef, HostyTaskRef? ParentTaskRef, HostyTaskRef[] DependsOn, int Depth, long RelationRevision, long GraphRevision, bool Armed,
    HostyTaskOutcome[] Outcomes,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskBlocked? Blocked = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskResult? Result = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskOutcomeRef? ResultRef = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskOutcomeRef? AcceptedResultRef = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskDisposition? Disposition = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskCoordination? Coordination = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskRemoval? Removed = null);
/// <summary>Idempotent creation; retain the request ID after an uncertain response.</summary>
public record HostyTaskCreate(string RequestId, HostyTaskInput Input, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? ExpectedGraphRevision = null);
/// <summary>Optimistic replacement of stopped Draft inputs and prerequisites.</summary>
public record HostyTaskEdit(string RequestId, long ExpectedRevision, HostyTaskInput Input, long ExpectedGraphRevision);
/// <summary>A replayable lifecycle or exact-result review operation.</summary>
public record HostyTaskAction(string RequestId, long ExpectedRevision, string Action,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskResult? Result = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskOutcomeRef? ResultRef = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Feedback = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskSelection? Selection = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskDisposition? Disposition = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskCoordination? Coordination = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskRemovalTarget[]? RemovalScope = null);
/// <summary>A bounded task page and opaque continuation cursor.</summary>
public record HostyTaskPage(HostyTaskRecord[] Tasks, string? NextCursor);
/// <summary>A retained mutation response scoped to its authenticated origin.</summary>
public record HostyTaskRequestReceipt(string RequestId, string State, HostyTaskRef TaskRef, HostyTaskRecord Result);
/// <summary>Display prefix, common states and separately advertised optional capabilities.</summary>
public record HostyTaskCapabilities(int Version, string Prefix, string[] Statuses, int MaxPageSize,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string[]? Capabilities = null);
/// <summary>Advisory discovery status. Admission checks current authority and availability.</summary>
public record HostyTaskExecutorAvailability(string State, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Reason = null);
/// <summary>An opaque revision-qualified option with a bounded discoverable description.</summary>
public record HostyTaskExecutorOption(string Id, long Revision, string Name, string Description, string[] Capabilities, HostyTaskExecutorAvailability Availability);
/// <summary>Executor-owned options and an optional default selection.</summary>
public record HostyTaskExecutorOptions(int Version, long Revision, HostyTaskExecutorOption[] Options, string? DefaultId);

/// <summary>A non-secret retained dispatch reference, restricted to its bound installations.</summary>
public record HostyTaskDispatchRef(string UserId, string PrincipalId, string RequestId);
/// <summary>Retained execution authority; source bindings are independent from task content.</summary>
public record HostyTaskDispatchScope(HostyTaskRef TaskRef, HostyTaskProviderRef Executor, long InputRevision,
    string InputHash, HostyTaskSelection? Selection, string? ExecutionId,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? WorkspaceId = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ExecutionHash = null);
/// <summary>Exact source task and attempt responsible for a mediated executor invocation.</summary>
public record HostyTaskExecutorDelegation(HostyTaskDispatchRef Dispatch, HostyTaskRef TaskRef, string? ExecutionId);
/// <summary>A bounded operation against retained original execution authorization.</summary>
public record HostyTaskDispatchRequest(HostyTaskDispatchRef Dispatch, HostyTaskProviderRef Executor, string Operation,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ExecutionId = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskExecutionInput? Input = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? RequestId = null);
/// <summary>Observation revalidates original authority and both installations.</summary>
public record HostyTaskDispatchAuthority(HostyTaskDispatchRef Dispatch, HostyTaskDispatchScope Scope);
/// <summary>Native activity reported by the owner after verified admission or stop.</summary>
public record HostyTaskWorkspaceActivity(string Status, string LeaseId, bool Stopped = false,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Title = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? Sequence = null);
/// <summary>Access a workspace separately authorized for this execution.</summary>
public record HostyTaskWorkspaceRequest(HostyTaskDispatchRef Dispatch, string ExecutionId, string SessionId,
    string LeaseId, string Kind, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? RequestId = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? ExpectedRevision = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Title = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? NavigationPath = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskWorkspaceActivity? Activity = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskSourceReference? Source = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskRef? TaskRef = null);

/// <summary>Execution source authority, separate from common task input.</summary>
public record HostyTaskSourceReference(HostyTaskDispatchRef RootDispatch, string ContextId, long ContextRevision, string WorkspaceId);
