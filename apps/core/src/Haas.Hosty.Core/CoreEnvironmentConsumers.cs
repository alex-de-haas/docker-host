using HostySdk.App;

namespace Haas.Hosty.Core;

internal sealed record CoreEnvironmentConsumerRegister(string ConsumerId, string RequestId,
    long ExpectedEnvironmentRevision, HostyRunRef? Run = null);
internal sealed record CoreEnvironmentStopEvidence(string Kind, DateTimeOffset ObservedAt, string Reason);
internal sealed record CoreEnvironmentConsumerRelease(string ConsumerId, string RequestId, long ExpectedRevision,
    CoreEnvironmentStopEvidence StopEvidence);
internal sealed record CoreEnvironmentConsumer(string ConsumerId, string EnvironmentId, string PrincipalId,
    HostyRunRef? Run, long Revision, DateTimeOffset ObservedAt, string State, CoreEnvironmentStopEvidence? StopEvidence = null);
internal sealed record CoreEnvironmentConsumerResult(string RequestId, long EnvironmentRevision, CoreEnvironmentConsumer Consumer);
internal sealed record CoreEnvironmentConsumerOperation(string RequestId, string Kind, string PrincipalId, string Fingerprint,
    DateTimeOffset ObservedAt, CoreEnvironmentConsumerResult Result);

// Resolves through the reviewed agent-sessions interface with current caller and resource authority.
internal interface ICoreAgentRunAccess
{
    Task<HostyAgentRun> ReadRunAsync(CoreCapabilityCaller caller, HostyRunRef run, CancellationToken ct);
}

internal sealed partial class CoreEnvironmentService
{
    private static string ConsumerPrincipal(SandboxActor actor) => actor.Capability?.PrincipalId ?? actor.PrincipalId
        ?? (actor.AppId is not null ? "legacy-app:" + actor.Key : "operator:" + actor.UserId);

    internal async Task<CoreEnvironmentConsumerResult> RegisterConsumerAsync(SandboxActor actor, string id,
        CoreEnvironmentConsumerRegister input, CancellationToken ct)
    {
        input = input with { RequestId = RequestId(input.RequestId), ConsumerId = RequestId(input.ConsumerId) };
        var principal = ConsumerPrincipal(actor);
        var fingerprint = SandboxValidation.Hash(CoreJson.Text(input));
        var gate = Gate(id); await gate.WaitAsync(ct);
        try
        {
            var record = await RequireAsync(actor, id, ct);
            if (ConsumerReplay(record, input.RequestId, "register", principal, fingerprint) is { } replay) return replay;
            ConsumerCapacity(record);
            if (!accepting || record.State is "finished" or "finishing" or "cleanup-failed" or "stopping" || record.RootDeletionStarted
                || record.Operations?.Any(o => o.State == "running") == true)
                throw new SandboxException("environment_consumer_admission_closed", "The environment is changing lifecycle or has finished. Observe it before starting a consumer.");
            if (record.Revision != input.ExpectedEnvironmentRevision)
                throw new SandboxException("environment_revision_conflict", "Read the current environment before registering a consumer.");
            if (record.Consumers?.Any(c => c.ConsumerId == input.ConsumerId) == true)
                throw new SandboxException("environment_consumer_exists", "This consumer identity is already registered. Replay its original request or allocate a new identity.");
            if (input.Run is not null)
            {
                var run = await ConsumerRunAsync(actor, input.Run, ct);
                if (run.Freshness != "current" || run.StopConfirmed)
                    throw new SandboxException("environment_consumer_run_unavailable", "Register a currently accessible execution before it terminates.");
            }
            var consumer = new CoreEnvironmentConsumer(input.ConsumerId, id, principal, input.Run, 1, clock.UtcNow, "active");
            return await SaveConsumerAsync(record, consumer, input.RequestId, "register", principal, fingerprint, ct);
        }
        finally { gate.Release(); }
    }

    internal async Task<CoreEnvironmentConsumerResult> ReleaseConsumerAsync(SandboxActor actor, string id,
        CoreEnvironmentConsumerRelease input, bool reconcile, CancellationToken ct)
    {
        input = input with { RequestId = RequestId(input.RequestId), ConsumerId = RequestId(input.ConsumerId) };
        var principal = ConsumerPrincipal(actor);
        var kind = reconcile ? "reconcile" : "release";
        var fingerprint = SandboxValidation.Hash(CoreJson.Text(input));
        var gate = Gate(id); await gate.WaitAsync(ct);
        try
        {
            var record = await RequireAsync(actor, id, ct);
            if (ConsumerReplay(record, input.RequestId, kind, principal, fingerprint) is { } replay) return replay;
            var consumer = record.Consumers?.SingleOrDefault(c => c.ConsumerId == input.ConsumerId)
                ?? throw new SandboxException("environment_consumer_not_found", "The consumer is not registered.", 404);
            if (consumer.PrincipalId != principal && !reconcile)
                throw new SandboxException("environment_consumer_forbidden", "Only the registering principal can release this claim. The owning administrator can explicitly reconcile confirmed termination.", 403);
            if (consumer.Revision != input.ExpectedRevision)
                throw new SandboxException("environment_consumer_revision_conflict", "Read the current consumer revision before releasing it.");
            if (consumer.State == "released")
                throw new SandboxException("environment_consumer_released", "This consumer was already released. Replay its original request.");
            var evidence = input.StopEvidence;
            if (evidence is null || evidence.ObservedAt < consumer.ObservedAt || evidence.ObservedAt > clock.UtcNow.AddMinutes(1)
                || evidence.Kind != (reconcile ? "operator-confirmed-stop" : consumer.Run is null ? "native-stopped" : "provider-confirmed-stop"))
                throw new SandboxException("environment_consumer_evidence_invalid", "Provide the required explicit stop attestation observed after this claim was registered.", 400);
            SandboxValidation.Text(evidence.Reason, 1000, "stop evidence reason");
            if (consumer.Run is not null)
            {
                var run = await ConsumerRunAsync(actor, consumer.Run, ct);
                if (run.Freshness != "current" || !run.StopConfirmed)
                    throw new SandboxException("environment_consumer_stop_unconfirmed", "The owning executor has not currently confirmed termination. Cancellation acceptance, terminal text or an unavailable provider cannot release this claim.");
            }
            consumer = consumer with { Revision = consumer.Revision + 1, State = "released", ObservedAt = clock.UtcNow, StopEvidence = evidence };
            return await SaveConsumerAsync(record, consumer, input.RequestId, kind, principal, fingerprint, ct);
        }
        finally { gate.Release(); }
    }

    private async Task<HostyAgentRun> ConsumerRunAsync(SandboxActor actor, HostyRunRef run, CancellationToken ct)
    {
        if (agentRuns is null || actor.Capability is null)
            throw new SandboxException("environment_consumer_run_unavailable", "Current agent-session provider access is required to confirm this run.");
        actor.Capability.Require(AccessTokenScopes.McpAgentSessionsRead, CoreAppPermissions.AgentSessionsRead);
        return await agentRuns.ReadRunAsync(actor.Capability, run, ct);
    }
    private static void ConsumerCapacity(CoreEnvironmentRecord record)
    {
        if ((record.ConsumerOperations?.Count ?? 0) >= 2048)
            throw new SandboxException("environment_consumer_capacity", "This environment's consumer journal is full. Preserve its evidence and finish after reconciling consumers.");
    }
    private static CoreEnvironmentConsumerResult? ConsumerReplay(CoreEnvironmentRecord record, string requestId,
        string kind, string principal, string fingerprint)
    {
        var prior = record.ConsumerOperations?.SingleOrDefault(o => o.RequestId == requestId);
        if (prior is null) return null;
        if (prior.Kind != kind || prior.PrincipalId != principal || prior.Fingerprint != fingerprint) throw ReplayConflict();
        return prior.Result;
    }
    private async Task<CoreEnvironmentConsumerResult> SaveConsumerAsync(CoreEnvironmentRecord record, CoreEnvironmentConsumer consumer,
        string requestId, string kind, string principal, string fingerprint, CancellationToken ct)
    {
        var result = new CoreEnvironmentConsumerResult(requestId, record.Revision + 1, consumer);
        record = record with { Revision = result.EnvironmentRevision,
            Consumers = [.. (record.Consumers ?? []).Where(c => c.ConsumerId != consumer.ConsumerId), consumer],
            ConsumerOperations = [.. record.ConsumerOperations ?? [], new(requestId, kind, principal, fingerprint, clock.UtcNow, result)] };
        await store.WriteAsync(record, ct);
        return result;
    }
    private static void RequireStoppedConsumers(CoreEnvironmentRecord record)
    {
        var active = (record.Consumers ?? []).Where(c => c.State != "released").Select(c => c.ConsumerId).ToArray();
        if (active.Length > 0)
            throw new SandboxException("resource_in_use", "Confirm termination and release or reconcile the registered consumers before stopping this environment: " + string.Join(", ", active));
    }
}
