using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json.Nodes;

namespace Haas.Hosty.Core;

// Shared by all GitHub publication/inbox reads. Account identity, not a token, owns the budget.
internal sealed class PullRequestProviderBudget(IClock clock)
{
    private DateTimeOffset Now => clock.UtcNow;
    private static readonly AsyncLocal<bool> background = new();
    internal static IDisposable AutomaticScope() { var previous = background.Value; background.Value = true; return new Scope(previous); }
    private sealed class Scope(bool previous) : IDisposable { public void Dispose() => background.Value = previous; }
    private readonly ConcurrentDictionary<string, Account> accounts = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim global = new(4);
    internal sealed class Window
    {
        public DateTimeOffset Started;
        public int Used;
        public int? Remaining;
        public int? Limit;
        public DateTimeOffset Reset;
    }
    internal sealed class Account
    {
        public readonly SemaphoreSlim Gate = new(1);
        public readonly Window Rest = new(), Graph = new();
        public DateTimeOffset NextStart, RetryAt;
        public int Failures;
    }
    internal static string AccountKey(UserProviderConnection c) => c.Provider + ":" + c.AccountId;

    public async Task<Lease> AcquireAsync(UserProviderConnection connection, bool graph, bool automatic, CancellationToken ct, bool waitForPacing = false)
    {
        automatic |= background.Value;
        var account = accounts.GetOrAdd(AccountKey(connection), _ => new());
        await account.Gate.WaitAsync(ct);
        var globalHeld = false;
        try
        {
            var now = clock.UtcNow;
            var window = graph ? account.Graph : account.Rest;
            if (now - window.Started >= TimeSpan.FromHours(1)) { window.Started = now; window.Used = 0; }
            if (window.Reset <= now) { window.Remaining = null; window.Limit = null; }
            var due = account.RetryAt;
            if (automatic && window.Used >= 2000) due = Max(due, window.Started.AddHours(1));
            if (window.Remaining is { } remaining && (remaining <= 0 || automatic && remaining <= (window.Limit ?? 0) / 5))
                due = Max(due, window.Reset);
            if (due > now) throw Delayed(due, "GitHub observation is waiting for the provider budget.");
            if (account.NextStart > now)
            {
                if (automatic && !waitForPacing) throw Delayed(account.NextStart, "GitHub requests share an account pacing limit.");
                await Task.Delay(account.NextStart - now, ct);
            }
            await global.WaitAsync(ct); globalHeld = true;
            account.NextStart = clock.UtcNow.AddSeconds(2);
            return new Lease(this, account, window, graph);
        }
        catch { if (globalHeld) global.Release(); account.Gate.Release(); throw; }
    }
    private static DateTimeOffset Max(DateTimeOffset a, DateTimeOffset b) => a > b ? a : b;
    private static PullRequestException Delayed(DateTimeOffset at, string message) => new("pr_rate_limited", message, 429, at);

    internal sealed class Lease : IDisposable
    {
        private readonly PullRequestProviderBudget owner;
        private readonly Account account;
        private readonly Window window;
        private readonly bool graph;
        private bool completed, disposed;
        internal Lease(PullRequestProviderBudget owner, Account account, Window window, bool graph)
        { this.owner = owner; this.account = account; this.window = window; this.graph = graph; }
        public void Complete(HttpResponseMessage response, JsonNode? payload = null)
        {
            completed = true;
            var now = owner.Now;
            string? Header(string name) => response.Headers.TryGetValues(name, out var values) ? values.FirstOrDefault() : null;
            int? Number(string name) => int.TryParse(Header(name), out var value) ? value : null;
            if (Number("X-RateLimit-Remaining") is { } remaining) window.Remaining = remaining;
            if (Number("X-RateLimit-Limit") is { } limit) window.Limit = limit;
            if (long.TryParse(Header("X-RateLimit-Reset"), out var reset)) window.Reset = DateTimeOffset.FromUnixTimeSeconds(reset);
            var rate = graph && payload is JsonObject ? payload["data"]?["rateLimit"] : null;
            if (graph && rate is not null)
            {
                window.Remaining = rate["remaining"]?.GetValue<int>();
                window.Limit = rate["limit"]?.GetValue<int>();
                if (DateTimeOffset.TryParse(rate["resetAt"]?.ToString(), out var end)) window.Reset = end;
            }
            if (response.StatusCode != System.Net.HttpStatusCode.NotModified)
                window.Used += graph ? Math.Max(1, rate?["cost"]?.GetValue<int>() ?? 1) : 1;
            if (double.TryParse(Header("X-Poll-Interval"), CultureInfo.InvariantCulture, out var interval))
                account.NextStart = Max(account.NextStart, now.AddSeconds(Math.Clamp(interval, 0, 86400)));
            var graphLimited = graph && payload?["errors"] is JsonArray errors && errors.OfType<JsonObject>().Any(error =>
                window.Remaining == 0 || error["type"]?.ToString() == "RATE_LIMITED" ||
                error["message"]?.ToString().Contains("rate limit", StringComparison.OrdinalIgnoreCase) == true);
            if (graphLimited || (int)response.StatusCode == 429 || response.StatusCode == System.Net.HttpStatusCode.Forbidden &&
                (response.Headers.RetryAfter is not null || window.Remaining == 0 ||
                    payload?["message"]?.ToString().Contains("rate limit", StringComparison.OrdinalIgnoreCase) == true))
            {
                var retry = response.Headers.RetryAfter?.Date ?? (response.Headers.RetryAfter?.Delta is { } delta ? now + delta :
                    window.Remaining == 0 && window.Reset > now ? window.Reset : now.AddSeconds(Math.Min(900, 60 * Math.Pow(2, account.Failures++))));
                account.RetryAt = Max(now.AddSeconds(1), retry);
                throw Delayed(account.RetryAt, "GitHub asked observation to retry later.");
            }
            if (response.IsSuccessStatusCode || response.StatusCode == System.Net.HttpStatusCode.NotModified)
            { account.Failures = 0; return; }
            if ((int)response.StatusCode >= 500) Failed();
        }
        private void Failed()
        {
            account.RetryAt = owner.Now.AddSeconds(Math.Min(300, 15 * Math.Pow(2, account.Failures++)));
        }
        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            if (!completed) Failed();
            owner.global.Release(); account.Gate.Release();
        }
    }
}
