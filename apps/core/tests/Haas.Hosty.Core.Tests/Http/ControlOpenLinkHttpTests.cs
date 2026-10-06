using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Haas.Hosty.Core;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class ControlOpenLinkHttpTests
{
    private const string AppId = "com.test.notes";
    private const string AppOrigin = "https://notes.example.test";

    [Fact]
    public async Task StandaloneReturnsTheDeclaredUiWithoutAnyUserOrIssuedCredential()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAppAsync(host, AppId);
        using var client = host.CreateClient();

        using var response = await PostAsync(host, client, AppId, "{}");
        var json = await ReadAsync(response);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(AppOrigin + "/notes", json.GetProperty("url").GetString());
        Assert.Equal("standalone", json.GetProperty("mode").GetString());
        Assert.Equal(AppId, json.GetProperty("appId").GetString());
        Assert.False(json.TryGetProperty("userId", out _));
        Assert.False(json.TryGetProperty("expiresAt", out _));
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        Assert.Empty((await host.Services.GetRequiredService<AppSessionGrantStore>().ReadAsync()).Grants);
        Assert.Empty((await host.Services.GetRequiredService<UserDirectoryStore>().ReadAsync()).Users);
    }

    [Fact]
    public async Task AnExplicitAppPageIsValidatedAndKeptWithoutAUser()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAppAsync(host, AppId);
        using var client = host.CreateClient();

        using var response = await PostAsync(host, client, AppId,
            """{"redirectUri":"https://notes.example.test/people?filter=active"}""");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(AppOrigin + "/people?filter=active", (await ReadAsync(response)).GetProperty("url").GetString());
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
    }

    [Theory]
    [InlineData("""{"user":"someone@example.test"}""")]
    [InlineData("""{"user":null}""")]
    [InlineData("""{"user":"","mode":"shell"}""")]
    public async Task AnySuppliedLegacyUserIsRejectedWithMigrationGuidance(string body)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = host.CreateClient();

        using var response = await PostAsync(host, client, AppId, body);
        var json = await ReadAsync(response);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("open_user_removed", json.GetProperty("code").GetString());
        Assert.Contains("browser", json.GetProperty("message").GetString());
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
    }

    [Theory]
    [InlineData("https://foreign.example.test/notes", "redirect_uri_denied")]
    [InlineData("https://notes.example.test:8443/notes", "redirect_uri_denied")]
    [InlineData("http://notes.example.test/notes", "redirect_uri_denied")]
    [InlineData("https://user:secret@notes.example.test/notes", "redirect_uri_invalid")]
    [InlineData("https://notes.example.test/notes#code=abc", "redirect_uri_invalid")]
    [InlineData("https://notes.example.test/notes?code=abc", "redirect_uri_invalid")]
    [InlineData("https://notes.example.test/notes?%63ode=abc", "redirect_uri_invalid")]
    [InlineData("https://notes.example.test/notes?codeVerifier=secret", "redirect_uri_invalid")]
    [InlineData("https://notes.example.test/notes?codeChallenge=proof", "redirect_uri_invalid")]
    [InlineData("https://notes.example.test/notes?state=attempt", "redirect_uri_invalid")]
    [InlineData("https://notes.example.test/notes?hosty_launch=native", "redirect_uri_invalid")]
    [InlineData("javascript:alert(1)", "redirect_uri_invalid")]
    [InlineData("/notes", "redirect_uri_invalid")]
    public async Task ForeignOrCredentialBearingDestinationsAreRefused(string redirect, string code)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAppAsync(host, AppId);
        using var client = host.CreateClient();
        using var response = await PostAsync(host, client, AppId, JsonSerializer.Serialize(new { redirectUri = redirect }));

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal(code, (await ReadAsync(response)).GetProperty("code").GetString());
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
    }

    [Theory]
    [InlineData("standalone")]
    [InlineData("shell")]
    public async Task BothModesRequireAnInstalledTargetApp(string mode)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = host.CreateClient();
        using var response = await PostAsync(host, client, AppId, JsonSerializer.Serialize(new { mode }));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("app_not_found", (await ReadAsync(response)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task AHeadlessAppHasNoDefaultBrowserLink()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAppAsync(host, AppId, ui: false);
        using var client = host.CreateClient();
        using var response = await PostAsync(host, client, AppId, "{}");

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal("app_open_url_missing", (await ReadAsync(response)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task ShellModeReturnsAPlainWorkspaceLinkAndRequiresShell()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAppAsync(host, AppId);
        using var client = host.CreateClient();

        using var missing = await PostAsync(host, client, AppId, """{"mode":"shell"}""");
        Assert.Equal(HttpStatusCode.Conflict, missing.StatusCode);
        Assert.Equal("shell_not_installed", (await ReadAsync(missing)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task ShellModeUsesItsInstalledOriginWithoutIssuingAnyCode()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAppAsync(host, AppId);
        await SeedAppAsync(host, ShellBootstrap.AppId, origin: "https://shell.example.test");
        using var client = host.CreateClient();
        using var response = await PostAsync(host, client, AppId, """{"mode":"shell"}""");
        var json = await ReadAsync(response);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("https://shell.example.test/workspace?app=com.test.notes&path=%2F", json.GetProperty("url").GetString());
        Assert.False(json.TryGetProperty("userId", out _));
        Assert.False(json.TryGetProperty("expiresAt", out _));
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        Assert.Empty((await host.Services.GetRequiredService<AppSessionGrantStore>().ReadAsync()).Grants);
    }

    [Fact]
    public async Task InvalidModeIsNotTreatedAsStandalone()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAppAsync(host, AppId);
        using var client = host.CreateClient();
        using var response = await PostAsync(host, client, AppId, """{"mode":"browser"}""");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("open_mode_invalid", (await ReadAsync(response)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task PlainLinksStillRequireTheLocalControlSecret()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAppAsync(host, AppId);
        using var client = host.CreateClient();
        using var response = await client.PostAsJsonAsync($"/control/v1/apps/{AppId}/open-link", new { });

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
    }

    private static Task<HttpResponseMessage> PostAsync(CoreHttpHarness host, HttpClient client, string appId, string body)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, $"/control/v1/apps/{appId}/open-link")
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
        request.Headers.Add("X-Hosty-Control-Secret", host.Services.GetRequiredService<ControlSecret>().Value);
        return client.SendAsync(request);
    }

    private static async Task<JsonElement> ReadAsync(HttpResponseMessage response)
        => JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone();

    private static Task SeedAppAsync(CoreHttpHarness host, string appId, bool ui = true, string origin = AppOrigin)
        => host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(new AppRecord(
            Id: appId, DisplayName: "Notes", Description: null, Version: "1.0.0", Kind: "runtime", System: false,
            Source: "installed", ManifestPath: $"apps/{appId}/manifest.json", ManifestUrl: null, SelectedRuntime: "dev",
            OperationStatus: "installed", RuntimeState: "running", LastOperation: null, LastError: null,
            Capabilities: [], Settings: new Dictionary<string, AppSettingValue>(), StorageMappings: [], Dependencies: [],
            Endpoints: [new AppEndpointContract("web", "http", origin, true)],
            InstalledAt: DateTimeOffset.UtcNow, UpdatedAt: DateTimeOffset.UtcNow,
            Ui: ui ? new AppUiContract(null, null, "web", "/notes", []) : null));
}
