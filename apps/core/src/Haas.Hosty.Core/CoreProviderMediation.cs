using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using HostySdk.App;

namespace Haas.Hosty.Core;

internal sealed record CoreProviderPolicy(string Kind, string Operation, string ToolName, string[] Scopes,
    string[] Permissions, string? Capability = null, bool Administrator = false, bool Mutation = false)
{
    internal void Require(CoreCapabilityCaller caller)
    {
        if (Administrator && !AppAccessPolicy.IsAdmin(caller.User))
            throw new AppIdentityException("admin_required", "Native execution requires a current administrator.");
        if (caller.App is not null)
            foreach (var permission in Permissions) caller.Require("", permission);
        else foreach (var scope in Scopes) caller.Require(scope, "");
    }
    internal static CoreProviderPolicy For(string kind, string operation)
    {
        if (kind == "tasks" && operation is "options" or "list" or "get" or "create" or "edit" or "action" or "execute")
        {
            var write = operation is "create" or "edit" or "action" or "execute";
            return new(kind, operation, "task_" + (operation == "execute" ? "action" : operation),
                [AccessTokenScopes.McpTasksRead, .. write ? new[] { AccessTokenScopes.McpTasksWrite } : [], .. operation == "execute" ? new[] { AccessTokenScopes.McpTasksExecute } : []],
                [CoreAppPermissions.TaskProviders, CoreAppPermissions.TasksRead, .. write ? new[] { CoreAppPermissions.TasksWrite } : [],
                    .. operation == "execute" ? new[] { CoreAppPermissions.TasksExecute, CoreAppPermissions.TaskExecutors } : []], Mutation: write);
        }
        if (kind == "task-executor" && operation is "dispatch.options" or "dispatch.get" or "dispatch.accept" or "dispatch.cancel")
            return new(kind, operation, "task_action", [AccessTokenScopes.McpTasksRead, AccessTokenScopes.McpTasksWrite, AccessTokenScopes.McpTasksExecute],
                [CoreAppPermissions.TaskProviders, CoreAppPermissions.TaskExecutors, CoreAppPermissions.TasksRead, CoreAppPermissions.TasksWrite, CoreAppPermissions.TasksExecute], Administrator: true);
        if (kind == "task-executor" && operation == "options")
            return new(kind, operation, "task_options", [AccessTokenScopes.McpTasksRead], [CoreAppPermissions.TaskExecutors, CoreAppPermissions.TasksRead]);
        if (kind == "agent-sessions")
        {
            var details = operation switch
            {
                "sessions.query" => ("agent_session_list", "session.list"),
                "sessions.get" => ("agent_session_get", "session.read"),
                "runs.get" => ("agent_run_get", "session.read"),
                "runs.notifications" => ("agent_run_get", "run.events"),
                "runs.cancel" => ("agent_run_cancel", "run.cancel"),
                _ => throw Invalid(),
            };
            var control = operation == "runs.cancel";
            return new(kind, operation, details.Item1,
                [AccessTokenScopes.McpAgentSessionsRead, .. control ? new[] { AccessTokenScopes.McpAgentSessionsControl } : []],
                [CoreAppPermissions.AgentSessionProviders, CoreAppPermissions.AgentSessionsRead, .. control ? new[] { CoreAppPermissions.AgentSessionsControl } : []],
                details.Item2, true, control);
        }
        if (kind == "conversation-history")
        {
            if (operation is "exports.create" or "exports.get" or "exports.acknowledge" or "exports.revoke")
            {
                var control = operation is "exports.get" or "exports.acknowledge";
                return new(kind, operation, "history_export_" + operation["exports.".Length..],
                    control ? [] : [AccessTokenScopes.McpHistoryRead, AccessTokenScopes.McpHistoryExport],
                    control ? [CoreAppPermissions.HistoryProviders] : [CoreAppPermissions.HistoryProviders, CoreAppPermissions.HistoryRead, CoreAppPermissions.HistoryExport],
                    Mutation: operation != "exports.get");
            }
            var details = operation switch
            {
                "capabilities" => ("history_capabilities", "history.read"),
                "conversations.query" => ("conversation_list", "history.read"),
                "conversations.get" => ("conversation_get", "history.read"),
                "entries.query" => ("history_read", "history.read"),
                "entries.get" => ("history_entry_get", "history.read"),
                "search" => ("history_search", "history.search.text"),
                "notifications" => ("history_read", "history.changes"),
                "shares.query" => ("history_share_list", "history.sharing"),
                "shares.create" => ("history_share_create", "history.sharing"),
                "shares.revoke" => ("history_share_revoke", "history.sharing"),
                "attachments.resolve" or "attachments.content" => ("history_attachment_get", "history.attachments"),
                "exports.snapshot" => ("history_export_snapshot", "history.changes"),
                "exports.changes" => ("history_export_changes", "history.changes"),
                _ => throw Invalid(),
            };
            var sharing = operation is "shares.create" or "shares.revoke";
            var export = operation.StartsWith("exports.", StringComparison.Ordinal);
            return new(kind, operation, details.Item1,
                [AccessTokenScopes.McpHistoryRead, .. sharing ? new[] { AccessTokenScopes.McpHistoryShare } : [], .. export ? new[] { AccessTokenScopes.McpHistoryExport } : []],
                [CoreAppPermissions.HistoryProviders, CoreAppPermissions.HistoryRead, .. sharing ? new[] { CoreAppPermissions.HistoryShare } : [], .. export ? new[] { CoreAppPermissions.HistoryExport } : []],
                details.Item2, Mutation: sharing);
        }
        throw Invalid();
    }
    private static AppIdentityException Invalid() => new("unsupported_capability", "Use a declared version-one provider operation.");
}
internal sealed record CoreProviderClaims(int Version, string UserId, string PrincipalId, CoreCallerAuthority Origin,
    HostyProviderRef Provider, string? ProviderRevision, string Kind, string Operation, string Method, string Path,
    string BodyHash, string[] ResourceIds, long Expires, CoreHistoryExportScope? Export = null, CoreTaskDispatchRef? TaskDispatch = null, CoreTaskExecutorDelegation? TaskDelegation = null);
internal sealed record CoreProviderIntrospectionRequest(string Token, string Kind, string Key, string Operation,
    string Method, string Path, string BodyHash);
internal sealed record CoreProviderInvocation(int Version, string UserId, string HostRole, string PrincipalId,
    string? CallerAppId, string? CallerInstallation, string Kind, string Key, string Operation, string[] ResourceIds, CoreHistoryExportScope? Export = null, CoreTaskDispatchRef? TaskDispatch = null, CoreTaskExecutorDelegation? TaskDelegation = null);
internal sealed record CoreProviderBinding(string Token, ProviderDescriptor Descriptor);
internal sealed record CoreProviderError(string Code, string Message, bool Retryable, string? OperationRef = null);
internal sealed record CoreProviderFailure(CoreProviderError Error);
internal sealed class CoreProviderException(string code, string message, int status, bool retryable = false, string? operationRef = null) : Exception(message)
{
    internal int Status { get; } = status;
    internal CoreProviderError Error { get; } = new(code, message, retryable, operationRef);
}

internal sealed partial class CoreProviderMediation(AppRegistryStore apps, AppIdentityService identity, CoreCapabilityAuthorization authorization,
    DelegatedTokenSigningKey signing, IClock clock, IHttpClientFactory clients, CoreProviderOperationStore operations, CoreHistoryExportStore historyExports)
{
    internal const string Prefix = "hosty_provider.2.";
    internal const string ClientName = "core-provider";
    internal const int MaxBytes = 1024 * 1024;

    internal async Task<ProviderDirectory> ListAsync(CoreCapabilityCaller caller, string kind, CancellationToken ct)
    {
        var policy = CoreProviderPolicy.For(kind, kind == "tasks" ? "list" : kind == "task-executor" ? "options" : kind == "agent-sessions" ? "sessions.get" : "capabilities");
        // Discovery carries no content, but still needs current client permission and provider access.
        if (caller.App is not null) caller.Require("", ProviderAccessService.Permission(kind));
        else caller.Require(policy.Scopes[0], "");
        var result = new List<ProviderDescriptor>();
        foreach (var app in await apps.ListAppRecordsAsync(ct))
        {
            var descriptors = ProviderAccessService.Describe(app, kind).ToArray();
            if (descriptors.Length == 0) continue;
            try { await identity.RequireAccessibleUserAsync(app.Id, caller.User.Id, ct); }
            catch (AppIdentityException) { continue; }
            // Transport origins belong only to Core and the selected provider backend.
            result.AddRange(descriptors.Select(d => d with { Url = null }));
        }
        return new(result);
    }
    internal async Task<ProviderDescriptor> ResolveAsync(CoreCapabilityCaller caller, HostyProviderRef provider, string kind, CancellationToken ct)
    {
        ValidateReference(provider);
        var app = await apps.GetAppAsync(provider.AppId, ct);
        if (app is null || PanelIdentity.Installation(app) != provider.InstallationId)
            throw new CoreProviderException("provider_unavailable", "The selected provider installation is unavailable.", 503, true);
        await identity.RequireAccessibleUserAsync(app.Id, caller.User.Id, ct);
        return ProviderAccessService.Describe(app, kind).SingleOrDefault(d => d.Key == provider.Key)
            ?? throw new CoreProviderException("provider_unavailable", "The selected installation does not declare this interface.", 503, true);
    }
    internal async Task<CoreProviderBinding> IssueAsync(CoreCapabilityCaller caller, HostyProviderRef provider,
        CoreProviderPolicy policy, string method, string path, byte[] body, string[] resources, CancellationToken ct, CoreTaskDispatchRef? taskDispatch = null, CoreTaskExecutorDelegation? taskDelegation = null)
    {
        ValidateReference(provider);
        if (caller.Authority is null) throw new AppIdentityException("permission_denied", "Current originating authority is required.");
        caller = await authorization.RevalidateAsync(caller.Authority, caller.User.Id, caller.PrincipalId, policy.Kind, provider.AppId, provider.Key, policy.ToolName, ct);
        policy.Require(caller);
        var descriptor = await ResolveAsync(caller, provider, policy.Kind, ct);
        if (descriptor.Version != 1) throw new CoreProviderException("version_unsupported", "The selected provider does not implement version 1.", 422);
        if (!descriptor.Available || descriptor.Url is null) throw new CoreProviderException("provider_unavailable", "The selected provider is not ready.", 503, true);
        if (policy.Capability is { } capability && !descriptor.Capabilities.Contains(capability))
            throw new CoreProviderException("unsupported_capability", "The provider does not declare " + capability + ".", 422);
        if (!Uri.TryCreate(descriptor.Url, UriKind.Absolute, out var endpoint) || endpoint.Scheme is not ("http" or "https")
            || endpoint.UserInfo.Length != 0 || endpoint.Query.Length != 0 || endpoint.Fragment.Length != 0
            || !path.StartsWith('/') || path.StartsWith("//", StringComparison.Ordinal) || path.Contains('#')
            || body.Length > MaxBytes || resources.Length > 16)
            throw new CoreProviderException("budget_exceeded", "The provider request exceeds its supported transport bounds.", 422);
        foreach (var id in resources) ValidateId(id);
        var app = (await apps.GetAppAsync(provider.AppId, ct))!;
        var export = await ExportScopeAsync(caller, provider, policy, ct);
        var claims = new CoreProviderClaims(2, caller.User.Id, caller.PrincipalId, caller.Authority!, provider,
            app.PermissionRevision, policy.Kind, policy.Operation, method, path, Hash(body), resources, clock.UtcNow.AddSeconds(120).ToUnixTimeSeconds(), export, taskDispatch, taskDelegation);
        var data = Prefix + Encode(JsonSerializer.SerializeToUtf8Bytes(claims, CoreJson.TypeInfo<CoreProviderClaims>()));
        return new(data + "." + Encode(signing.Sign(Encoding.UTF8.GetBytes(data))), descriptor);
    }
    internal async Task<CoreProviderInvocation> IntrospectAsync(AppRecord provider, CoreProviderIntrospectionRequest input, CancellationToken ct)
    {
        CoreProviderClaims claims;
        try
        {
            if (input.Token.Length > 32768 || !input.Token.StartsWith(Prefix, StringComparison.Ordinal)) throw new FormatException();
            var parts = input.Token[Prefix.Length..].Split('.');
            if (parts.Length != 2 || !signing.Verify(Encoding.UTF8.GetBytes(Prefix + parts[0]), Decode(parts[1]))) throw new FormatException();
            claims = JsonSerializer.Deserialize(Decode(parts[0]), CoreJson.TypeInfo<CoreProviderClaims>()) ?? throw new FormatException();
        }
        catch (Exception ex) when (ex is FormatException or JsonException or CryptographicException or ArgumentException)
        { throw new AppIdentityException("token_invalid", "Invalid mediated provider credential."); }
        if (claims.Version != 2 || claims.Expires <= clock.UtcNow.ToUnixTimeSeconds() || claims.Provider.AppId != provider.Id
            || claims.Provider.InstallationId != PanelIdentity.Installation(provider) || claims.ProviderRevision != provider.PermissionRevision
            || claims.Kind != input.Kind || claims.Provider.Key != input.Key || claims.Operation != input.Operation
            || claims.Method != input.Method || claims.Path != input.Path || claims.BodyHash != input.BodyHash)
            throw new AppIdentityException("token_invalid", "The credential does not match this exact current provider operation.");
        var policy = CoreProviderPolicy.For(claims.Kind, claims.Operation);
        if (claims.Kind == "task-executor" && claims.Operation.StartsWith("dispatch.", StringComparison.Ordinal)
            && (claims.TaskDelegation is null || claims.Origin.Kind != "task-dispatch"
                || claims.TaskDelegation.Dispatch != claims.Origin.TaskDispatch))
            throw new AppIdentityException("token_invalid", "Executor dispatch requires its exact Core authorization.");
        var caller = await authorization.RevalidateAsync(claims.Origin, claims.UserId, claims.PrincipalId, claims.Kind, provider.Id, claims.Provider.Key, policy.ToolName, ct);
        policy.Require(caller);
        var descriptor = await ResolveAsync(caller, claims.Provider, claims.Kind, ct);
        if (!descriptor.Available || descriptor.Version != 1 || policy.Capability is { } capability && !descriptor.Capabilities.Contains(capability))
            throw new AppIdentityException("provider_unavailable", "The reviewed provider interface changed or is unavailable.");
        var export = await ExportScopeAsync(caller, claims.Provider, policy, ct);
        if (CoreJson.Text(export) != CoreJson.Text(claims.Export)) throw new AppIdentityException("permission_denied", "The approved export corpus changed.");
        return new(2, caller.User.Id, caller.User.Role, caller.PrincipalId, caller.App?.Id,
            caller.App is null ? null : PanelIdentity.Installation(caller.App), claims.Kind, claims.Provider.Key, claims.Operation, claims.ResourceIds, export, claims.TaskDispatch, claims.TaskDelegation);
    }
    internal async Task<JsonElement> SendAsync<T>(CoreCapabilityCaller caller, HostyProviderRef provider, CoreProviderPolicy policy,
        string method, string path, T input, string[] resources, string? requestId, CancellationToken ct,
        CoreTaskDispatchRef? taskDispatch = null, CoreTaskExecutorDelegation? taskDelegation = null)
    {
        ValidateReference(provider);
        var body = RequestBody(input, policy.Mutation ? requestId = CoreProviderOperationStore.Normalize(requestId) : null);
        async Task<JsonElement> Dispatch()
        {
            var binding = await IssueAsync(caller, provider, policy, method, path, body, resources, ct, taskDispatch, taskDelegation);
            using var request = new HttpRequestMessage(new HttpMethod(method), binding.Descriptor.Url!.TrimEnd('/') + path);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", binding.Token);
            request.Headers.Accept.Add(new("application/json"));
            if (body.Length > 0) { request.Content = new ByteArrayContent(body); request.Content.Headers.ContentType = new("application/json"); }
            try
            {
                using var response = await clients.CreateClient(ClientName).SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
                var bytes = await ReadBoundedAsync(response.Content, ct);
                using var document = JsonDocument.Parse(bytes);
                if (!response.IsSuccessStatusCode)
                {
                    var error = document.RootElement.TryGetProperty("error", out var nested) && nested.ValueKind == JsonValueKind.Object ? nested : document.RootElement;
                    throw new CoreProviderException(error.TryGetProperty("code", out var code) ? code.GetString() ?? "provider_failed" : "provider_failed",
                        error.TryGetProperty("message", out var message) ? message.GetString() ?? "Provider request failed." : "Provider request failed.",
                        (int)response.StatusCode, (int)response.StatusCode >= 500, requestId);
                }
                // Recheck originating grants before delivering data after a slow provider call.
                var fresh = await authorization.RevalidateAsync(caller.Authority!, caller.User.Id, caller.PrincipalId, policy.Kind, provider.AppId, provider.Key, policy.ToolName, ct);
                policy.Require(fresh);
                await ExportScopeAsync(fresh, provider, policy, ct);
                return document.RootElement.Clone();
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
            { throw new CoreProviderException("provider_unavailable", policy.Mutation ? "The provider outcome is uncertain. Recover using the same request ID and unchanged input." : "The provider did not return a valid bounded response.", 503, true, requestId); }
        }
        policy.Require(caller);
        return policy.Mutation
            ? await operations.ExecuteAsync(caller, provider, policy, method, path, body, requestId, Dispatch, ct)
            : await Dispatch();
    }
    internal static byte[] RequestBody<T>(T input, string? requestId = null)
    {
        var body = input is null ? [] : JsonSerializer.SerializeToUtf8Bytes(input, CoreJson.TypeInfo<T>());
        if (requestId is null) return body;
        var value = System.Text.Json.Nodes.JsonNode.Parse(body) as System.Text.Json.Nodes.JsonObject
            ?? throw new CoreProviderException("invalid_input", "A provider mutation requires an object payload.", 400);
        value["requestId"] = Guid.Parse(requestId).ToString("D");
        return Encoding.UTF8.GetBytes(value.ToJsonString());
    }
    private async Task<CoreHistoryExportScope?> ExportScopeAsync(CoreCapabilityCaller caller, HostyProviderRef provider, CoreProviderPolicy policy, CancellationToken ct)
    {
        if (policy.Kind != "conversation-history" || !policy.Operation.StartsWith("exports.", StringComparison.Ordinal)) return null;
        if (caller.Authority?.ExportGrantId is not { } id) throw new CoreProviderException("permission_denied", "An exact owner-approved export grant is required.", 403);
        var record = await historyExports.ReadAsync(id, ct);
        if (!CoreHistoryExportStore.IsConsumer(record, caller)) throw CoreHistoryExportStore.Missing();
        return historyExports.Scope(record, provider);
    }
    internal static async Task<byte[]> ReadBoundedAsync(HttpContent content, CancellationToken ct)
    {
        if (content.Headers.ContentLength > MaxBytes) throw new CoreProviderException("budget_exceeded", "Provider response exceeds 1 MiB.", 422);
        await using var source = await content.ReadAsStreamAsync(ct); using var result = new MemoryStream();
        var buffer = new byte[16384]; int count;
        while ((count = await source.ReadAsync(buffer, ct)) > 0)
        {
            if (result.Length + count > MaxBytes) throw new CoreProviderException("budget_exceeded", "Provider response exceeds 1 MiB.", 422);
            result.Write(buffer, 0, count);
        }
        return result.ToArray();
    }
    internal static void ValidateReference(HostyProviderRef? reference)
    {
        if (reference is null) throw new CoreProviderException("provider_selection_required", "Select a provider installation and interface explicitly.", 400);
        ValidateId(reference.AppId); ValidateId(reference.InstallationId); ValidateId(reference.Key);
    }
    internal static void ValidateId(string? id)
    {
        if (string.IsNullOrWhiteSpace(id) || id.Length > 256 || id.Any(char.IsControl))
            throw new CoreProviderException("invalid_reference", "References require opaque IDs of 1 to 256 characters.", 400);
    }
    internal static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
    private static string Encode(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static byte[] Decode(string text)
    {
        var value = text.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(value.PadRight(value.Length + (4 - value.Length % 4) % 4, '='));
    }
}
