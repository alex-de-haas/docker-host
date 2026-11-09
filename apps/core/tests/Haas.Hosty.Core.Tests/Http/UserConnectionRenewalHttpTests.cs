using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Haas.Hosty.Core;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class UserConnectionRenewalHttpTests
{
    [Fact]
    public async Task AppRenewalRequiresConnectionManagementAndPreservesTheOwnersSelectedIdentity()
    {
        using var provider = new ProviderHttp(); using var providerClient = new HttpClient(provider);
        var clock = new RenewalClock();
        await using var host = await Start(providerClient, clock);
        using var client = await AppManagementHttpTests.CreateAppClient(host, "third.party.console", [CoreAppPermissions.Sources]);
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        await SeedConnections(users, clock.UtcNow);
        var pat = new { provider = "github", token = "replacement-secret", userId = "other" };
        var device = new { provider = "github", privateRepositories = true, userId = "other" };
        await Error(await client.PostAsJsonAsync("/api/source-connections/own/pat", pat), HttpStatusCode.Forbidden, "app_permission_required");
        await Error(await client.PostAsJsonAsync("/api/source-connections/own/device", device), HttpStatusCode.Forbidden, "app_permission_required");
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpdateAppAsync("third.party.console", app => app with { GrantedCorePermissions = [CoreAppPermissions.SourceConnections] });
        await Error(await client.PostAsJsonAsync("/api/source-connections/foreign/pat", pat), HttpStatusCode.NotFound, "connection_not_found");
        await Error(await client.PostAsJsonAsync("/api/source-connections/foreign/device", device), HttpStatusCode.NotFound, "connection_not_found");
        Assert.Empty(provider.Calls);
        provider.Json("""{"id":42,"login":"renamed-login"}""");
        using var renewed = await client.PostAsJsonAsync("/api/source-connections/own/pat", pat);
        renewed.EnsureSuccessStatusCode(); Assert.True(renewed.Headers.CacheControl!.NoStore);
        var text = await renewed.Content.ReadAsStringAsync();
        Assert.DoesNotContain("replacement-secret", text); Assert.DoesNotContain("foreign-secret", text);
        using var summary = JsonDocument.Parse(text);
        Assert.Equal("own", summary.RootElement.GetProperty("id").GetString());
        var afterPat = (await users.ReadAsync()).ProviderConnections!;
        Assert.Equal("replacement-secret", afterPat.Single(c => c.Id == "own").AccessToken);
        Assert.Equal("Saved label", afterPat.Single(c => c.Id == "own").Label);
        Assert.Equal("foreign-secret", afterPat.Single(c => c.Id == "foreign").AccessToken);

        provider.Json("""{"device_code":"opaque","user_code":"ABCD-EFGH","expires_in":900,"interval":5}""");
        using var starting = await client.PostAsJsonAsync("/api/source-connections/own/device", device);
        starting.EnsureSuccessStatusCode();
        using var started = JsonDocument.Parse(await starting.Content.ReadAsStringAsync());
        var attemptId = started.RootElement.GetProperty("id").GetString()!;
        Assert.Equal("replacement-secret", (await users.ReadAsync()).ProviderConnections!.Single(c => c.Id == "own").AccessToken);
        provider.Json("""{"access_token":"oauth-secret","refresh_token":"oauth-refresh","expires_in":3600,"scope":"repo,workflow,user:email"}""");
        provider.Json("""{"id":42,"login":"renamed-login"}"""); clock.Advance(5);
        using var completing = await client.PostAsync($"/api/source-connections/device/{attemptId}/poll", null);
        completing.EnsureSuccessStatusCode();
        var completedText = await completing.Content.ReadAsStringAsync();
        Assert.DoesNotContain("oauth-secret", completedText); Assert.DoesNotContain("oauth-refresh", completedText);
        using var completed = JsonDocument.Parse(completedText);
        Assert.Equal("own", completed.RootElement.GetProperty("connection").GetProperty("id").GetString());
        Assert.Contains("repo", completed.RootElement.GetProperty("connection").GetProperty("grantedScopes").EnumerateArray().Select(v => v.GetString()));
        Assert.Equal(2, (await users.ReadAsync()).ProviderConnections!.Count);
        Assert.Equal("foreign-secret", (await users.ReadAsync()).ProviderConnections!.Single(c => c.Id == "foreign").AccessToken);
        await apps.UpdateAppAsync("third.party.console", app => app with { GrantedCorePermissions = [] });
        await Error(await client.PostAsJsonAsync("/api/source-connections/own/pat", pat), HttpStatusCode.Forbidden, "app_permission_required");
    }

    [Theory]
    [InlineData("pat")]
    [InlineData("device")]
    public async Task DirectRenewalRequiresAnAdministratorBrowserSessionAndCsrf(string method)
    {
        using var provider = new ProviderHttp(); using var providerClient = new HttpClient(provider);
        var clock = new RenewalClock();
        await using var host = await Start(providerClient, clock);
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var now = clock.UtcNow;
        await users.WriteAsync(new(1,
            [new("actor", "actor@example.test", "Actor", "host.admin", false, now, now)], [], [],
            [new("browser", "actor", now, now.AddHours(1), null, now, BrowserOrigin: "http://localhost"),
                new("scoped", "actor", now, now.AddHours(1), null, now, Kind: AccessTokenKinds.Manual, Audience: "hosty:core", Scopes: ["mcp:read", "mcp:workspaces"])],
            ProviderConnections: [Connection("own", "actor", "42", "retained-secret", now)]));
        using var client = host.CreateClient();
        var input = new { provider = "github", token = "replacement-secret", privateRepositories = true };
        var path = $"/api/source-connections/own/{method}";
        Assert.NotEqual(HttpStatusCode.OK, (await client.PostAsJsonAsync(path, input)).StatusCode);
        client.DefaultRequestHeaders.Add("Cookie", "hosty_session=browser; hosty_csrf=csrf");
        await Error(await client.PostAsJsonAsync(path, input), HttpStatusCode.Forbidden, "browser_session_required");
        client.DefaultRequestHeaders.Add("X-Hosty-CSRF", "csrf");
        provider.Json(method == "pat" ? """{"id":42,"login":"owner"}""" : """{"device_code":"opaque","user_code":"ABCD-EFGH","expires_in":900,"interval":5}""");
        using var accepted = await client.PostAsJsonAsync(path, input);
        accepted.EnsureSuccessStatusCode();
        if (method == "device")
        {
            using var attempt = JsonDocument.Parse(await accepted.Content.ReadAsStringAsync());
            (await client.DeleteAsync("/api/source-connections/device/" + attempt.RootElement.GetProperty("id").GetString())).EnsureSuccessStatusCode();
            Assert.Equal("retained-secret", Assert.Single((await users.ReadAsync()).ProviderConnections!).AccessToken);
        }
        client.DefaultRequestHeaders.Remove("Cookie"); client.DefaultRequestHeaders.Authorization = new("Bearer", "scoped");
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync(path, input)).StatusCode);
        client.DefaultRequestHeaders.Authorization = null; client.DefaultRequestHeaders.Add("Cookie", "hosty_session=browser; hosty_csrf=csrf");
        await users.UpdateAsync(s => s with { Users = s.Users.Select(u => u with { Role = "host.user" }).ToArray() });
        await Error(await client.PostAsJsonAsync(path, input), HttpStatusCode.Forbidden, "admin_required");
        Assert.Single(provider.Calls);
    }

    [Fact]
    public async Task RenewalIdentityFailureAndLegacyScopeDecisionPreserveTheExistingCredential()
    {
        using var provider = new ProviderHttp(); using var providerClient = new HttpClient(provider);
        var clock = new RenewalClock();
        await using var host = await Start(providerClient, clock);
        using var client = await AppManagementHttpTests.CreateAppClient(host, "independent.settings", [CoreAppPermissions.SourceConnections]);
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        await SeedConnections(users, clock.UtcNow);
        await Error(await client.PostAsJsonAsync("/api/source-connections/own/device", new { provider = "github" }), HttpStatusCode.Conflict, "connection_scope_decision_required");
        Assert.Empty(provider.Calls);
        provider.Json("""{"id":43,"login":"wrong-account"}""");
        await Error(await client.PostAsJsonAsync("/api/source-connections/own/pat", new { provider = "github", token = "wrong-account-secret" }), HttpStatusCode.Conflict, "provider_account_changed");
        Assert.Equal("retained-secret", (await users.ReadAsync()).ProviderConnections!.Single(c => c.Id == "own").AccessToken);
        Assert.Equal(2, (await users.ReadAsync()).ProviderConnections!.Count);
    }

    private static Task<CoreHttpHarness> Start(HttpClient http, IClock clock) => CoreHttpHarness.StartAsync(clock, services =>
        services.AddSingleton(new SourceProviderRegistry([new GitHubSourceProvider(http, new ConfigurationBuilder().Build(), clock)])));

    private static UserProviderConnection Connection(string id, string userId, string accountId, string token, DateTimeOffset now)
        => new(id, userId, "Saved label", "github", "", "", accountId, "owner", "pat", token, null, null, null, now, now, "connected", "revision");

    private static Task SeedConnections(UserDirectoryStore users, DateTimeOffset now) => users.UpdateAsync(s => s with {
        Users = [.. s.Users, new("other", "other@example.test", "Other", "host.admin", false, now, now)],
        ProviderConnections = [Connection("own", "actor", "42", "retained-secret", now), Connection("foreign", "other", "43", "foreign-secret", now)] });

    private static async Task Error(HttpResponseMessage response, HttpStatusCode status, string code)
    {
        using (response)
        {
            Assert.Equal(status, response.StatusCode);
            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            Assert.Equal(code, json.RootElement.GetProperty("code").GetString());
        }
    }

    private sealed class RenewalClock : IClock
    {
        public DateTimeOffset UtcNow { get; private set; } = DateTimeOffset.Parse("2026-11-09T10:00:00Z");
        public void Advance(int seconds) => UtcNow = UtcNow.AddSeconds(seconds);
    }

    private sealed class ProviderHttp : HttpMessageHandler
    {
        private readonly Queue<string> replies = new();
        internal List<string> Calls { get; } = [];
        internal void Json(string body) => replies.Enqueue(body);
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls.Add(request.RequestUri!.AbsoluteUri);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(replies.Dequeue(), Encoding.UTF8, "application/json") });
        }
    }
}
