using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Haas.Hosty.Core;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class UserProfileHttpTests
{
    [Fact]
    public async Task OrdinaryUserManagesOnlyOwnProfileWithBrowserCsrfAndNoSecrets()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await users.WriteAsync(new UserDirectoryState(1,
            [new("alice", "alice@example.test", "Alice", "host.user", false, now, now), new("bob", "bob@example.test", "Bob", "host.admin", false, now, now)], [], [],
            [new("browser", "alice", now, now.AddHours(1), null, now, BrowserOrigin: "http://localhost"),
             new("scoped", "alice", now, now.AddHours(1), null, now, Kind: AccessTokenKinds.Manual, Audience: "hosty:core", Scopes: ["mcp:read"])],
            ProviderConnections: [new("owned", "alice", "Personal", "github", "", "", "42", "octocat", "oauth", "secret-access", "secret-refresh", now.AddHours(1), "client-id", now, now, "connected", "revision"),
                new("other", "bob", "Private company", "github", "", "", "43", "other-user", "pat", "other-secret", null, null, null, now, now, "connected", "revision") ]));
        using var client = host.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/profile")).StatusCode);
        client.DefaultRequestHeaders.Add("Cookie", "hosty_session=browser; hosty_csrf=csrf");
        var response = await client.GetAsync("/api/profile");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True(response.Headers.CacheControl!.NoStore);
        var text = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain("secret", text); Assert.DoesNotContain("other-user", text); Assert.DoesNotContain("client-id", text);
        using var profile = JsonDocument.Parse(text);
        Assert.Equal("alice", profile.RootElement.GetProperty("id").GetString());
        Assert.False(profile.RootElement.TryGetProperty("connections", out _));
        Assert.False(profile.RootElement.TryGetProperty("gitIdentity", out _));
        async Task<HttpResponseMessage> Save() => await client.PutAsJsonAsync("/api/profile", new { displayName = "Alice Renamed", userId = "bob", role = "host.admin" });
        Assert.Equal(HttpStatusCode.Forbidden, (await Save()).StatusCode);
        client.DefaultRequestHeaders.Add("X-Hosty-CSRF", "csrf");
        Assert.Equal(HttpStatusCode.OK, (await Save()).StatusCode);
        var state = await users.ReadAsync();
        Assert.Equal("host.user", state.Users.Single(u => u.Id == "alice").Role);
        Assert.Equal("Bob", state.Users.Single(u => u.Id == "bob").DisplayName);
        Assert.Equal("Alice Renamed", state.Users.Single(u => u.Id == "alice").DisplayName);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PutAsJsonAsync("/api/profile/connections/other", new { label = "Stolen" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.DeleteAsync("/api/profile/connections/other")).StatusCode);
        Assert.Equal(2, (await users.ReadAsync()).ProviderConnections!.Count);
        Assert.Equal(HttpStatusCode.NotFound, (await client.DeleteAsync("/api/profile/connections/owned")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/source-connections")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.DeleteAsync("/api/source-connections/owned")).StatusCode);
        Assert.Equal(2, (await users.ReadAsync()).ProviderConnections!.Count);
        client.DefaultRequestHeaders.Remove("Cookie");
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "scoped");
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/profile")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await Save()).StatusCode);
        client.DefaultRequestHeaders.Authorization = null;
        client.DefaultRequestHeaders.Add("Cookie", "hosty_session=browser; hosty_csrf=csrf");
        await users.UpdateAsync(s => s with { Users = s.Users.Select(u => u.Id == "alice" ? u with { Disabled = true } : u).ToArray() });
        Assert.NotEqual(HttpStatusCode.OK, (await Save()).StatusCode);
    }
}
