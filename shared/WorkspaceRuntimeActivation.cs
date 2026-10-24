using System.Text.Json.Serialization;

namespace Haas.Hosty.Launch;

// Durable runtime selection. Helper coordination is stored separately so Core and the helper
// cannot overwrite each other's receipts. References only; no credentials or application data.
internal sealed record WorkspaceRuntimeActivation(string Id, string WorkspaceId, string UserId,
    string Fingerprint, string CoreInstance, string CoreSourceRevision, string? CoreWorktreeId,
    string? CoreProject, CoreLaunchIdentity PreviousCore, string[] Apps, string Phase,
    string? PreparedExecutable = null, string? Generation = null, string? Snapshot = null, string? Error = null, IReadOnlyDictionary<string, string>? SourceStamps = null,
    string? ListenUrl = null, CoreLaunchIdentity? ActivatedCore = null, string? PreviousExecutable = null, string[]? ReturnedApps = null, bool CoreReturned = false,
    WorkspaceReturnReceipt[]? Returns = null, WorkspaceActivationActor? Authority = null, bool CoreReserved = false, string? PreviousExecutableHash = null, string? PreparationFingerprint = null, bool PreparationReleased = false,
    WorkspaceCoreReturnTarget? CoreReturnTarget = null, string? ReplacesCoreActivationId = null, string? CoreSupersededBy = null);

internal sealed record WorkspaceActivationActor(string UserId, string Via, string? AppId = null,
    DateTimeOffset? Installation = null, string? Principal = null, string? Review = null, string? AppIdentityHash = null);

internal sealed record WorkspaceReturnAppMutation(string RequestId, string AppId);
internal sealed record WorkspaceReturnRequest(string RequestId, string[] Apps, bool Core, bool AcceptDataChanges);
internal sealed record WorkspaceReturnAppState(string AppId, string Target, bool WasRunning, bool BootRunning, bool BootObserved = false);
internal sealed record WorkspaceCoreReturnTarget(CoreLaunchIdentity Launch, string? Executable, string? ExecutableHash);
internal sealed record WorkspaceReturnReceipt(WorkspaceReturnRequest Request, string State, WorkspaceReturnAppState[]? AppsBeforeCoreReturn = null,
    WorkspaceCoreReturnTarget? CoreTarget = null, bool CoreRestoreStarted = false);

internal static class WorkspaceRuntimeFiles
{
    internal static string Root(string root) => Path.Combine(root, "core", "workspace-activations");
    internal static string PathFor(string root, string id)
    {
        if (!Guid.TryParseExact(id, "D", out _)) throw new ArgumentException("Use a UUID activation request ID.");
        return Path.Combine(Root(root), id + ".json");
    }
    internal static WorkspaceRuntimeActivation Read(string root, string id) =>
        CoreLaunchFiles.Read(PathFor(root, id), WorkspaceRuntimeJson.Default.WorkspaceRuntimeActivation)
            ?? throw new InvalidOperationException("The workspace activation record is unavailable.");
    internal static void Save(string root, WorkspaceRuntimeActivation value) =>
        CoreLaunchFiles.Write(PathFor(root, value.Id), value, WorkspaceRuntimeJson.Default.WorkspaceRuntimeActivation);
    internal static string ChildId(string id, string appId)
    {
        var hash = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(id + "\n" + appId));
        return new Guid(hash.AsSpan(0, 16)).ToString("D");
    }
    internal static WorkspaceRuntimeActivation[] List(string root) => !Directory.Exists(Root(root)) ? [] :
        Directory.EnumerateFiles(Root(root), "*.json").Select(file => Read(root, Path.GetFileNameWithoutExtension(file))).ToArray();
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(WorkspaceRuntimeActivation))]
[JsonSerializable(typeof(WorkspaceReturnAppMutation))]
internal partial class WorkspaceRuntimeJson : JsonSerializerContext;
