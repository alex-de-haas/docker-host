using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class UserCreateHttpTests
{
    private const string Password = "isolated-created-user-password";

    [Theory]
    [InlineData(null, true, HttpStatusCode.Unauthorized, "session_missing")]
    [InlineData("host.user", true, HttpStatusCode.Forbidden, "admin_required")]
    [InlineData("host.admin", false, HttpStatusCode.Forbidden, "csrf_invalid")]
    public async Task CreationRequiresAdministratorAndBrowserCsrf(string? role, bool csrf, HttpStatusCode status, string code)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var browser = await BrowserAsync(host, role, csrf);

        using var response = await browser.PostAsJsonAsync("/api/auth/users", Proposal());

        Assert.Equal(status, response.StatusCode);
        Assert.Equal(code, (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        var state = await host.Services.GetRequiredService<UserDirectoryStore>().ReadAsync();
        Assert.DoesNotContain(state.Users, user => user.Email == "created@example.test");
        Assert.Empty(state.PasswordCredentials ?? []);
    }

    [Fact]
    public async Task AppCallerNeedsManageUsersPermissionBeforePreparingCreation()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var app = await AppManagementHttpTests.CreateAppClient(host, "example.user-admin", [CoreAppPermissions.ReadUsers]);

        using var denied = await app.PostAsJsonAsync("/api/auth/users", Proposal());
        Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        Assert.Equal("app_permission_required", (await denied.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());

        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var installed = (await apps.GetAppAsync("example.user-admin"))!;
        await apps.UpsertAppAsync(installed with { GrantedCorePermissions = [CoreAppPermissions.ManageUsers] });
        using var prepared = await app.PostAsJsonAsync("/api/auth/users", Proposal());
        Assert.Equal(428, (int)prepared.StatusCode);
        Assert.Single((await host.Services.GetRequiredService<UserDirectoryStore>().ReadAsync()).Users);
    }

    [Theory]
    [InlineData("/api/auth/users")]
    [InlineData("/API/Auth/Users/")]
    public async Task ReviewedCreationIsRedactedAndIdempotent_AndNewUserCanLogInNormally(string path)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var app = await AppManagementHttpTests.CreateAppClient(host, "example.user-admin", [CoreAppPermissions.ManageUsers]);
        await ProtectedSettingsHttpTests.NormalizeBrowser(host);
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        using var prepared = await app.PostAsJsonAsync(path, Proposal());
        Assert.Equal(428, (int)prepared.StatusCode);
        Assert.Single((await users.ReadAsync()).Users);
        var review = (await prepared.Content.ReadFromJsonAsync<SettingsChangeView>())!;

        using var browser = ProtectedSettingsHttpTests.Browser(host);
        var html = await browser.GetStringAsync("/settings/confirm/" + review.Id);
        Assert.DoesNotContain(Password, html);
        Assert.Contains("created@example.test", html);
        await ProtectedSettingsHttpTests.Decide(browser, review.Id, html, "approve");
        app.DefaultRequestHeaders.Add(ProtectedSettingsChanges.Header, review.Id);

        using var applied = await app.PostAsJsonAsync(path, Proposal());
        applied.EnsureSuccessStatusCode();
        Assert.False(applied.Headers.Contains("Set-Cookie"));
        var body = await applied.Content.ReadAsStringAsync();
        Assert.DoesNotContain(Password, body);
        Assert.DoesNotContain("\"hash\"", body);
        Assert.DoesNotContain("\"salt\"", body);
        var result = (await applied.Content.ReadFromJsonAsync<HostUserCreateResponse>())!;
        Assert.Equal("created@example.test", result.User.Email);
        Assert.Equal("Created User", result.User.DisplayName);

        using var replayed = await app.PostAsJsonAsync(path, Proposal());
        replayed.EnsureSuccessStatusCode();
        Assert.Equal(body, await replayed.Content.ReadAsStringAsync());
        var state = await users.ReadAsync();
        Assert.Equal(2, state.Users.Count);
        Assert.Single(state.PasswordCredentials ?? []);
        Assert.Empty(state.Invitations);
        Assert.Equal("actor", Assert.Single(state.Sessions).UserId);
        var operatorSession = await browser.GetFromJsonAsync<JsonElement>("/api/auth/session");
        Assert.Equal("actor", operatorSession.GetProperty("user").GetProperty("id").GetString());
        var audit = await host.Services.GetRequiredService<AuditStore>().ReadRecentAsync();
        var creation = Assert.Single(audit, entry => entry.Action == "auth.user.created");
        Assert.Equal("actor", creation.ActorUserId);
        Assert.Equal(result.User.Id, creation.ResourceId);
        Assert.DoesNotContain(Password, await File.ReadAllTextAsync(host.Services.GetRequiredService<CoreDataPaths>().AuditLogPath));

        // Only the isolated in-process fixture seeds the administrator. The created account must use
        // the production password login endpoint to obtain its own session.
        using var newUser = host.CreateClient();
        using var login = await newUser.PostAsync("/login", new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["email"] = "CREATED@EXAMPLE.TEST", ["password"] = Password,
        }));
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        Assert.Contains("Signed in. This host has no web UI installed.", await login.Content.ReadAsStringAsync());
        var cookie = Assert.Single(login.Headers.GetValues("Set-Cookie"), value => value.StartsWith("hosty_session=", StringComparison.Ordinal));
        newUser.DefaultRequestHeaders.Add("Cookie", cookie.Split(';')[0]);
        var session = await newUser.GetFromJsonAsync<JsonElement>("/api/auth/session");
        Assert.True(session.GetProperty("authenticated").GetBoolean());
        Assert.Equal(result.User.Id, session.GetProperty("user").GetProperty("id").GetString());
    }

    [Fact]
    public async Task ReviewedInvalidPasswordReturnsPolicyErrorWithoutPartialUser()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var browser = await BrowserAsync(host, "host.admin");

        using var response = await CoreReviewFixture.PostAsync(browser, "/api/auth/users", new
        {
            email = "created@example.test", password = "short", assignedAppIds = new[] { "example.notes" },
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("password_invalid", (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        var state = await host.Services.GetRequiredService<UserDirectoryStore>().ReadAsync();
        Assert.Single(state.Users);
        Assert.Empty(state.PasswordCredentials ?? []);
        Assert.Empty(state.Assignments);
    }

    private static object Proposal() => new
    {
        email = "created@example.test", displayName = "Created User", password = Password, role = "host.user",
    };

    private static async Task<HttpClient> BrowserAsync(CoreHttpHarness host, string? role, bool csrf = true)
    {
        var client = host.CreateClient();
        var cookies = new List<string>();
        if (role is not null)
        {
            var now = host.Services.GetRequiredService<IClock>().UtcNow;
            await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
                [new("actor", "actor@example.test", "Actor", role, false, now, now)], [], [],
                [new("operator", "actor", now, now.AddHours(1), null, now, BrowserOrigin: "http://localhost")]));
            cookies.Add("hosty_session=operator");
        }
        if (csrf)
        {
            cookies.Add("hosty_csrf=create-user-proof");
            client.DefaultRequestHeaders.Add(CoreSessionAuthorization.CsrfHeaderName, "create-user-proof");
        }
        if (cookies.Count > 0) client.DefaultRequestHeaders.Add("Cookie", string.Join("; ", cookies));
        return client;
    }
}
