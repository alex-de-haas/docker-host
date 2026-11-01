using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using HostySdk.App;

namespace Haas.Hosty.Core;

// Routing receipts contain references and digests only. Provider-owned content and exact mutation
// results stay at the source; an uncertain delivery is recovered with the same provider request ID.
internal sealed record CoreProviderOperationReceipt(string RequestId, string UserId, string PrincipalId,
    HostyProviderRef? Provider, string Kind, string Operation, string Fingerprint, string State,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, string? ResourceId = null, string? ClassificationFingerprint = null, CoreTaskDispatchAuthorization? TaskAuthorization = null);
internal sealed class CoreProviderOperationStore(CoreDataPaths paths, IClock clock)
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> gates = new(StringComparer.Ordinal);
    private string PathFor(CoreCapabilityCaller caller, string requestId) => PathFor(caller.User.Id, caller.PrincipalId, requestId);
    private string PathFor(string userId, string principalId, string requestId)
    {
        var principal = SandboxValidation.Hash(userId + "|" + principalId);
        var file = Path.Combine(paths.CoreRoot, "provider-operations", principal, Normalize(requestId) + ".json");
        if (CoreDataPaths.ContainsSymbolicLink(paths.DataRoot, file))
            throw new CoreProviderException("permission_denied", "Provider receipt storage must not contain symbolic links.", 403);
        return file;
    }
    internal static string Normalize(string? id) => Guid.TryParse(id, out var value) ? value.ToString("N")
        : throw new CoreProviderException("request_id_required", "Persist a request UUID before a provider mutation.", 400);
    internal async Task<CoreProviderOperationReceipt> GetAsync(CoreCapabilityCaller caller, string requestId, CancellationToken ct)
        => await JsonStorage.ReadAsync<CoreProviderOperationReceipt>(PathFor(caller, requestId), ct)
            ?? throw new CoreProviderException("not_found", "Operation not found.", 404);
    internal async Task<JsonElement> ExecuteAsync(CoreCapabilityCaller caller, HostyProviderRef provider, CoreProviderPolicy policy,
        string method, string route, byte[] body, string? requestId, Func<Task<JsonElement>> action, CancellationToken ct)
    {
        var fingerprint = Fingerprint(provider, policy, method, route, body);
        return await ExecuteReceiptAsync(caller, requestId, provider, policy.Kind, policy.Operation, null, fingerprint, action, ct);
    }
    internal static string Fingerprint(HostyProviderRef provider, CoreProviderPolicy policy, string method, string route, byte[] body)
        => CoreProviderMediation.Hash(Encoding.UTF8.GetBytes(CoreJson.Text(provider) + "|" + policy.Kind + "|" + policy.Operation + "|" + method + "|" + route + "|" + CoreProviderMediation.Hash(body)));
    internal async Task<CoreProviderOperationReceipt> TaskDispatchAsync(CoreTaskDispatchRef reference, CancellationToken ct)
        => await JsonStorage.ReadAsync<CoreProviderOperationReceipt>(PathFor(reference.UserId, reference.PrincipalId, reference.RequestId), ct)
            ?? throw new CoreProviderException("not_found", "Task dispatch authorization not found.", 404);
    internal async Task BindTaskWorkspaceAsync(CoreTaskDispatchRef reference, string sessionId, string leaseId, CancellationToken ct)
    {
        var path = PathFor(reference.UserId, reference.PrincipalId, reference.RequestId);
        var gate = gates.GetOrAdd(path, _ => new(1, 1)); await gate.WaitAsync(ct);
        try
        {
            var receipt = await TaskDispatchAsync(reference, ct);
            var grant = receipt.TaskAuthorization ?? throw new CoreProviderException("permission_denied", "Dispatch authorization is unavailable.", 403);
            if (grant.Scope.SessionId is { } session && session != sessionId || grant.Scope.LeaseId is { } lease && lease != leaseId)
                throw new CoreProviderException("request_conflict", "This task attempt already admitted another native session or lease.", 409);
            if (grant.Scope.SessionId is null || grant.Scope.LeaseId is null)
                await JsonStorage.WriteAsync(path, receipt with { TaskAuthorization = grant with { Scope = grant.Scope with { SessionId = sessionId, LeaseId = leaseId } } }, true, ct);
        }
        finally { gate.Release(); }
    }
    internal async Task BindTaskExecutionAsync(CoreTaskDispatchRef reference, string executionId, CancellationToken ct)
    {
        var path = PathFor(reference.UserId, reference.PrincipalId, reference.RequestId);
        var gate = gates.GetOrAdd(path, _ => new(1, 1)); await gate.WaitAsync(ct);
        try
        {
            var receipt = await TaskDispatchAsync(reference, ct);
            var grant = receipt.TaskAuthorization ?? throw new CoreProviderException("permission_denied", "Dispatch authorization is unavailable.", 403);
            if (grant.Scope.ExecutionId is { } bound && bound != executionId)
                throw new CoreProviderException("request_conflict", "This action already authorized another execution attempt.", 409);
            if (grant.Scope.ExecutionId is null)
                await JsonStorage.WriteAsync(path, receipt with { TaskAuthorization = grant with { Scope = grant.Scope with { ExecutionId = executionId } } }, true, ct);
        }
        finally { gate.Release(); }
    }
    internal async Task<CoreProviderOperationReceipt> PrepareTaskActionAsync(CoreCapabilityCaller caller, CoreTaskAction input,
        Func<Task<(CoreProviderPolicy Policy, CoreTaskExecutionScope? Scope)>> classify, CancellationToken ct)
    {
        var id = Normalize(input.Input.RequestId); var path = PathFor(caller, id);
        var normalized = input with { Input = input.Input with { RequestId = Guid.Parse(id).ToString("D") } };
        var stamp = CoreProviderMediation.Hash(Encoding.UTF8.GetBytes(CoreJson.Text(normalized)));
        var gate = gates.GetOrAdd(path, _ => new(1, 1)); await gate.WaitAsync(ct);
        try
        {
            var prior = await JsonStorage.ReadAsync<CoreProviderOperationReceipt>(path, ct);
            if (prior is not null)
            {
                if (prior.ClassificationFingerprint != stamp || prior.UserId != caller.User.Id || prior.PrincipalId != caller.PrincipalId)
                    throw new CoreProviderException("request_conflict", "Recover this task action with its original input.", 409, operationRef: id);
                return prior;
            }
            var (policy, scope) = await classify(); policy.Require(caller);
            var provider = new HostyProviderRef(input.TaskRef.AppId, input.TaskRef.InstallationId, input.TaskRef.Key);
            var body = CoreProviderMediation.RequestBody(normalized.Input, id);
            var route = "/tasks/" + Uri.EscapeDataString(input.TaskRef.Id) + "/actions";
            var receipt = new CoreProviderOperationReceipt(id, caller.User.Id, caller.PrincipalId, provider, "tasks", policy.Operation,
                Fingerprint(provider, policy, "POST", route, body), "prepared", clock.UtcNow, clock.UtcNow,
                ClassificationFingerprint: stamp, TaskAuthorization: scope is null ? null : new(caller.Authority!, scope));
            await JsonStorage.WriteAsync(path, receipt, true, ct); return receipt;
        }
        finally { gate.Release(); }
    }
    internal async Task<T> ExecuteLocalAsync<T>(CoreCapabilityCaller caller, string requestId, string kind, string operation,
        string? resourceId, string input, Func<Task<T>> action, CancellationToken ct)
    {
        var stamp = CoreProviderMediation.Hash(Encoding.UTF8.GetBytes(kind + "|" + operation + "|" + input));
        var result = await ExecuteReceiptAsync(caller, requestId, null, kind, operation, resourceId, stamp,
            async () => JsonSerializer.SerializeToElement(await action(), CoreJson.TypeInfo<T>()), ct);
        return result.Deserialize(CoreJson.TypeInfo<T>())!;
    }
    private async Task<JsonElement> ExecuteReceiptAsync(CoreCapabilityCaller caller, string? requestId, HostyProviderRef? provider,
        string kind, string operation, string? resourceId, string fingerprint, Func<Task<JsonElement>> action, CancellationToken ct)
    {
        var id = Normalize(requestId); var path = PathFor(caller, id);
        var gate = gates.GetOrAdd(path, _ => new(1, 1)); await gate.WaitAsync(ct);
        try
        {
            var prior = await JsonStorage.ReadAsync<CoreProviderOperationReceipt>(path, ct);
            if (prior is not null && (prior.Fingerprint != fingerprint || prior.UserId != caller.User.Id || prior.PrincipalId != caller.PrincipalId))
                throw new CoreProviderException("request_conflict", "This request UUID already identifies different input. Recover with its original input.", 409, operationRef: id);
            if (prior?.State == "expired") throw new CoreProviderException("request_expired", "This retired request UUID cannot be reused.", 410, operationRef: id);
            // Compact receipts are retained indefinitely, so old UUIDs cannot accidentally become new
            // creates. No transcript or result payload is retained merely for routing recovery.
            var receipt = prior ?? new(id, caller.User.Id, caller.PrincipalId, provider, kind, operation,
                fingerprint, "pending", clock.UtcNow, clock.UtcNow, resourceId);
            receipt = receipt with { State = "pending", UpdatedAt = clock.UtcNow };
            await JsonStorage.WriteAsync(path, receipt, true, ct);
            try
            {
                var result = await action();
                var pending = result.ValueKind == JsonValueKind.Object && result.TryGetProperty("state", out var state)
                    && state.ValueKind == JsonValueKind.String && state.GetString() is "pending" or "accepted";
                await JsonStorage.WriteAsync(path, receipt with { State = pending ? "pending" : "completed", UpdatedAt = clock.UtcNow }, true, CancellationToken.None);
                return result;
            }
            catch (Exception ex) when (ex is CoreProviderException or AppIdentityException or OperationCanceledException)
            {
                await JsonStorage.WriteAsync(path, receipt with { State = ex is OperationCanceledException or CoreProviderException { Status: >= 500 } ? "unknown" : "failed", UpdatedAt = clock.UtcNow }, true, CancellationToken.None);
                throw;
            }
        }
        finally { gate.Release(); }
    }
}
