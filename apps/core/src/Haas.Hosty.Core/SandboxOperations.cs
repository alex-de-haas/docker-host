using System.Collections.Concurrent;

namespace Haas.Hosty.Core;

// HTTP disconnects end observation, not an accepted lifecycle transition. The persisted instance
// journal is the recovery contract; this map only coalesces concurrent same-process retries.
internal sealed class SandboxOperations(SandboxService service, IHostApplicationLifetime lifetime)
{
    private sealed record Pending(string Fingerprint, Lazy<Task<SandboxView>> Work);
    private readonly ConcurrentDictionary<string, Pending> active = new(StringComparer.Ordinal);

    public async Task<SandboxView> CommandAsync(SandboxActor actor, string id, string kind, SandboxCommand input, CancellationToken observation)
    {
        SandboxValidation.Id(id); SandboxValidation.Request(input.RequestId);
        // Authorize existence/ownership before keeping any in-memory operation reference.
        await service.ReadAsync(actor, id, observation);
        var key = actor.Key + ":" + id + ":" + input.RequestId;
        var fingerprint = SandboxValidation.Hash(kind + "\n" + CoreJson.Text(input));
        if (active.Count >= 32 && !active.ContainsKey(key))
            throw new SandboxException("sandbox_operation_capacity", "Observe existing operations before starting more; no queue is available.");
        var candidate = new Pending(fingerprint, new(() => service.CommandAsync(actor, id, kind, input, lifetime.ApplicationStopping)));
        var pending = active.GetOrAdd(key, candidate);
        if (pending.Fingerprint != fingerprint) throw new SandboxException("sandbox_replay_conflict", "Preserve the original operation arguments.");
        var task = pending.Work.Value;
        if (ReferenceEquals(candidate, pending)) _ = ObserveCompletion(key, pending, task);
        while (true)
        {
            if (await Task.WhenAny(task, Task.Delay(200, observation)) == task) return await task;
            observation.ThrowIfCancellationRequested();
            var snapshot = await service.ReadAsync(actor, id, observation);
            // Never acknowledge a request before its identity has reached the durable journal.
            if (snapshot.Operations.Any(o => o.Id == input.RequestId)) return snapshot;
        }
    }

    private async Task ObserveCompletion(string key, Pending pending, Task<SandboxView> task)
    {
        try { await task; }
        catch (Exception) { /* The service persisted a failed/unknown outcome; callers observe it. */ }
        finally { active.TryRemove(new KeyValuePair<string, Pending>(key, pending)); }
    }
}
