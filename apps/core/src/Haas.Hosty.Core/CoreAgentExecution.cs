using HostySdk.App;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Haas.Hosty.Core;

internal sealed record CoreAgentAuthorizeRequest(HostyProviderRef Provider, string Operation, string Method,
    string Path, string BodyHash, JsonElement? Resources = null, string? SessionId = null, string? RunId = null,
    string? ConfigurationDigest = null, JsonElement? Ceiling = null, CoreAgentTaskAuthority? Authority = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    CoreAgentConversation? Conversation = null);
internal sealed record CoreAgentReference(string AdmissionRef, string? Generation = null);
internal sealed record CoreAgentIntrospection(string Token, string Operation, string Method, string Path, string BodyHash);
internal sealed record CoreAgentToken(string Id, long Expires, string? GrantEpoch = null);
internal sealed record CoreAgentBinding(HostyProviderRef Provider, string BaseUrl, string Token,
    DateTimeOffset ExpiresAt, string AdmissionRef, DateTimeOffset AuthorityExpiresAt, string[] SupportedWorkflowCapabilities);
internal sealed record CoreAgentInvocation(int Version, string UserId, string HostRole, string PrincipalId,
    string CallerAppId, string CallerInstallation, HostyProviderRef Provider, string Operation,
    JsonElement? ResourceIds, string AdmissionRef, string? SessionId, string? RunId,
    string? ConfigurationDigest, JsonElement? Ceiling, DateTimeOffset ExpiresAt, string? OriginalStartDigest = null, bool CleanupOnly = false);
internal sealed record CoreAgentAuthorization(string Id, CoreCallerAuthority Origin, string UserId, string PrincipalId,
    string CallerAppId, DateTimeOffset CallerInstallation, string? CallerRevision,
    CoreAgentAuthorizeRequest Request, string? ProviderRevision, DateTimeOffset ExpiresAt, bool Admitted = false,
    CoreAgentLease[]? Leases = null, CoreAgentTaskAuthority? Authority = null, bool WorkspaceLeasesClosed = false, string? Generation = null, string? ImplementationIncarnation = null, int ProtocolVersion = 1, string? GrantEpoch = null, bool WriterScopeClosed = false);
internal sealed record CoreAgentLease(string WorkspaceId, string WorktreeId, string SessionId, string LeaseId, string? RequestId = null, bool Released = false, long? Revision = null);

// Only authorization metadata is retained. Prompts, native histories and bearer secrets never enter this store.
internal sealed partial class CoreAgentAuthorizationStore(CoreDataPaths paths)
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private sealed class WorkspaceGate
    {
        internal readonly SemaphoreSlim Semaphore = new(1, 1);
        internal int References;
    }
    private readonly Dictionary<string, WorkspaceGate> workspaceGates = new(StringComparer.Ordinal);
    private string File(string id)
    {
        if (!Regex.IsMatch(id ?? "", "^[a-f0-9]{64}$")) throw CoreAgentExecution.Invalid("Invalid admission reference.");
        return System.IO.Path.Combine(paths.CoreRoot, "agent-authorizations", id + ".json");
    }
    internal async Task<CoreAgentAuthorization> Get(string id, CancellationToken ct)
        => await JsonStorage.ReadAsync<CoreAgentAuthorization>(File(id), ct)
            ?? throw new CoreProviderException("not_found", "Agent authorization not found.", 404);
    internal async Task<CoreAgentAuthorization> Put(CoreAgentAuthorization value, CancellationToken ct, CoreAgentAuthorization? expired = null)
    {
        await gate.WaitAsync(ct);
        try
        {
            var file = File(value.Id);
            var previous = await JsonStorage.ReadAsync<CoreAgentAuthorization>(file, ct);
            if (previous is not null)
            {
                RequireSameConversation(previous.Request.Conversation, value.Request.Conversation);
                if (value.Request.Operation == "runs.start" && CoreJson.Text(previous.Request with { Conversation = null })
                    != CoreJson.Text(value.Request with { Conversation = null }))
                    throw new CoreProviderException("execution_conflict", "Recover this run with its original input and workflow binding.", 409);
                // A fresh sign-in can resume the exact unadmitted command. Admitted work retains its
                // original authority and replacement provider implementations have a distinct lifecycle.
                if (expired is null || previous.GrantEpoch != expired.GrantEpoch || value.Request.Operation != "runs.start"
                    || previous.Admitted || previous.Authority is not null
                    || previous.Origin == value.Origin || previous.ImplementationIncarnation != value.ImplementationIncarnation
                    || previous.ProviderRevision != value.ProviderRevision || previous.CallerRevision != value.CallerRevision)
                    return previous;
                value = previous with { Origin = value.Origin, ExpiresAt = value.ExpiresAt, GrantEpoch = Guid.NewGuid().ToString("N") };
            }
            await JsonStorage.WriteOwnerFileAsync(file, value, ct); return value;
        }
        finally { gate.Release(); }
    }
    private static void RequireSameConversation(CoreAgentConversation? original, CoreAgentConversation? proposed)
    {
        if (original is not null && proposed is not null && (original.SessionId != proposed.SessionId || original.ViewerPath != proposed.ViewerPath))
            throw new CoreProviderException("execution_conflict", "Recover the run in its original consumer conversation.", 409);
    }

    // This admission-scoped gate spans workspace effects; the metadata gate never does.
    internal async Task<T> WithWorkspaceLease<T>(string id, Func<CoreAgentAuthorization, Task<T>> action, CancellationToken ct)
    {
        await Get(id, ct);
        WorkspaceGate workspaceGate;
        lock (workspaceGates)
        {
            if (!workspaceGates.TryGetValue(id, out workspaceGate!)) workspaceGates.Add(id, workspaceGate = new());
            workspaceGate.References++;
        }
        var entered = false;
        try
        {
            await workspaceGate.Semaphore.WaitAsync(ct); entered = true;
            return await action(await Get(id, ct));
        }
        finally
        {
            if (entered) workspaceGate.Semaphore.Release();
            // Count holders and queued/cancelled waiters before allowing a replacement gate.
            lock (workspaceGates)
                if (--workspaceGate.References == 0)
                {
                    workspaceGates.Remove(id);
                    workspaceGate.Semaphore.Dispose();
                }
        }
    }
    internal async Task<CoreAgentAuthorization> RecordLease(string id, CoreAgentLease lease, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var value = await Get(id, ct);
            if (value.WorkspaceLeasesClosed)
                throw new CoreProviderException("execution_conflict", "This execution's workspace leases are closed.", 409);
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
                if (previous.Released)
                    throw new CoreProviderException("execution_conflict", "The recorded workspace lease was already released.", 409);
                if (lease.WorktreeId.Length == 0) return value;
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
    internal const string Prefix = "hosty_agent.2.";
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
            ("GET", "runs.closure") => Guid.TryParse(input.RunId, out _) && path == $"/runs/{input.RunId}/closure",
            ("GET", "runs.events") => Guid.TryParse(input.RunId, out _) && path == $"/runs/{input.RunId}/events",
            ("POST", "runs.respond") => Guid.TryParse(input.RunId, out _) && path == $"/runs/{input.RunId}/responses",
            ("PUT", "runs.discard") => Guid.TryParse(input.RunId, out _) && path == $"/runs/{input.RunId}/discard",
            ("PUT", "runs.cancel") => Guid.TryParse(input.RunId, out _) && path == $"/runs/{input.RunId}/stop",
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
    private static string OriginalStartId(AppRecord consumer, string userId, string principalId, HostyProviderRef provider, string sessionId, string runId)
        => Hash(CoreJson.Text(new[] { "admission-v2", consumer.Id, consumer.InstalledAt.ToString("O"),
            userId, principalId, CoreJson.Text(provider), sessionId, runId }));

    internal async Task<CoreAgentBinding> Authorize(AppRecord consumer, string credential, CoreAgentAuthorizeRequest input, CancellationToken ct)
    {
        Validate(input);
        if (input.Operation == "runs.discard") throw DenyCleanup();
        ValidateWorkflowOwner(consumer, input);
        if (input.Conversation is { } conversation)
        {
            if (input.Operation != "runs.start") throw Invalid("Only a run admission carries an originating conversation.");
            conversation.Validate();
        }
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
                s => s.AllowsProvider("agent", input.Provider.AppId, input.Provider.Key, input.Provider.ImplementationId), ct);
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
        // Conversation navigation is consumer metadata. Keep the original admission identity across upgrades and title changes.
        var requestIdentity = CoreJson.Text(input with { Conversation = null }) + CoreJson.Text(origin) + caller.User.Id;
        // A run submission retains its original admission, even if the provider is updated.
        // Other operations can get fresh authority without making old signed references valid again.
        var id = input.Operation == "runs.start"
            ? OriginalStartId(consumer, caller.User.Id, caller.PrincipalId, input.Provider, input.SessionId!, input.RunId!)
            : Hash($"operation-v3:{CoreJson.Text(consumer.PermissionRevision)}:{CoreJson.Text(provider.PermissionRevision)}:{requestIdentity}");
        if (input.Operation != "runs.start" && descriptor.Incarnation is { } generation) id = Hash($"{id}:{generation}");
        var proposed = new CoreAgentAuthorization(id, origin, caller.User.Id, caller.PrincipalId,
            consumer.Id, consumer.InstalledAt, consumer.PermissionRevision, input, provider.PermissionRevision, expires, Authority: input.Authority, ImplementationIncarnation: descriptor.Incarnation, ProtocolVersion: 2);
        var record = await store.Put(proposed, ct);
        try { await ValidateRecord(provider, record, ct, admitted: false); }
        catch (AppIdentityException) when (input.Operation == "runs.start" && !record.Admitted && record.Authority is null && record.Origin != origin)
        {
            record = await store.Put(proposed, ct, expired: record);
            await ValidateRecord(provider, record, ct, admitted: false);
        }
        var tokenExpires = clock.UtcNow.AddMinutes(2); if (record.ExpiresAt < tokenExpires) tokenExpires = record.ExpiresAt;
        var token = SignToken(Prefix, new CoreAgentToken(id, tokenExpires.ToUnixTimeSeconds(), record.GrantEpoch));
        var managementAvailable = input.Authority is null && descriptor.Capabilities.Contains("workflow.profile-management")
            && ProviderAccessService.Describe(consumer, "agent-sessions", named: true).Any(session =>
                session is { Available: true, Version: 1 } && session.Capabilities.Contains(CoreProviderMediation.ProfileManagementCapability));
        return new(input.Provider, descriptor.Url!, token, tokenExpires, id, record.ExpiresAt,
            managementAvailable ? ["workflow.subagents", "workflow.profile-management"] : ["workflow.subagents"]);
    }
    private static ProviderDescriptor Descriptor(AppRecord provider, HostyProviderRef reference)
    {
        if (PanelIdentity.Installation(provider) != reference.InstallationId) throw new CoreProviderException("provider_unavailable", "The provider installation changed.", 503);
        var descriptor = ProviderAccessService.Find(provider, "agent", reference.Key, reference.ImplementationId);
        if (descriptor is not { Available: true, Version: 2, Url: not null }) throw new CoreProviderException("provider_unavailable", "The selected agent interface is unavailable.", 503);
        return descriptor;
    }
    internal async Task<(CoreAgentAuthorization Record, CoreCapabilityCaller Origin)> ValidateRecord(AppRecord provider,
        CoreAgentAuthorization record, CancellationToken ct, bool admitted = true)
    {
        if (record.ProtocolVersion != 2 || record.Request.Provider.AppId != provider.Id || record.Request.Provider.InstallationId != PanelIdentity.Installation(provider)
            || record.ProviderRevision != provider.PermissionRevision || record.ExpiresAt <= clock.UtcNow
            || admitted && !record.Admitted) throw new AppIdentityException("permission_denied", "This execution authority is unavailable.");
        if (Descriptor(provider, record.Request.Provider).Incarnation != record.ImplementationIncarnation)
            throw new AppIdentityException("permission_denied", "The admitted provider implementation changed.");
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
                "agent", record.Request.Provider, "agent_invoke", ct, retainedTask: record.Admitted);
            origin.Require("", CoreAppPermissions.AgentProviders);
        }
        if (!AppAccessPolicy.IsAdmin(origin.User)) throw new AppIdentityException("admin_required", "Native execution requires a current administrator.");
        return (record, origin);
    }
    internal CoreAgentInvocation Invocation(CoreAgentAuthorization record, CoreCapabilityCaller caller) => new(1, record.UserId,
        caller.User.Role, record.PrincipalId, record.CallerAppId, record.CallerInstallation.ToString("O"),
        record.Request.Provider, record.Request.Operation, record.Request.Resources, record.Id, record.Request.SessionId,
        record.Request.RunId, record.Request.ConfigurationDigest, record.Request.Ceiling, record.ExpiresAt);
    private string SignToken<T>(string prefix, T claims)
    {
        var payload = prefix + Encode(JsonSerializer.SerializeToUtf8Bytes(claims, CoreJson.TypeInfo<T>()));
        return payload + "." + Encode(signing.Sign(Encoding.UTF8.GetBytes(payload)));
    }
    private T ReadToken<T>(string prefix, string? token) where T : class
    {
        try
        {
            if (token is null || token.Length > 8192 || !token.StartsWith(prefix, StringComparison.Ordinal)) throw new FormatException();
            var parts = token[prefix.Length..].Split('.');
            if (parts.Length != 2 || !signing.Verify(Encoding.UTF8.GetBytes(prefix + parts[0]), Decode(parts[1]))) throw new FormatException();
            return JsonSerializer.Deserialize(Decode(parts[0]), CoreJson.TypeInfo<T>()) ?? throw new FormatException();
        }
        catch (Exception ex) when (ex is FormatException or JsonException or ArgumentException or CryptographicException)
        { throw new AppIdentityException("token_invalid", "Invalid agent credential."); }
    }
    internal async Task<CoreAgentInvocation> Introspect(AppRecord provider, CoreAgentIntrospection input, CancellationToken ct)
    {
        if (input.Token?.StartsWith(CleanupPrefix, StringComparison.Ordinal) == true)
            return await IntrospectCleanup(provider, input, ct);
        var token = ReadToken<CoreAgentToken>(Prefix, input.Token);
        if (token.Expires <= clock.UtcNow.ToUnixTimeSeconds()) throw new AppIdentityException("token_invalid", "The operation credential expired.");
        var record = await store.Get(token.Id, ct);
        if (record.GrantEpoch != token.GrantEpoch || record.Request.Operation != input.Operation || record.Request.Method != input.Method || record.Request.Path != input.Path
            || record.Request.BodyHash != input.BodyHash) throw new AppIdentityException("permission_denied", "This credential is bound to another exact operation.");
        var (_, caller) = await ValidateRecord(provider, record, ct, admitted: false);
        return Invocation(record, caller);
    }
    internal async Task<CoreAgentInvocation> Admit(AppRecord provider, string reference, CancellationToken ct, string? generation = null)
    {
        var record = await store.Get(reference, ct);
        var (_, caller) = await ValidateRecord(provider, record, ct, admitted: false);
        if (record.Request.Operation != "runs.start") throw Invalid("Only a run submission can establish execution authority.");
        if (generation is not null) CoreProviderMediation.ValidateId(generation);
        record = await store.Change(reference, r =>
        {
            if (r.Generation is not null && generation is not null && generation != r.Generation)
                throw new CoreProviderException("execution_conflict", "This admission already belongs to another provider run generation.", 409);
            return r with { Admitted = true, Generation = r.Generation ?? generation };
        }, ct);
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
            if (record.ProtocolVersion != 2 || !record.Admitted || record.Request.Operation != "runs.start" || record.Request.Provider.AppId != provider.Id
                || record.Request.Provider.InstallationId != PanelIdentity.Installation(provider))
                throw new AppIdentityException("permission_denied", "This provider does not own the admitted question source.");
            var (user, _) = await identity.RequireAccessibleUserAsync(provider.Id, record.UserId, ct);
            return new(user, record.PrincipalId, provider, null) { AgentExecution = record.Id, RetainedAgentObservation = true };
        }
        var (_, origin) = await ValidateRecord(provider, record, ct);
        return new(origin.User, record.PrincipalId, provider, null) { AgentExecution = record.Id };
    }
}
