using HostySdk.App;
namespace Haas.Hosty.Core;

// One atomic file replacement commits the answer, fixed-recipient outbox, and replay receipt.
// Acknowledgement never means native acceptance. The source persists its inbox before acknowledging.
internal sealed class CoreDecisionStore(CoreDataPaths paths)
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private string Path => System.IO.Path.Combine(paths.CoreRoot, "decisions", "state.json");

    internal async Task<T> UpdateAsync<T>(Func<CoreDecisionState, (CoreDecisionState State, T Result)> change, CancellationToken ct = default)
    {
        await gate.WaitAsync(ct);
        try
        {
            var state = await JsonStorage.ReadAsync<CoreDecisionState>(Path, ct) ?? CoreDecisionState.Empty;
            if (state.SchemaVersion != 1) throw new InvalidDataException("Unsupported decision store version.");
            var (next, result) = change(state);
            if (!ReferenceEquals(state, next)) await JsonStorage.WriteAsync(Path, next, restrictToOwner: true, ct);
            return result;
        }
        finally { gate.Release(); }
    }

    internal Task<int> MaintainAsync(DateTimeOffset now, CancellationToken ct = default) => UpdateAsync(state =>
    {
        var changed = 0;
        var records = state.Records.Select(record =>
        {
            if (record.State == "pending" && record.Input?.ExpiresAt <= now)
            {
                changed++;
                return record with { State = "expired", Revision = record.Revision + 1, UpdatedAt = now,
                    Reason = "deadline_elapsed" };
            }
            // Unresolved delivery/continuation and pending waits are never idle retention candidates.
            if (record.ContentRemovedAt is null && record.State != "pending" && record.UpdatedAt < now.AddDays(-30)
                && (record.Resolution is null || record.Delivery?.ReceivedAt is not null)
                && (record.Continuation is null || record.Continuation.State is "completed" or "failed" or "cancelled"))
            {
                changed++;
                return record with { Input = null, Resolution = record.Resolution is null ? null : record.Resolution with { Answers = new Dictionary<string, HostyDecisionAnswer>() },
                    Continuation = record.Continuation is null ? null : record.Continuation with { Outcome = null }, Reason = null, ContentRemovedAt = now };
            }
            return record;
        }).ToArray();
        if (changed == 0) return (state, 0);
        var removed = records.Where(r => r.ContentRemovedAt is not null).Select(r => r.Id).ToHashSet(StringComparer.Ordinal);
        return (state with { Records = records, Replays = state.Replays.Select(r => removed.Contains(r.DecisionId) ? r with { Result = null } : r).ToArray() }, changed);
    }, ct);
}

internal sealed class CoreDecisionRetention(CoreDecisionStore store, IClock clock, ILogger<CoreDecisionRetention> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromHours(1));
        do
        {
            try { await store.MaintainAsync(clock.UtcNow, stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { return; }
            catch (Exception ex) { logger.LogError(ex, "Decision retention failed; retained content is preserved."); }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
