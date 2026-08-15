namespace Haas.Hosty.Cli.Tests.Mcp;

using System.Net;
using Haas.Hosty.Cli.Commands;
using Haas.Hosty.Cli.Mcp;

// Caching was a decision, not an optimisation (docs/features/hosty-mcp-connector/plan.md): the plan
// said "a fresh token per call" in three places while the design it borrowed from caches. These pin
// the behaviour that was chosen, including the margin, which is the part that is easy to get subtly
// wrong and impossible to notice until a call fails mid-flight.
public class DelegatedTokenCacheTests
{
    private static readonly DateTimeOffset Now = new(2026, 8, 15, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task ATokenWithPlentyOfLifeIsReusedRatherThanReminted()
    {
        // Core is a round trip; spending one per tool call would put it back in the data path this
        // design keeps it out of.
        var (cache, issued, _) = Build(TimeSpan.FromMinutes(5));

        Assert.Equal("token-1", await cache.TryGetAsync("com.example.notes", default));
        Assert.Equal("token-1", await cache.TryGetAsync("com.example.notes", default));

        Assert.Single(issued);
    }

    [Fact]
    public async Task ATokenInsideTheMarginIsReplacedBeforeItDies()
    {
        // The margin exists so a call does not depart on a credential that expires while the app is
        // still working. A cache that only checked expiry would hand out the old one here.
        var (cache, issued, time) = Build(TimeSpan.FromMinutes(5));
        Assert.Equal("token-1", await cache.TryGetAsync("com.example.notes", default));

        // 4m10s in: 50 seconds left, inside the 60-second margin.
        time.Advance(TimeSpan.FromSeconds(250));

        Assert.Equal("token-2", await cache.TryGetAsync("com.example.notes", default));
        Assert.Equal(2, issued.Count);
    }

    [Fact]
    public async Task EachAppGetsItsOwnToken()
    {
        // The audience claim is the point: one app's token must never be presented to another.
        var (cache, issued, _) = Build(TimeSpan.FromMinutes(5));

        await cache.TryGetAsync("com.example.notes", default);
        await cache.TryGetAsync("com.example.other", default);

        Assert.Equal(["com.example.notes", "com.example.other"], issued);
    }

    [Fact]
    public async Task ARefusalYieldsNullAndDropsWhateverWasCached()
    {
        // Once Core says no — the actor lost access, the app was removed — presenting the previous
        // token would turn a clear refusal into an authorization error from the app.
        var refuse = false;
        var time = new TestClock(Now);
        var cache = new DelegatedTokenCache(
            (_, _) => Task.FromResult<IssuedToken?>(
                refuse ? null : new IssuedToken("token", Now.AddMinutes(5))),
            time);

        Assert.NotNull(await cache.TryGetAsync("com.example.notes", default));

        refuse = true;
        time.Advance(TimeSpan.FromMinutes(5));
        Assert.Null(await cache.TryGetAsync("com.example.notes", default));

        // And it stays refused rather than falling back to the stale entry.
        Assert.Null(await cache.TryGetAsync("com.example.notes", default));
    }

    [Fact]
    public async Task AnUnreachableCoreIsAnAbsentTokenRatherThanAThrow()
    {
        // One app failing must never take down the connector; the caller reports this as the app
        // being unavailable.
        var cache = new DelegatedTokenCache(
            (_, _) => Task.FromException<IssuedToken?>(
                new CoreControlTimeoutException("POST", "apps/x/delegated-token", TimeSpan.FromSeconds(1))),
            new TestClock(Now));

        Assert.Null(await cache.TryGetAsync("com.example.notes", default));
    }

    [Fact]
    public async Task AMissingRouteIsReportedAsAnOldCoreRatherThanAnAccessProblem()
    {
        // Found by driving the connector against a live host on 2026-08-15: the running Core predated
        // the token route, and the only message was "would not issue a token for this user" — which
        // reads as an access problem and sends the reader to the user directory. An empty 404 is the
        // route missing; a 404 with a body is Core answering about the user or the app.
        var warnings = new List<string>();
        var cache = new DelegatedTokenCache(
            (_, _) => Task.FromException<IssuedToken?>(
                new CoreControlException("POST", "apps/x/delegated-token", HttpStatusCode.NotFound, "")),
            new TestClock(Now),
            warnings.Add);

        Assert.Null(await cache.TryGetAsync("com.example.notes", default));
        Assert.Contains(warnings, warning => warning.Contains("predates 0.81.0", StringComparison.Ordinal));

        // Paired: a 404 that carries Core's own answer must not be reported as a stale Core.
        var answered = new List<string>();
        var withBody = new DelegatedTokenCache(
            (_, _) => Task.FromException<IssuedToken?>(
                new CoreControlException("POST", "apps/x/delegated-token", HttpStatusCode.NotFound, "{\"code\":\"user_not_found\"}")),
            new TestClock(Now),
            answered.Add);

        Assert.Null(await withBody.TryGetAsync("com.example.notes", default));
        Assert.DoesNotContain(answered, warning => warning.Contains("predates", StringComparison.Ordinal));
    }

    private static (DelegatedTokenCache Cache, List<string> Issued, TestClock Time) Build(TimeSpan lifetime)
    {
        var issued = new List<string>();
        var time = new TestClock(Now);
        var cache = new DelegatedTokenCache(
            (appId, _) =>
            {
                issued.Add(appId);
                return Task.FromResult<IssuedToken?>(
                    new IssuedToken($"token-{issued.Count}", time.GetUtcNow().Add(lifetime)));
            },
            time);
        return (cache, issued, time);
    }

    /// <summary>
    /// A hand-rolled clock rather than Microsoft.Extensions.TimeProvider.Testing: the margin is the
    /// only thing under test that needs time to move, and this is cheaper than a package.
    /// </summary>
    private sealed class TestClock(DateTimeOffset start) : TimeProvider
    {
        private DateTimeOffset now = start;

        public override DateTimeOffset GetUtcNow() => now;

        public void Advance(TimeSpan by) => now = now.Add(by);
    }
}
