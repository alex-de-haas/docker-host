using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

// Workspace/session identifiers are optional context. The verified caller and target/input
// references are the authorization boundary for every client, including background jobs.
internal sealed record SandboxActor(string UserId, string? AppId = null, DateTimeOffset? Installation = null,
    string? GrantId = null, string? ScopeId = null)
{
    // Server-only authority for deleting resources belonging to an admitted workspace.
    // Never accepted from a JSON client or persisted as a transferable credential.
    [System.Text.Json.Serialization.JsonIgnore]
    public string? DeletingWorkspace { get; init; }
    [System.Text.Json.Serialization.JsonIgnore]
    public WorkspaceOwner? DeletingOwner { get; init; }
    internal bool CanDeleteResource(SandboxActor owner, SandboxContext? context)
        => DeletingWorkspace is { } id && DeletingOwner is { } allocation
            && DevelopmentWorkspaceService.WorkspaceIdFor(allocation) == id
            && WorkspaceCleanupService.Belongs(owner, context, allocation, id);

    [System.Text.Json.Serialization.JsonIgnore]
    public string Key => SandboxValidation.Hash(CoreJson.Text(this));
    public bool SameOwner(SandboxActor other) => UserId == other.UserId && AppId == other.AppId && Installation == other.Installation
        && (GrantId is null || (GrantId == other.GrantId && ScopeId == other.ScopeId));
}
internal sealed record SandboxSourceRef(string Kind, string? WorktreeId = null, string? ArtifactDigest = null);
internal sealed record SandboxContext(string? WorkspaceId = null, string? SessionId = null, string? JobId = null);
internal sealed record SandboxLimits(long MemoryBytes = 4294967296, double Cpus = 2, int Pids = 512,
    long DataBytes = 536870912, long CacheBytes = 4294967296, int StartupSeconds = 120);
internal sealed record SandboxPlanRequest(string AppId, string Profile, SandboxSourceRef Source,
    SandboxLimits? Limits = null, SandboxContext? Context = null);
internal sealed record SandboxPrepareRequest(string RequestId, string PlanId, string Digest);
internal sealed record SandboxCommand(string RequestId, long ExpectedRevision, string? SeedRevision = null);
internal sealed record SandboxSeedFile(string Path, string Content);
internal sealed record SandboxSeedRequest(string RequestId, long ExpectedRevision, SandboxSeedFile[] Files);
internal sealed record SandboxUserRequest(string RequestId, long ExpectedRevision, string FixtureKey,
    string DisplayName, string Role, string[]? Permissions = null, bool Enabled = true);
internal sealed record SandboxUserDeleteRequest(string RequestId, long ExpectedRevision, string UserId);
internal sealed record SandboxViewersRequest(string RequestId, long ExpectedRevision, string[] UserIds);
internal sealed record SandboxEvidenceClearRequest(string RequestId, long ExpectedRevision, string JobId);
internal sealed record SandboxUser(string Id, string FixtureKey, string DisplayName, string Role,
    string[] Permissions, bool Enabled, long Revision);
internal sealed record SandboxOperation(string Id, string Kind, string Fingerprint, string State,
    DateTimeOffset CreatedAt, string? ErrorCode = null, string? Message = null);
internal sealed record SandboxResource(string Kind, string Id, string Generation, string? Service = null, string? EngineId = null, string? ConfigurationDigest = null);
internal sealed record SandboxStorageObservation(DateTimeOffset At, long DataBytes, long SeedBytes, long CacheBytes, long EvidenceBytes, long TotalBytes, bool Warning, string? ErrorCode = null);
internal sealed record SandboxServiceMetrics(string Service, double? MemoryBytes, double? CpuPercent);
internal sealed record SandboxMetrics(DateTimeOffset At, SandboxServiceMetrics[] Services, double? MemoryBytes, double? SampledPeakMemoryBytes);
internal sealed record SandboxRuntimePolicy(string RelayImage, int MaxRunningInstances = 1, string? BrowserImage = null);
internal sealed record SandboxRelayEndpoint(string Host, string Service, int Port);
internal sealed record SandboxRelayConfig(string InstanceId, string Generation, string DataRevision, string CoreOrigin,
    string AuthHost, SandboxRelayEndpoint[] Endpoints, string? BrowserAddress = null);
internal sealed record SandboxPreview(string InstanceId, string State, string Mode, string? UserId, string? Url);
internal sealed record SandboxPreviewEndpoint(string Key, string Url);
internal sealed record SandboxRuntimeStart(string PreviewUrl, string AuthOrigin, SandboxPreviewEndpoint[] Endpoints, string? BrowserProxy = null);
internal sealed record SandboxPlan(string Id, string Digest, SandboxActor Owner, SandboxPlanRequest Request,
    DateTimeOffset Installation, string InputDigest, DateTimeOffset ExpiresAt, string[] Blockers);
internal sealed record SandboxResolvedInput(string AppId, DateTimeOffset Installation, string Digest,
    RuntimeAppManifestSelection Manifest, string? SourceRoot, string[] Roles, string[] Permissions,
    IReadOnlyDictionary<string, string> Images, bool Reviewed);
internal sealed record SandboxManifest(string Protocol, string[] Roles, string[]? Permissions = null,
    IReadOnlyDictionary<string, string[]>? GeneratedSourceFiles = null);
internal sealed record SandboxBackgroundPolicy(string InputDigest, SandboxLimits Limits, string SourceKind = "appArtifact", string? WorktreeId = null);
internal sealed record SandboxApprovalRequest(string Digest);
internal sealed record SandboxPlanRecord(SandboxPlan Plan, SandboxResolvedInput Input);
internal sealed record SandboxInstance
{
    public required string Id { get; init; }
    public required SandboxActor Owner { get; init; }
    public required SandboxPlanRequest Request { get; init; }
    public required SandboxResolvedInput Input { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public long Revision { get; init; } = 1;
    public string Generation { get; init; } = Guid.NewGuid().ToString("N");
    public string DataRevision { get; init; } = Guid.NewGuid().ToString("N");
    public string State { get; init; } = "prepared";
    public bool AccessRevoked { get; init; }
    public string? SourceLeaseId { get; init; }
    public int PreviewPort { get; init; }
    public string? PreviewUrl { get; init; }
    public string? AuthOrigin { get; init; }
    public string? BrowserProxy { get; init; }
    public SandboxPreviewEndpoint[] Endpoints { get; init; } = [];
    public string? ErrorCode { get; init; }
    public SandboxStorageObservation? Storage { get; init; }
    public SandboxMetrics? Metrics { get; init; }
    public SandboxResource[] Resources { get; init; } = [];
    public SandboxOperation[] Operations { get; init; } = [];
    public SandboxUser[] Users { get; init; } = [];
    public string[] Viewers { get; init; } = [];
}
// Projections deliberately exclude resolved host paths, manifest environment, hashes and credentials.
internal sealed record SandboxView(string Id, string AppId, SandboxActor Owner, SandboxSourceRef Source,
    SandboxContext? Context, long Revision, string Generation, string DataRevision, string State,
    string? PreviewUrl, string? ErrorCode, SandboxLimits Limits, SandboxOperation[] Operations, SandboxUser[] Users, SandboxStorageObservation? Storage = null, string[]? Viewers = null, SandboxPreviewEndpoint[]? Endpoints = null, SandboxMetrics? Metrics = null);
internal sealed record SandboxInventory(SandboxView[] Instances);
internal sealed record SandboxReceipt(string Id, SandboxActor Owner, DateTimeOffset DisposedAt, SandboxOperation[] Operations, string AppId = "", SandboxContext? Context = null);
internal sealed record SandboxSeedRecord(string Revision, SandboxSeedFile[] Files, SandboxUser[] Users);
internal sealed record SandboxAllocation(string RequestId, string Fingerprint, string InstanceId);
internal sealed record SandboxAllocationState(SandboxAllocation[] Allocations);

internal interface ISandboxRuntime
{
    Task<SandboxRuntimeStart> StartAsync(SandboxInstance instance, Func<SandboxResource, Task> recordResource, CancellationToken ct);
    Task<SandboxServiceLog[]> LogsAsync(SandboxInstance instance, CancellationToken ct) => Task.FromResult<SandboxServiceLog[]>([]);
    Task StopAsync(SandboxInstance instance, CancellationToken ct);
    Task RemoveAsync(SandboxInstance instance, CancellationToken ct);
    Task<string> ObserveAsync(SandboxInstance instance, CancellationToken ct);
    Task<long?> VmFreeBytesAsync(SandboxInstance instance, CancellationToken ct) => Task.FromResult<long?>(null);
    Task<SandboxMetrics?> MetricsAsync(SandboxInstance instance, CancellationToken ct) => Task.FromResult<SandboxMetrics?>(null);
}

internal sealed class SandboxException(string code, string message, int status = 409) : Exception(message)
{
    public string Code { get; } = code;
    public int Status { get; } = status;
}

internal static class SandboxValidation
{
    public static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    public static void Id(string value)
    {
        if (!Guid.TryParseExact(value, "N", out _)) throw new SandboxException("sandbox_id_invalid", "Use a Core-issued sandbox ID.", 400);
    }
    public static void Request(string value)
    {
        if (!Guid.TryParse(value, out _)) throw new SandboxException("sandbox_request_invalid", "A request UUID is required.", 400);
    }
    public static void Text(string value, int max, string field)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > max || value.Any(char.IsControl) || value != value.Trim())
            throw new SandboxException("sandbox_input_invalid", $"Invalid {field}.", 400);
    }
    public static SandboxLimits Limits(SandboxLimits? input)
    {
        var limits = input ?? new();
        if (limits.MemoryBytes is < 67108864 or > 4294967296 || !double.IsFinite(limits.Cpus) || limits.Cpus is <= 0 or > 2
            || limits.Pids is < 16 or > 512 || limits.DataBytes is <= 0 or > 536870912
            || limits.CacheBytes is <= 0 or > 4294967296 || limits.StartupSeconds is < 1 or > 120)
            throw new SandboxException("sandbox_limits_invalid", "Limits exceed the reviewed local sandbox profile.", 400);
        return limits;
    }
}
