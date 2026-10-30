using System.Net;
using System.Text.Json.Nodes;

namespace Haas.Hosty.Core.Tests;

public sealed class PullRequestPolicyTests
{
    private sealed class Clock : IClock { public DateTimeOffset UtcNow { get; set; } = DateTimeOffset.Parse("2026-10-29T12:00:00Z"); }
    private static UserProviderConnection Connection(Clock clock, string id = "c", string account = "42")
        => new(id, "owner", "GitHub", "github", "", "", account, "owner", "pat", "secret", null, null, null, clock.UtcNow, null, "connected", "r");
    [Theory]
    [InlineData("COMPLETED", "SUCCESS", "passed")]
    [InlineData("COMPLETED", "SKIPPED", "skipped")]
    [InlineData("COMPLETED", "NEUTRAL", "neutral")]
    [InlineData("COMPLETED", "CANCELLED", "cancelled")]
    [InlineData("IN_PROGRESS", "", "running")]
    [InlineData("PENDING", "PENDING", "pending")]
    [InlineData("MISSING", "", "unknown")]
    public void CheckResultsDoNotTreatSkippedOrUnknownAsPassing(string status, string conclusion, string expected)
        => Assert.Equal(expected, PullRequestPolicy.CheckState(status, conclusion));
    [Fact]
    public void NoDemandAlwaysSelectsFiveMinutesEvenForActiveCi()
    {
        Assert.Equal(TimeSpan.FromMinutes(5), PullRequestPolicy.Interval(false, false, true));
        Assert.Equal(TimeSpan.FromMinutes(5), PullRequestPolicy.Interval(false, true, false));
        Assert.Equal(TimeSpan.FromSeconds(10), PullRequestPolicy.Interval(true, false, true));
        Assert.Equal(TimeSpan.FromMinutes(1), PullRequestPolicy.Interval(true, true, true));
        Assert.Equal(TimeSpan.FromMinutes(1), PullRequestPolicy.Interval(true, false, false));
    }
    [Fact]
    public async Task AccountPacingIsSharedAcrossConnectionsAndTokenRotation()
    {
        var clock = new Clock(); var budget = new PullRequestProviderBudget(clock);
        using (var lease = await budget.AcquireAsync(Connection(clock), false, true, default))
            lease.Complete(new(HttpStatusCode.NotModified));
        var error = await Assert.ThrowsAsync<PullRequestException>(() => budget.AcquireAsync(Connection(clock, "rotated") with { AccessToken = "new" }, false, true, default));
        Assert.Equal(clock.UtcNow.AddSeconds(2), error.RetryAt);
        using (var other = await budget.AcquireAsync(Connection(clock, account: "other"), false, true, default)) other.Complete(new(HttpStatusCode.OK));
        clock.UtcNow += TimeSpan.FromSeconds(2);
        using var next = await budget.AcquireAsync(Connection(clock), false, true, default); next.Complete(new(HttpStatusCode.OK));
    }
    [Fact]
    public async Task ProviderRetryAfterWinsAndRestReserveDoesNotConsumeGraphqlBudget()
    {
        var clock = new Clock(); var budget = new PullRequestProviderBudget(clock); var connection = Connection(clock);
        using (var lease = await budget.AcquireAsync(connection, false, true, default))
        {
            using var response = new HttpResponseMessage(HttpStatusCode.OK);
            response.Headers.Add("X-RateLimit-Limit", "5000"); response.Headers.Add("X-RateLimit-Remaining", "999");
            response.Headers.Add("X-RateLimit-Reset", clock.UtcNow.AddHours(1).ToUnixTimeSeconds().ToString()); lease.Complete(response);
        }
        clock.UtcNow += TimeSpan.FromSeconds(2);
        await Assert.ThrowsAsync<PullRequestException>(() => budget.AcquireAsync(connection, false, true, default));
        using (var lease = await budget.AcquireAsync(connection, true, true, default))
        {
            using var response = new HttpResponseMessage(HttpStatusCode.TooManyRequests);
            response.Headers.RetryAfter = new(TimeSpan.FromMinutes(7));
            var error = Assert.Throws<PullRequestException>(() => lease.Complete(response)); Assert.Equal(clock.UtcNow.AddMinutes(7), error.RetryAt);
        }
        await Assert.ThrowsAsync<PullRequestException>(() => budget.AcquireAsync(connection, true, true, default));
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task GraphqlRateErrorsWithHttpSuccessBackOffTheSharedAccount(bool primary)
    {
        var clock = new Clock(); var budget = new PullRequestProviderBudget(clock); var connection = Connection(clock);
        var expected = clock.UtcNow.AddMinutes(primary ? 30 : 1);
        using (var lease = await budget.AcquireAsync(connection, true, true, default))
        {
            using var response = new HttpResponseMessage(HttpStatusCode.OK);
            if (primary)
            {
                response.Headers.Add("X-RateLimit-Remaining", "0");
                response.Headers.Add("X-RateLimit-Reset", expected.ToUnixTimeSeconds().ToString());
            }
            var payload = JsonNode.Parse("""{"errors":[{"message":"You have exceeded a secondary rate limit."}]}""");
            var error = Assert.Throws<PullRequestException>(() => lease.Complete(response, payload));
            Assert.Equal(expected, error.RetryAt);
        }
        clock.UtcNow += TimeSpan.FromSeconds(3);
        var rest = await Assert.ThrowsAsync<PullRequestException>(() => budget.AcquireAsync(connection, false, true, default));
        Assert.Equal(expected, rest.RetryAt);
    }
    [Fact]
    public async Task ConditionalHitsConsumePacingButNotTheChargedReadCap()
    {
        var clock = new Clock(); var budget = new PullRequestProviderBudget(clock);
        for (var i = 0; i < 2001; i++)
        {
            using var lease = await budget.AcquireAsync(Connection(clock), false, true, default); lease.Complete(new(HttpStatusCode.NotModified));
            clock.UtcNow += TimeSpan.FromSeconds(2);
        }
        using var final = await budget.AcquireAsync(Connection(clock), false, true, default); final.Complete(new(HttpStatusCode.OK));
    }
}
