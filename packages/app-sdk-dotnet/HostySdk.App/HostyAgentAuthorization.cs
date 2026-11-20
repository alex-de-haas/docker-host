using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace HostySdk.App;

/// <summary>Only exact command metadata goes to Core; prompts and histories go directly to the provider.</summary>
public record HostyAgentAuthorizationRequest(string Operation, string Method, string Path, string BodyHash,
    HostyAgentResource[]? Resources = null, string? SessionId = null, string? RunId = null,
    string? ConfigurationDigest = null, HostyAgentAuthorityCeiling? Ceiling = null, HostyAgentTaskAuthority? Authority = null)
{
    /// <summary>Originating chat for a run start, with a viewer route relative to the consuming app.</summary>
    public HostyAgentConversation? Conversation { get; init; }
}
/// <summary>A consumer-owned workspace conversation attached to this admission.</summary>
public record HostyAgentConversation(string SessionId, string ViewerPath, string Title);
/// <summary>A current, fixed execution ceiling. Resource references select context without narrowing collection grants.</summary>
public record HostyAgentTaskAuthority(string Kind, HostyTaskDispatchRef Dispatch, string ExecutionId);
/// <summary>Current per-run MCP, source and deadline metadata.</summary>
public record HostyAgentAuthorityCeiling(HostyAgentMcpSelection? Mcp = null, HostyAgentResource[]? Resources = null,
    DateTimeOffset? Deadline = null, string? ConfigurationRevision = null, HostyAgentSessionWorkflowBinding? Workflow = null);
/// <summary>An optional reviewed consumer-owned executor workflow for this exact conversation.</summary>
public record HostyAgentSessionWorkflowBinding(HostyProviderRef Executor, string SessionId, string[]? Tools = null, HostyAgentMcpPolicy? Policy = null);
/// <summary>A bounded consumer-owned task business command under an admitted run.</summary>
public record HostyAgentWorkflowRequest(string AdmissionRef, string Action, JsonElement Input, HostyTaskProviderRef? Source = null);
/// <summary>Exact native-provider execution signed into a consumer-owned workflow invocation.</summary>
public record HostyAgentWorkflowInvocation(HostyProviderRef Provider, string SessionId, string RunId);
/// <summary>A resource context reference; it conveys no additional permission.</summary>
public record HostyAgentResource(string Kind, string Id, string Revision, HostyProviderRef? Provider = null);
/// <summary>A Core-validated direct provider endpoint and one exact request credential.</summary>
public record HostyAgentAuthorization(HostyProviderRef Provider, string BaseUrl, string Token, DateTimeOffset ExpiresAt,
    string AdmissionRef, DateTimeOffset AuthorityExpiresAt, string[]? SupportedWorkflowCapabilities = null);
/// <summary>The original actor and authority ceiling rechecked by Core for this exact operation.</summary>
public record HostyAgentInvocation(int Version, string UserId, string HostRole, string PrincipalId,
    string CallerAppId, string CallerInstallation, HostyProviderRef Provider, string Operation,
    HostyAgentResource[]? ResourceIds, string AdmissionRef, string? SessionId, string? RunId,
    string? ConfigurationDigest, HostyAgentAuthorityCeiling? Ceiling, DateTimeOffset ExpiresAt);
/// <summary>Installation-bound, read-only history access. Endpoint is the selected provider interface base URL.</summary>
public record HostyAgentHistoryBinding(string Token, DateTimeOffset ExpiresAt, string Endpoint);
/// <summary>Consumer installation whose admitted runs the provider may return.</summary>
public record HostyAgentHistoryOwner(string CallerAppId, string CallerInstallation, HostyProviderRef Provider, DateTimeOffset ExpiresAt);
internal record HostyAgentHistorySelection(HostyProviderRef Provider);
internal record HostyAgentHistoryIntrospection(string Token, string Key);
internal record HostyAgentAuthorize(HostyProviderRef Provider, string Operation, string Method, string Path, string BodyHash,
    HostyAgentResource[]? Resources, string? SessionId, string? RunId, string? ConfigurationDigest, HostyAgentAuthorityCeiling? Ceiling, HostyAgentTaskAuthority? Authority, HostyAgentConversation? Conversation);
internal record HostyAgentIntrospection(string Token, string Operation, string Method, string Path, string BodyHash);
internal record HostyAgentAdmission(string AdmissionRef, Guid? Generation = null);
/// <summary>A Core-owned or explicitly selected application MCP interface.</summary>
public record HostyAgentMcpTarget(string Kind, string? AppId = null, string? InstallationId = null, string? Key = null);
/// <summary>One selected target and its permitted tool names; null tools keeps its reviewed set.</summary>
public record HostyAgentMcpTargetSelection(HostyAgentMcpTarget Target, string[]? Tools = null, HostyAgentMcpPolicy? Policy = null);
/// <summary>Per-target approval defaults and definition-bound automatic tool rules.</summary>
public record HostyAgentMcpPolicy(string Default, bool? AutoAllowReadOnly = null, Dictionary<string, HostyAgentMcpToolPolicy>? Tools = null);
/// <summary>Automatic run rules include the reviewed tool definition SHA-256.</summary>
public record HostyAgentMcpToolPolicy(string Mode, string? Definition = null);
/// <summary>A provider-local external MCP connection revision.</summary>
public record HostyAgentMcpConnection(string Id, string Revision);
/// <summary>Per-run MCP selection, independent of instructions and native tool policy.</summary>
public record HostyAgentMcpSelection(HostyAgentMcpTargetSelection[]? Targets = null, HostyAgentMcpConnection[]? Connections = null);
/// <summary>Mint fresh target authority for the admitted execution.</summary>
public record HostyAgentMcpTokenRequest(string AdmissionRef, HostyAgentMcpTarget Target, string[]? Tools = null);
/// <summary>A short-lived target credential; never persist or send it to a browser.</summary>
public record HostyAgentMcpToken(string Url, string Token, DateTimeOffset ExpiresAt);
/// <summary>A selected library package, optionally bound to reviewed bytes.</summary>
public record HostyAgentSkillSelection(string SkillId, string? ExpectedDigest = null);
/// <summary>Pin immutable skills before native preparation, under a session/configuration authorization.</summary>
public record HostyAgentSkillSnapshotRequest(string AdmissionRef, string RequestId, HostyAgentSkillSelection[] Skills, string? ConfigurationId = null);
/// <summary>The exact pinned library package digest.</summary>
public record HostyAgentPinnedSkill(string SkillId, string Digest);
/// <summary>A provider-owned native directory whose bytes do not change when the library updates.</summary>
public record HostyAgentSkillSnapshot(string Id, string Path, string Digest, HostyAgentPinnedSkill[] Skills);
/// <summary>A workspace operation. Release is restricted to the execution's recorded lease.</summary>
public record HostyAgentWorkspaceRequest(string AdmissionRef, string Operation, HostyAgentWorkspaceInput Input);
/// <summary>Use stable request/lease UUIDs; paths and actor identity are resolved by Core.</summary>
public record HostyAgentWorkspaceInput(string WorkspaceId, long? ExpectedRevision = null, string? LeaseId = null,
    string? RequestId = null, string? Status = null, long? Sequence = null, string? Title = null, string? ViewerPath = null);
/// <summary>One active repository worktree and its current activity observation.</summary>
public record HostyAgentWorkspace(string Id, long Revision, string Path, string? LeaseId = null, bool StopRequested = false, string? State = null);

public sealed partial class HostyProviderClient
{
    /// <summary>Resolve a history subscription for this installation without a browser session.</summary>
    public Task<HostyAgentHistoryBinding> AuthorizeAgentHistoryAsync(HostyProviderRef provider, CancellationToken cancellationToken = default) =>
        CoreAsync<HostyAgentHistoryBinding>("/agent/history/token", new HostyAgentHistorySelection(provider), null, cancellationToken);
    /// <summary>Provider-only validation of the installation credential used for result delivery.</summary>
    public Task<HostyAgentHistoryOwner> ValidateAgentHistoryAsync(string token, string key, CancellationToken cancellationToken = default) =>
        CoreAsync<HostyAgentHistoryOwner>("/agent/history/introspect", new HostyAgentHistoryIntrospection(token, key), null, cancellationToken);
    /// <summary>Authorize one exact operation. No request content is relayed through Core.</summary>
    public Task<HostyAgentAuthorization> AuthorizeAgentAsync(HostyProviderRef provider, string? userToken,
        HostyAgentAuthorizationRequest input, CancellationToken cancellationToken = default) =>
        CoreAsync<HostyAgentAuthorization>("/agent/authorize", new HostyAgentAuthorize(provider, input.Operation, input.Method,
            input.Path, input.BodyHash, input.Resources, input.SessionId, input.RunId, input.ConfigurationDigest, input.Ceiling, input.Authority, input.Conversation), userToken, cancellationToken);
    /// <summary>Introspect actual received bytes on every request; enforce provider resource ownership afterwards.</summary>
    public async Task<HostyAgentInvocation> ValidateAgentAsync(string token, HostyMediatedProviderRequest input,
        CancellationToken cancellationToken = default)
    {
        if (!token.StartsWith("hosty_agent.1.", StringComparison.Ordinal) || input.Body.Length > 1024 * 1024)
            throw new HostyProviderException("token_invalid", "A bounded exact agent credential is required.", 401);
        var result = await CoreAsync<HostyAgentInvocation>("/agent/introspect", new HostyAgentIntrospection(token, input.Operation,
            input.Method, input.Path, Convert.ToHexString(SHA256.HashData(input.Body.Span)).ToLowerInvariant()), null, cancellationToken);
        if (result.Version != 1 || result.Provider.AppId != options.AppId || result.Operation != input.Operation
            || string.IsNullOrWhiteSpace(result.UserId) || string.IsNullOrWhiteSpace(result.PrincipalId) || result.ExpiresAt <= DateTimeOffset.UtcNow)
            throw new HostyProviderException("token_invalid", "Invalid current agent invocation.", 401);
        return result;
    }
    /// <summary>Persist provider acceptance before this call and admit before any native effect.</summary>
    public Task<HostyAgentInvocation> AdmitAgentAsync(string admissionRef, CancellationToken cancellationToken = default)
        => CoreAsync<HostyAgentInvocation>("/agent/admit", new HostyAgentAdmission(admissionRef), null, cancellationToken);
    /// <summary>Admit a native execution with its provider-assigned generation for exact workspace recovery.</summary>
    public Task<HostyAgentInvocation> AdmitAgentAsync(string admissionRef, Guid generation, CancellationToken cancellationToken)
        => CoreAsync<HostyAgentInvocation>("/agent/admit", new HostyAgentAdmission(admissionRef, generation), null, cancellationToken);
    /// <summary>Revalidate the retained actor without extending the original absolute deadline.</summary>
    public Task<HostyAgentInvocation> RenewAgentAsync(string admissionRef, CancellationToken cancellationToken = default)
        => CoreAsync<HostyAgentInvocation>("/agent/renew", new HostyAgentAdmission(admissionRef), null, cancellationToken);
    /// <summary>Obtain target-specific current MCP authority, including the selected tool filter.</summary>
    public Task<HostyAgentMcpToken> AgentMcpTokenAsync(HostyAgentMcpTokenRequest input, CancellationToken cancellationToken = default)
        => CoreAsync<HostyAgentMcpToken>("/agent/mcp/token", input, null, cancellationToken);
    /// <summary>Pin provider-owned immutable native skill bytes.</summary>
    public Task<HostyAgentSkillSnapshot> PinAgentSkillsAsync(HostyAgentSkillSnapshotRequest input, CancellationToken cancellationToken = default)
        => CoreAsync<HostyAgentSkillSnapshot>("/agent/skills/snapshots", input, null, cancellationToken);
    /// <summary>Invoke a selected consumer-owned task business action without changing Core MCP grants.</summary>
    public Task<JsonElement> AgentWorkflowAsync(HostyAgentWorkflowRequest input, CancellationToken cancellationToken = default)
        => CoreAsync<JsonElement>("/agent/workflow", input, null, cancellationToken);
    /// <summary>Resolve, lease, report activity or release the admitted execution's native source.</summary>
    public Task<HostyAgentWorkspace> AgentWorkspaceAsync(HostyAgentWorkspaceRequest input, CancellationToken cancellationToken = default)
        => CoreAsync<HostyAgentWorkspace>("/agent/workspace", input, null, cancellationToken);
}
