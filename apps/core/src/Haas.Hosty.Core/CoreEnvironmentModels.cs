namespace Haas.Hosty.Core;

internal sealed record CoreEnvironmentCreate(string RequestId, string Label, string Mode = "current",
    string? ProjectPath = null, SandboxContext? Context = null, string[]? WorktreeIds = null, [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] CoreEnvironmentLimits? Limits = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] Haas.Hosty.Initialization.InitializationRequest? Initialization = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] int? CorePort = null);
internal sealed record CoreEnvironmentCommand(string RequestId, long ExpectedRevision);
internal sealed record CoreEnvironmentProcess(int Pid, DateTimeOffset StartedAt, string? Version = null);
internal sealed record CoreEnvironmentOperation(string Id, string Kind, string Fingerprint, string State, string? Error = null);
internal sealed record CoreEnvironmentRecord(string Id, SandboxActor Owner, CoreEnvironmentCreate Request,
    string Fingerprint, int Port, long Revision, string State, DateTimeOffset CreatedAt,
    CoreEnvironmentProcess? Process = null, string? Executable = null, string? Error = null,
    IReadOnlyList<CoreEnvironmentOperation>? Operations = null, bool RootDeletionStarted = false,
    string[]? CleanupOwners = null, CoreEnvironmentUsage? Usage = null, CoreEnvironmentConsent? Consent = null, bool OperatorApproved = false, bool HasStarted = false,
    string? ObservedCoreVersion = null);
internal sealed record CoreEnvironmentView(string Id, string Label, string Mode, string? ProjectPath,
    SandboxContext? Context, string State, long Revision, int Port, string? DataRoot, string PreviewUrl,
    CoreEnvironmentProcess? Process, string? Error, IReadOnlyList<CoreEnvironmentOperation> Operations,
    CoreEnvironmentLimits? Limits = null, CoreEnvironmentUsage? Usage = null, CoreEnvironmentEffectiveAccess? Access = null, bool InitializationRequested = false,
    string? CoreVersion = null);
internal sealed record CoreEnvironmentList(IReadOnlyList<CoreEnvironmentView> Environments, IReadOnlyList<CoreEnvironmentSavedConsent>? Consents = null);
internal sealed record CoreEnvironmentSetup(string Email, string DisplayName, string Password);
internal sealed record CoreEnvironmentApiRequest(string Method, string Path, System.Text.Json.JsonElement? Body = null);
internal sealed record CoreEnvironmentApiResponse(int Status, System.Text.Json.JsonElement? Body);
internal sealed record CoreEnvironmentSession(string Cookie, string Csrf);

internal interface ICoreEnvironmentRuntime
{
    Task<string> PrepareAsync(CoreEnvironmentRecord record, string root, CancellationToken ct);
    Task<CoreEnvironmentProcess?> ObserveAsync(CoreEnvironmentRecord record, string root, CancellationToken ct);
    Task StartAsync(CoreEnvironmentRecord record, string root, Func<CoreEnvironmentProcess, Task> saveProcess, CancellationToken ct);
    Task StopAsync(CoreEnvironmentRecord record, string root, bool remove, CancellationToken ct);
    Task CleanupAsync(CoreEnvironmentRecord record, string root, CancellationToken ct) => Task.CompletedTask;
    Task<CoreEnvironmentUsage?> InspectResourcesAsync(CoreEnvironmentRecord record, string root, CancellationToken ct) => Task.FromResult<CoreEnvironmentUsage?>(null);
}

internal sealed record CoreEnvironmentWorkspaceCreate(string RequestId, string Label, string WorkspaceId,
    string[] WorktreeIds, string? CoreWorktreeId = null, string? CoreProject = null);
internal sealed record CoreEnvironmentApp(string Id, string DisplayName, string? Version, string RuntimeState,
    string? Health, string? PreviewUrl, bool? RestartRequired = null,
    AppLaunchProgress? LaunchProgress = null, AppDevelopmentStatus? Development = null,
    string? ManifestError = null, string? LastError = null, IReadOnlyList<AppServiceHealthSummary>? Services = null);
internal sealed record CoreEnvironmentApplications(string State, IReadOnlyList<CoreEnvironmentApp> Apps, string? Error = null);
