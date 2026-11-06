using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Haas.Hosty.TelemetryBackend.Query;
using HostySdk.App;
using Microsoft.AspNetCore.Http;
using Xunit;

namespace Haas.Hosty.TelemetryBackend.Tests;

public sealed class TelemetryMcpAuthTests
{
    [Theory]
    [InlineData("hosty_mcp.1.fixture", null)]
    [InlineData("hosty_mcp.1.fixture", "list_traces")]
    [InlineData("hosty_scoped_fixture", "search_logs")]
    public async Task UsesMcpIntrospectionForEveryRequestAndHonorsRevocation(string token, string? tool)
    {
        using var transport = new IntrospectionHandler();
        var auth = Auth(transport);
        Assert.Null(await auth.AuthorizeAsync("Bearer " + token, tool));
        Assert.Equal("mcp", transport.Body.GetProperty("purpose").GetString());
        Assert.Equal(token, transport.Body.GetProperty("token").GetString());
        Assert.Equal(tool, transport.Body.GetProperty("tool").GetString());
        Assert.Equal("/api/internal/apps/test.telemetry/token/introspect", transport.Path);
        Assert.Equal("Bearer fixture-service", transport.Authorization);
        transport.Active = false;
        Assert.Equal(401, Status(await auth.AuthorizeAsync("Bearer " + token, tool)));
        Assert.Equal(2, transport.Calls);
    }

    [Theory]
    [InlineData("host.admin", "mcp:invoke")]
    [InlineData("host.user", "mcp:read")]
    [InlineData(null, "mcp:read")]
    public async Task RequiresReadScopeAndAdministrator(string? role, string scope)
    {
        using var transport = new IntrospectionHandler { Role = role, Scope = scope };
        Assert.Equal(403, Status(await Auth(transport).AuthorizeAsync("Bearer fixture", null)));
    }

    [Theory]
    [InlineData("http")]
    [InlineData("network")]
    [InlineData("json")]
    public async Task DistinguishesUnavailableCoreFromInvalidCredential(string failure)
    {
        using var transport = new IntrospectionHandler { Failure = failure };
        Assert.Equal(503, Status(await Auth(transport).AuthorizeAsync("Bearer fixture", null)));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("Basic fixture")]
    [InlineData("Bearer ")]
    public async Task RefusesMissingBearerWithoutCallingCore(string? header)
    {
        using var transport = new IntrospectionHandler();
        Assert.Equal(401, Status(await Auth(transport).AuthorizeAsync(header, null)));
        Assert.Equal(0, transport.Calls);
    }

    private static int? Status(IResult? result) => Assert.IsAssignableFrom<IStatusCodeHttpResult>(result).StatusCode;
    private static TelemetryMcpAuth Auth(IntrospectionHandler transport) => new(new(null, "test.telemetry"),
        new(new Factory(transport), new() { AppId = "test.telemetry", CoreOrigin = "http://core.test", ServiceToken = "fixture-service" }));

    private sealed class Factory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false) { BaseAddress = new Uri("http://core.test") };
    }

    private sealed class IntrospectionHandler : HttpMessageHandler
    {
        public bool Active = true;
        public string? Role = "host.admin";
        public string Scope = "mcp:read";
        public string? Failure;
        public int Calls;
        public JsonElement Body;
        public string? Path;
        public string? Authorization;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            Body = await request.Content!.ReadFromJsonAsync<JsonElement>(cancellationToken);
            Path = request.RequestUri!.AbsolutePath;
            Authorization = request.Headers.Authorization?.ToString();
            if (Failure == "network") throw new HttpRequestException("Fixture unreachable");
            if (Failure == "http") return new(HttpStatusCode.ServiceUnavailable);
            if (Failure == "json") return new(HttpStatusCode.OK) { Content = new StringContent("invalid") };
            return new(HttpStatusCode.OK) { Content = JsonContent.Create(new { active = Active, sub = "fixture-admin", role = Role, scopes = new[] { Scope } }) };
        }
    }
}
