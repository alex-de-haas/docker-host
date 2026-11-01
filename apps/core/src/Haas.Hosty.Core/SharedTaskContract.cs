// Platform-owned wire types; linked into HostySdk.App so Core and .NET applications share v1.
using System.Text.Json.Serialization;

namespace HostySdk.App;

/// <summary>An explicitly selected provider installation and interface.</summary>
public record HostyTaskProviderRef(string AppId, string InstallationId, string Key);
/// <summary>A task UUID qualified by its supplying installation; Number is never an identifier.</summary>
public record HostyTaskRef(string AppId, string InstallationId, string Key, string Id);
/// <summary>A live reference or a pinned revision, without copied content or access authority.</summary>
public record HostyTaskResourceVersion(string Mode, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Revision = null);
/// <summary>An app, existing workspace, or external material owned outside the task store.</summary>
public record HostyTaskResource(string Kind, string Owner, string Id, HostyTaskResourceVersion Version, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Label = null);
/// <summary>A human user or an application with an opaque executor option.</summary>
public record HostyTaskAssignee(string Kind, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? UserId = null, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskProviderRef? Executor = null, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? OptionId = null, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Name = null);
/// <summary>Task work description and explicit, optional existing resources.</summary>
public record HostyTaskInput(string Title, string Markdown,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] HostyTaskAssignee? Assignee, HostyTaskResource[] Resources, bool RequiresReview = false, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? WorkspaceId = null);
/// <summary>Authenticated attribution, supplied by the server rather than trusted from request bodies.</summary>
public record HostyTaskActor(string? UserId, string? AppId, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? InstallationId = null);
/// <summary>An explicit task outcome, distinct from completion of a model turn.</summary>
public record HostyTaskResult(string Markdown, HostyTaskResource[] Resources);
/// <summary>Immutable execution inputs; no profile configuration or credentials.</summary>
public record HostyTaskExecutionContent(string Title, string Markdown, HostyTaskResource[] Resources, bool RequiresReview = false, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? WorkspaceId = null);
/// <summary>The acceptance payload for one durable execution ID.</summary>
public record HostyTaskExecutionInput(HostyTaskRef TaskRef, long TaskRevision, HostyTaskExecutionContent Input, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ExecutorOptionId = null);
/// <summary>An execution failure with a stable code.</summary>
public record HostyTaskExecutionError(string Code, string Message);
/// <summary>An optional private session link; the destination enforces its own access policy.</summary>
public record HostyTaskSessionRef(string Id, string Path);
/// <summary>Durable execution observation. Terminal state alone does not establish stop confirmation.</summary>
public record HostyTaskExecutionReceipt(string ExecutionId, long Revision, string State, bool StopConfirmed, string CreatedAt, string UpdatedAt,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskResult? Result = null, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskExecutionError? Error = null, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskSessionRef? SessionRef = null);
/// <summary>One immutable attempt, retained across rework and reopening.</summary>
public record HostyTaskAttempt(string ExecutionId, HostyTaskProviderRef Executor, HostyTaskExecutionInput Request, bool CancelRequested,
    string CreatedAt, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskExecutionReceipt? Receipt = null);
/// <summary>Why a task requires explicit intervention.</summary>
public record HostyTaskBlocked(string Reason, string Message);
/// <summary>An explicit outcome retained when a task is reworked or reopened.</summary>
public record HostyTaskOutcome(long InputRevision, HostyTaskResult Result, string RecordedAt, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ExecutionId = null);
/// <summary>A provider-owned task. Status is one of the six common v1 states.</summary>
public record HostyTaskRecord(HostyTaskRef Ref, string Number, long Revision, long InputRevision, string Status, string Title, string Markdown,
    HostyTaskAssignee? Assignee, bool RequiresReview, HostyTaskResource[] Resources, HostyTaskActor CreatedBy, HostyTaskActor Owner,
    string CreatedAt, string UpdatedAt, bool CancelRequested, HostyTaskAttempt[] Attempts, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? WorkspaceId = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskBlocked? Blocked = null, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskResult? Result = null, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? ResultInputRevision = null, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskOutcome[]? Outcomes = null);
/// <summary>Idempotent creation; retain RequestId when a reply is lost.</summary>
public record HostyTaskCreate(string RequestId, HostyTaskInput Input);
/// <summary>Optimistic full replacement of editable Draft inputs.</summary>
public record HostyTaskEdit(string RequestId, long ExpectedRevision, HostyTaskInput Input);
/// <summary>A replayable lifecycle or review operation.</summary>
public record HostyTaskAction(string RequestId, long ExpectedRevision, string Action, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskResult? Result = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? ResultInputRevision = null, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Feedback = null);
/// <summary>A bounded page and an opaque continuation cursor.</summary>
public record HostyTaskPage(HostyTaskRecord[] Tasks, string? NextCursor);
/// <summary>The provider's display prefix and common task capabilities.</summary>
public record HostyTaskCapabilities(int Version, string Prefix, string[] Statuses, int MaxPageSize);
/// <summary>An executor-owned opaque selection. This is not a shared agent profile.</summary>
public record HostyTaskExecutorOption(string Id, string Name, string[] Capabilities);
/// <summary>Selectable executor options and an optional default for new work.</summary>
public record HostyTaskExecutorOptions(HostyTaskExecutorOption[] Options, string? DefaultId);

/// <summary>A non-secret receipt reference, usable only by the bound provider installations.</summary>
public record HostyTaskDispatchRef(string UserId, string PrincipalId, string RequestId);
/// <summary>Immutable task execution authority; content remains at the source provider.</summary>
public record HostyTaskDispatchScope(HostyTaskRef TaskRef, HostyTaskProviderRef Executor, long InputRevision,
    string InputHash, string? OptionId, string? ExecutionId, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? WorkspaceId = null);
/// <summary>The task provider and exact attempt responsible for a mediated executor invocation.</summary>
public record HostyTaskExecutorDelegation(HostyTaskDispatchRef Dispatch, HostyTaskRef TaskRef, string? ExecutionId);
/// <summary>A bounded child operation against the retained original execution authorization.</summary>
public record HostyTaskDispatchRequest(HostyTaskDispatchRef Dispatch, HostyTaskProviderRef Executor, string Operation,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ExecutionId = null, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskExecutionInput? Input = null, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? RequestId = null);
/// <summary>Current dispatch scope; observation revalidates original authority and both installations.</summary>
public record HostyTaskDispatchAuthority(HostyTaskDispatchRef Dispatch, HostyTaskDispatchScope Scope);

/// <summary>Native activity reported by the owning task executor after verified admission or stop.</summary>
public record HostyTaskWorkspaceActivity(string Status, string LeaseId, bool Stopped = false, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Title = null, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? Sequence = null);
/// <summary>Access only the existing workspace selected by the accepted task attempt.</summary>
public record HostyTaskWorkspaceRequest(HostyTaskDispatchRef Dispatch, string ExecutionId, string SessionId,
    string LeaseId, string Kind, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? RequestId = null, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? ExpectedRevision = null, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Title = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? NavigationPath = null, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskWorkspaceActivity? Activity = null);
