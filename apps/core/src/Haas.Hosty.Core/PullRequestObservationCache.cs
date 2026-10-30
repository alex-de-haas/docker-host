using System.Collections.Concurrent;

namespace Haas.Hosty.Core;

// This short display cache joins simultaneous workspace and inbox reads. Callers must validate
// their own source authority before and after using it; it never returns completion evidence.
internal sealed class PullRequestObservationCache(IClock clock)
{
    private readonly object sync = new();
    private readonly Dictionary<string, PullRequestSummary> facts = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim[] gates = Enumerable.Range(0, 64).Select(_ => new SemaphoreSlim(1)).ToArray();
    public void Invalidate(UserProviderConnection connection, string repository, int number)
    {
        var key = connection.UserId + ":" + connection.Id + ":" + connection.AccountId + ":" + repository.ToLowerInvariant() + ":" + number;
        lock (sync) facts.Remove(key);
    }
    public async Task<PullRequestSummary[]> ReadAsync(UserProviderConnection connection, string repository, string id,
        int[] numbers, Func<int[], Task<PullRequestSummary[]>> read, CancellationToken ct)
    {
        var key = connection.UserId + ":" + connection.Id + ":" + connection.AccountId + ":" + repository.ToLowerInvariant();
        var gate = gates[(uint)StringComparer.Ordinal.GetHashCode(key) % gates.Length];
        await gate.WaitAsync(ct);
        try
        {
            int[] missing;
            lock (sync)
            {
                foreach (var old in facts.Where(p => clock.UtcNow - p.Value.Receipt.ObservedAt > TimeSpan.FromMinutes(10)).Select(p => p.Key).ToArray()) facts.Remove(old);
                missing = numbers.Where(n => !facts.TryGetValue(key + ":" + n, out var v) || clock.UtcNow - v.Receipt.ObservedAt >= TimeSpan.FromSeconds(10)).ToArray();
            }
            if (missing.Length > 0)
            {
                var result = await read(missing);
                lock (sync)
                {
                    foreach (var item in result) facts[key + ":" + item.Number] = item;
                    while (facts.Count > 10000) facts.Remove(facts.MinBy(p => p.Value.Receipt.ObservedAt).Key);
                }
            }
            lock (sync) return numbers.Select(n => facts.GetValueOrDefault(key + ":" + n)).OfType<PullRequestSummary>()
                .Where(p => clock.UtcNow - p.Receipt.ObservedAt < TimeSpan.FromSeconds(10)).Select(p => p with { RepositoryId = id }).ToArray();
        }
        finally { gate.Release(); }
    }
}
