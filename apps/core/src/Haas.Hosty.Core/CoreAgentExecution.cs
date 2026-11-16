using HostySdk.App;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Haas.Hosty.Core;

internal sealed record CoreAgentAuthorizeRequest(HostyProviderRef Provider, string Operation, string Method,
    string Path, string BodyHash, JsonElement? Resources = null, string? SessionId = null, string? RunId = null,
    string? ConfigurationDigest = null, JsonElement? Ceiling = null, CoreAgentTaskAuthority? Authority = null);
internal sealed record CoreAgentReference(string AdmissionRef);
internal sealed record CoreAgentIntrospection(string Token, string Operation, string Method, string Path, string BodyHash);
internal sealed record CoreAgentToken(string Id, long Expires);
internal sealed record CoreAgentBinding(HostyProviderRef Provider, string BaseUrl, string Token,
    DateTimeOffset ExpiresAt, string AdmissionRef, DateTimeOffset AuthorityExpiresAt);
internal sealed record CoreAgentInvocation(int Version, string UserId, string HostRole, string PrincipalId,
    string CallerAppId, string CallerInstallation, HostyProviderRef Provider, string Operation,
    JsonElement? ResourceIds, string AdmissionRef, string? SessionId, string? RunId,
    string? ConfigurationDigest, JsonElement? Ceiling, DateTimeOffset ExpiresAt);
internal sealed record CoreAgentAuthorization(string Id, CoreCallerAuthority Origin, string UserId, string PrincipalId,
    string CallerAppId, DateTimeOffset CallerInstallation, string? CallerRevision,
    CoreAgentAuthorizeRequest Request, string? ProviderRevision, DateTimeOffset ExpiresAt, bool Admitted = false,
    CoreAgentLease[]? Leases = null, CoreAgentTaskAuthority? Authority = null);
internal sealed record CoreAgentLease(string WorkspaceId, string WorktreeId, string SessionId, string LeaseId, string? RequestId = null, bool Released = false, long? Revision = null);

// Only authorization metadata is retained. Prompts, native histories and bearer secrets never enter this store.
internal sealed class CoreAgentAuthorizationStore(CoreDataPaths paths)
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private string File(string id)
    {
        if (!Regex.IsMatch(id ?? "", "^[a-f0-9]{64}$")) throw CoreAgentExecution.Invalid("Invalid admission reference.");
        return System.IO.Path.Combine(paths.CoreRoot, "agent-authorizations", id + ".json");
    }
    internal async Task<CoreAgentAuthorization> Get(string id, CancellationToken ct)
        => await JsonStorage.ReadAsync<CoreAgentAuthorization>(File(id), ct)
            ?? throw new CoreProviderException("not_found", "Agent authorization not found.", 404);
    internal async Task<CoreAgentAuthorization> Put(CoreAgentAuthorization value, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var file = File(value.Id);
            var previous = await JsonStorage.ReadAsync<CoreAgentAuthorization>(file, ct);
            if (previous is not null) return previous;
            if (value.Request.Operation == "runs.start" && Directory.Exists(Path.GetDirectoryName(file)))
                foreach (var otherFile in Directory.EnumerateFiles(Path.GetDirectoryName(file)!, "*.json"))
                {
                    var other = await JsonStorage.ReadAsync<CoreAgentAuthorization>(otherFile, ct);
                    if (other is null || other.Request.Operation != "runs.start" || other.UserId != value.UserId
                        || other.CallerAppId != value.CallerAppId || other.CallerInstallation != value.CallerInstallation
                        || other.Request.Provider != value.Request.Provider || other.Request.SessionId != value.Request.SessionId
                        || other.Request.RunId != value.Request.RunId) continue;
                    if (CoreJson.Text(CoreAgentExecution.Workflow(other.Request)) != CoreJson.Text(CoreAgentExecution.Workflow(value.Request)))
                        throw new CoreProviderException("execution_conflict", "Recover this run with its original consumer workflow binding.", 409);
                }
            await JsonStorage.WriteOwnerFileAsync(file, value, ct); return value;
        }
        finally { gate.Release(); }
    }
    internal async Task<CoreAgentAuthorization> RecordLease(string id, CoreAgentLease lease, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var value = await Get(id, ct);
            foreach (var file in Directory.EnumerateFiles(Path.GetDirectoryName(File(id))!, "*.json"))
            {
                var other = await JsonStorage.ReadAsync<CoreAgentAuthorization>(file, ct);
                if (other is null || other.Id == id || other.UserId != value.UserId || (other.Request.Provider.AppId != value.Request.Provider.AppId || other.Request.Provider.InstallationId != value.Request.Provider.InstallationId)) continue;
                if (other.Leases?.Any(l => l.SessionId == lease.SessionId && l.LeaseId == lease.LeaseId) == true)
                    throw new CoreProviderException("execution_conflict", "A lease UUID cannot be reused by another execution.", 409);
            }
            var leases = value.Leases ?? [];
            var previous = leases.SingleOrDefault(l => l.LeaseId == lease.LeaseId);
            if (previous is not null)
            {
                if (previous.SessionId != lease.SessionId || previous.RequestId != lease.RequestId || previous.WorktreeId.Length > 0 && lease.WorktreeId.Length > 0 && previous.WorktreeId != lease.WorktreeId)
                    throw new CoreProviderException("execution_conflict", "Recover the original source lease intent.", 409);
                if (previous.Released || lease.WorktreeId.Length == 0) return value;
                leases = leases.Select(l => l.LeaseId == lease.LeaseId ? lease : l).ToArray();
            }
            else
            {
                if (leases.Length >= 100) throw new CoreProviderException("execution_conflict", "Execution source budget exceeded.", 409);
                leases = [.. leases, lease];
            }
            value = value with { Leases = leases };
            await JsonStorage.WriteOwnerFileAsync(File(id), value, ct); return value;
        }
        finally { gate.Release(); }
    }
    internal async Task<CoreAgentAuthorization> Change(string id, Func<CoreAgentAuthorization, CoreAgentAuthorization> change, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var value = change(await Get(id, ct));
            await JsonStorage.WriteOwnerFileAsync(File(id), value, ct); return value;
        }
        finally { gate.Release(); }
    }
}

internal sealed partial class CoreAgentExecution(AppIdentityService identity,
    AppRegistryStore apps, CoreCapabilityAuthorization authorization, AppSessionGrantStore grants,
    CoreAgentAuthorizationStore store, DelegatedTokenSigningKey signing, IClock clock,
    AgentPolicyStore policies, HostyCoreRuntimeConfig config, DevelopmentWorkspaceService workspaces, AgentSkillLibrary skills,
    CoreTaskAdapter tasks, CoreProviderOperationStore operations, UserDirectoryStore users)
{
    internal const string Prefix = "hosty_agent.1.";
    internal const string ExecutionHeader = "X-Hosty-Agent-Execution";
    internal static CoreProviderException Invalid(string message) => new("invalid_input", message, 400);
    private static string Hash(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    private static string Encode(byte[] value) => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static byte[] Decode(string value) { var s = value.Replace('-', '+').Replace('_', '/'); return Convert.FromBase64String(s.PadRight(s.Length + (4 - s.Length % 4) % 4, '=')); }
    private static void Validate(CoreAgentAuthorizeRequest input)
    {
        CoreProviderMediation.ValidateReference(input.Provider);
        if (input.ConfigurationDigest is { } configurationDigest && !Regex.IsMatch(configurationDigest, "^[a-f0-9]{64}$"))
            throw Invalid("Use an exact lowercase SHA-256 configuration digest.");
        if (!Regex.IsMatch(input.BodyHash ?? "", "^[a-f0-9]{64}$") || input.Path is null || input.Path.Length > 4096
            || !input.Path.StartsWith('/') || input.Path.StartsWith("//") || input.Path.Contains('\\') || input.Path.Contains('#')
            || input.Path.Contains("..", StringComparison.Ordinal)) throw Invalid("Use an exact relative path and SHA-256 body hash.");
        var path = input.Path.Split('?')[0];
        var query = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(input.Path.Contains('?') ? input.Path[input.Path.IndexOf('?')..] : "");
        var queryKeys = input.Operation switch { "sessions.list" or "connections.list" or "connections.models" => new[] { "cursor", "limit" }, "runs.events" => new[] { "after" }, _ => Array.Empty<string>() };
        if (query.Any(q => !queryKeys.Contains(q.Key, StringComparer.Ordinal) || q.Value.Count != 1 || q.Value.ToString().Length > 2048)
            || query.TryGetValue("limit", out var limit) && (!int.TryParse(limit.ToString(), out var count) || count is < 1 or > 100))
            throw Invalid("Use only documented bounded query metadata.");
        var valid = (input.Method, input.Operation) switch
        {
            ("GET", "capabilities") => path == "/capabilities",
            ("GET", "connections.list") => path == "/connections",
            ("GET", "connections.usage") => Regex.IsMatch(path, "^/connections/[A-Za-z0-9_-]{1,256}/usage$"),
            ("GET", "connections.models") => Regex.IsMatch(path, "^/connections/[A-Za-z0-9_-]{1,256}/models$"),
            ("GET", "sessions.list") => path == "/sessions",
            ("GET", "sessions.read") => Regex.IsMatch(path, "^/sessions/[A-Za-z0-9-]+$"),
            ("PUT", "attachments.write") => Regex.IsMatch(path, "^/attachments/[A-Fa-f0-9-]{36}/chunks/[0-9]{1,3}$"),
            ("PUT", "sessions.create") => path == "/sessions/" + input.SessionId && Guid.TryParse(input.SessionId, out _),
            ("PUT", "sessions.configure") => Guid.TryParse(input.SessionId, out _) && Regex.IsMatch(path, "^/sessions/" + Regex.Escape(input.SessionId!) + "/configurations/[A-Za-z0-9-]+$"),
            ("PUT", "runs.start") => Guid.TryParse(input.SessionId, out _) && Guid.TryParse(input.RunId, out _) && path == $"/sessions/{input.SessionId}/runs/{input.RunId}",
            ("GET", "runs.read") => Guid.TryParse(input.RunId, out _) && path == "/runs/" + input.RunId,
            ("GET", "runs.events") => Guid.TryParse(input.RunId, out _) && path == $"/runs/{input.RunId}/events",
            ("POST", "runs.respond") => Guid.TryParse(input.RunId, out _) && path == $"/runs/{input.RunId}/responses",
            ("POST", "runs.cancel") => Guid.TryParse(input.RunId, out _) && path == $"/runs/{input.RunId}/cancel",
            ("POST", "runs.control") => Guid.TryParse(input.RunId, out _) && path == $"/runs/{input.RunId}/controls",
            ("GET", "runs.controls.read") => Guid.TryParse(input.RunId, out _) && Regex.IsMatch(path, "^/runs/" + Regex.Escape(input.RunId!) + "/controls/[A-Za-z0-9-]+$"),
            _ => false,
        };
        if (!valid) throw Invalid("The method, operation and resource path do not match.");
        if (input.Ceiling is { } ceiling && (ceiling.ValueKind != JsonValueKind.Object || Encoding.UTF8.GetByteCount(ceiling.GetRawText()) > 65536))
            throw Invalid("Use a bounded metadata-only authority ceiling.");
        if (input.Resources is { } resources) ValidateResources(resources);
        if (input.Ceiling is { } metadata) ValidateCeiling(metadata);
    }
    internal async Task<CoreAgentBinding> Authorize(AppRecord consumer, string credential, CoreAgentAuthorizeRequest input, CancellationToken ct)
    {
        Validate(input);
        ValidateWorkflowOwner(consumer, input);
        if (!AppManagementAuthorization.HasPermission(consumer, CoreAppPermissions.AgentProviders))
            throw new AppIdentityException("app_permission_required", "The consumer requires providers.agent.");
        CoreCapabilityCaller caller;
        CoreCallerAuthority origin;
        DateTimeOffset expires;
        if (input.Authority is { } task)
        {
            if (!string.IsNullOrEmpty(credential)) throw Invalid("Do not mix task dispatch and user credentials.");
            (caller, origin, expires) = await TaskAuthority(consumer, task, input.Operation, ct);
        }
        else
        {
            var hash = AppIdentityService.HashToken(credential);
            var actor = await identity.RequireOperationHashAsync(hash, consumer.Id,
                s => s.Kind == "provider" && s.TargetAppId == input.Provider.AppId && s.ProviderKind == "agent" && s.Key == input.Provider.Key, ct);
            var (user, _) = await identity.RequireAccessibleUserAsync(consumer.Id, actor.UserId, ct);
            origin = new("app", AppId: consumer.Id, Installation: consumer.InstalledAt,
                PermissionRevision: consumer.PermissionRevision, IdentityHash: hash);
            caller = new(user, CoreCapabilityAuthorization.AppPrincipal(consumer), consumer, null) { Authority = origin };
            expires = (await grants.TryResolveAsync(hash, ct) ?? throw new AppIdentityException("token_invalid", "The originating app grant is unavailable.")).AbsoluteExpiresAt;
        }
        if (!AppAccessPolicy.IsAdmin(caller.User)) throw new AppIdentityException("admin_required", "Native agent execution currently requires an administrator.");
        await identity.RequireAccessibleUserAsync(input.Provider.AppId, caller.User.Id, ct);
        var provider = await apps.GetAppAsync(input.Provider.AppId, ct) ?? throw new CoreProviderException("provider_unavailable", "Provider unavailable.", 503);
        var descriptor = Descriptor(provider, input.Provider);
        var deadline = expires;
        if (input.Ceiling is { } c && c.TryGetProperty("deadline", out var requested) && requested.ValueKind != JsonValueKind.Null)
        {
            if (requested.ValueKind != JsonValueKind.String || !requested.TryGetDateTimeOffset(out deadline)) throw Invalid("Use an absolute deadline.");
        }
        if (deadline < expires) expires = deadline;
        if (expires <= clock.UtcNow) throw Invalid("The requested execution deadline has expired.");
        var id = Hash(CoreJson.Text(input) + CoreJson.Text(origin) + caller.User.Id);
        var record = await store.Put(new(id, origin, caller.User.Id, caller.PrincipalId,
            consumer.Id, consumer.InstalledAt, consumer.PermissionRevision, input, provider.PermissionRevision, expires, Authority: input.Authority), ct);
        await ValidateRecord(provider, record, ct, admitted: false);
        var tokenExpires = clock.UtcNow.AddMinutes(2); if (record.ExpiresAt < tokenExpires) tokenExpires = record.ExpiresAt;
        var token = Prefix + Encode(JsonSerializer.SerializeToUtf8Bytes(new CoreAgentToken(id, tokenExpires.ToUnixTimeSeconds()), CoreJson.TypeInfo<CoreAgentToken>()));
        token += "." + Encode(signing.Sign(Encoding.UTF8.GetBytes(token)));
        return new(input.Provider, descriptor.Url!, token, tokenExpires, id, record.ExpiresAt);
    }
    private static ProviderDescriptor Descriptor(AppRecord provider, HostyProviderRef reference)
    {
        if (PanelIdentity.Installation(provider) != reference.InstallationId) throw new CoreProviderException("provider_unavailable", "The provider installation changed.", 503);
        var descriptor = ProviderAccessService.Describe(provider, "agent").SingleOrDefault(d => d.Key == reference.Key && d.Version == 1);
        if (descriptor?.Available != true || descriptor.Url is null) throw new CoreProviderException("provider_unavailable", "The selected agent interface is unavailable.", 503);
        return descriptor;
    }
    internal async Task<(CoreAgentAuthorization Record, CoreCapabilityCaller Origin)> ValidateRecord(AppRecord provider,
        CoreAgentAuthorization record, CancellationToken ct, bool admitted = true)
    {
        if (record.Request.Provider.AppId != provider.Id || record.Request.Provider.InstallationId != PanelIdentity.Installation(provider)
            || record.ProviderRevision != provider.PermissionRevision || record.ExpiresAt <= clock.UtcNow
            || admitted && !record.Admitted) throw new AppIdentityException("permission_denied", "This execution authority is unavailable.");
        Descriptor(provider, record.Request.Provider);
        var consumer = await apps.GetAppAsync(record.CallerAppId, ct);
        if (consumer is null || consumer.InstalledAt != record.CallerInstallation || consumer.PermissionRevision != record.CallerRevision
            || !AppManagementAuthorization.HasPermission(consumer, CoreAppPermissions.AgentProviders))
            throw new AppIdentityException("permission_denied", "The consuming installation or its reviewed grants changed.");
        ValidateWorkflowOwner(consumer, record.Request);
        CoreCapabilityCaller origin;
        if (record.Authority is { } task)
        {
            (origin, _, _) = await TaskAuthority(consumer, task, record.Request.Operation, ct);
            if (origin.User.Id != record.UserId || origin.PrincipalId != record.PrincipalId) throw new AppIdentityException("permission_denied", "The original task actor changed.");
        }
        else
        {
            origin = await authorization.RevalidateAsync(record.Origin, record.UserId, record.PrincipalId,
                "agent", provider.Id, record.Request.Provider.Key, "agent_invoke", ct, retainedTask: record.Admitted);
            origin.Require("", CoreAppPermissions.AgentProviders);
        }
        if (!AppAccessPolicy.IsAdmin(origin.User)) throw new AppIdentityException("admin_required", "Native execution requires a current administrator.");
        return (record, origin);
    }
    internal CoreAgentInvocation Invocation(CoreAgentAuthorization record, CoreCapabilityCaller caller) => new(1, record.UserId,
        caller.User.Role, record.PrincipalId, record.CallerAppId, record.CallerInstallation.ToString("O"),
        record.Request.Provider, record.Request.Operation, record.Request.Resources, record.Id, record.Request.SessionId,
        record.Request.RunId, record.Request.ConfigurationDigest, record.Request.Ceiling, record.ExpiresAt);
    internal async Task<CoreAgentInvocation> Introspect(AppRecord provider, CoreAgentIntrospection input, CancellationToken ct)
    {
        CoreAgentToken token;
        try
        {
            if (input.Token.Length > 4096 || !input.Token.StartsWith(Prefix)) throw new FormatException();
            var parts = input.Token[Prefix.Length..].Split('.');
            if (parts.Length != 2 || !signing.Verify(Encoding.UTF8.GetBytes(Prefix + parts[0]), Decode(parts[1]))) throw new FormatException();
            token = JsonSerializer.Deserialize(Decode(parts[0]), CoreJson.TypeInfo<CoreAgentToken>()) ?? throw new FormatException();
        }
        catch (Exception ex) when (ex is FormatException or JsonException or ArgumentException or CryptographicException)
        { throw new AppIdentityException("token_invalid", "Invalid agent operation credential."); }
        if (token.Expires <= clock.UtcNow.ToUnixTimeSeconds()) throw new AppIdentityException("token_invalid", "The operation credential expired.");
        var record = await store.Get(token.Id, ct);
        if (record.Request.Operation != input.Operation || record.Request.Method != input.Method || record.Request.Path != input.Path
            || record.Request.BodyHash != input.BodyHash) throw new AppIdentityException("permission_denied", "This credential is bound to another exact operation.");
        var (_, caller) = await ValidateRecord(provider, record, ct, admitted: false);
        return Invocation(record, caller);
    }
    internal async Task<CoreAgentInvocation> Admit(AppRecord provider, string reference, CancellationToken ct)
    {
        var record = await store.Get(reference, ct);
        var (_, caller) = await ValidateRecord(provider, record, ct, admitted: false);
        if (record.Request.Operation != "runs.start") throw Invalid("Only a run submission can establish execution authority.");
        record = await store.Change(reference, r => r with { Admitted = true }, ct);
        return Invocation(record, caller);
    }
    internal async Task<CoreAgentInvocation> Renew(AppRecord provider, string reference, CancellationToken ct)
    {
        var (record, caller) = await ValidateRecord(provider, await store.Get(reference, ct), ct);
        return Invocation(record, caller);
    }
    internal async Task<CoreCapabilityCaller> DecisionCaller(AppRecord provider, string reference, CancellationToken ct, bool metadataOnly = false)
    {
        var record = await store.Get(reference, ct);
        if (metadataOnly)
        {
            if (!record.Admitted || record.Request.Operation != "runs.start" || record.Request.Provider.AppId != provider.Id
                || record.Request.Provider.InstallationId != PanelIdentity.Installation(provider))
                throw new AppIdentityException("permission_denied", "This provider does not own the admitted question source.");
            var (user, _) = await identity.RequireAccessibleUserAsync(provider.Id, record.UserId, ct);
            return new(user, record.PrincipalId, provider, null) { AgentExecution = record.Id, RetainedAgentObservation = true };
        }
        var (_, origin) = await ValidateRecord(provider, record, ct);
        return new(origin.User, record.PrincipalId, provider, null) { AgentExecution = record.Id };
    }
}
