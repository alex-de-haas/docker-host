using System.Net;
using System.Net.Http.Headers;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

// The docker-stats exposition used to be an unauthenticated /internal route, on the theory that scrape
// traffic stays on a trusted network. Managed ingress publishes Core's whole origin (hostname->service
// rules, no path support), so that theory never held and the endpoint leaked the installed-app
// inventory. These tests pin the credential and the app-token contract.
public sealed class TelemetryMetricsAuthorizationHttpTests
{
    private const string MetricsPath = "/api/internal/telemetry/metrics";

    [Fact]
    public async Task Metrics_RejectsAnAnonymousCaller()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        using var client = harness.CreateClient();

        var response = await client.GetAsync(MetricsPath);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Metrics_RejectsAnInvalidBearer()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        using var client = harness.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, MetricsPath);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", "hosty_app_service.1.forged.forged");

        var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Metrics_AcceptsAValidAppServiceToken()
    {
        // Any installed app's token is accepted: the exposition is host-wide, so there is nothing to
        // scope per app, and the token only has to prove the caller is an app rather than the internet.
        await using var harness = await CoreHttpHarness.StartAsync();
        var token = harness.Services.GetRequiredService<AppServiceTokenService>().CreateToken("com.haas.telemetry");
        using var client = harness.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, MetricsPath);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

        var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/plain", response.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task OldUnauthenticatedPath_IsGone()
    {
        // The whole point of the change: the path that needed no credential must not linger.
        await using var harness = await CoreHttpHarness.StartAsync();
        using var client = harness.CreateClient();

        var response = await client.GetAsync("/internal/telemetry/metrics");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }
}
