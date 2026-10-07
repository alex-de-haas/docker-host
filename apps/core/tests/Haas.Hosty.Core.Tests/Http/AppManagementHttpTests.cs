using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class AppManagementHttpTests
{
    [Theory]
    [InlineData("example.console")]
    [InlineData("hosty.shell")]
    public async Task AppCaller_RequiresCurrentGrant_RegardlessOfItsName(string appId)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await CreateAppClient(host, appId, []);
        await AssertError(await client.GetAsync("/api/apps"), HttpStatusCode.Forbidden, "app_permission_required");
        await SetPermissions(host, appId, [CoreAppPermissions.ReadApps]);
        (await client.GetAsync("/api/apps")).EnsureSuccessStatusCode();
        await SetPermissions(host, appId, []);
        await AssertError(await client.GetAsync("/api/apps"), HttpStatusCode.Forbidden, "app_permission_required");
    }

    [Fact]
    public async Task LaunchedApp_DeclaredPermissionDeniesCallsUntilCoreApproval()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var lifecycle = host.Services.GetRequiredService<CoreLifecycleService>();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var folder = Path.Combine(Path.GetTempPath(), $"hosty-permission-launch-{Guid.NewGuid():N}");
        Directory.CreateDirectory(folder);
        var manifest = Path.Combine(folder, "manifest.json");
        await File.WriteAllTextAsync(manifest, """
            {"schemaVersion":"app.0.1","id":"example.console","name":"Console","version":"1.0.0",
             "corePermissions":["apps.read"],
             "runtimeProfiles":[{"key":"dev","type":"localCommand","development":true,"default":true}],"defaultRuntime":"dev",
             "services":[{"key":"app","runtimes":{"dev":{"type":"localCommand","command":"sleep 60","workingDirectory":"."}}}]}
            """);
        try
        {
            await lifecycle.InstallAsync(new(manifest, Autostart: false));
            var installed = (await apps.GetAppAsync("example.console"))!;
            using var client = await CreateAppClient(host, installed.Id, []);
            await apps.UpsertAppAsync(installed with { GrantedCorePermissions = [] });
            await lifecycle.StartAsync(installed.Id);
            Assert.True(AppRuntimeStates.IsUp((await apps.GetAppAsync(installed.Id))!.RuntimeState));
            await AssertError(await client.GetAsync("/api/apps"), HttpStatusCode.Forbidden, "app_permission_required");
            await lifecycle.ApplyOptionalPermissionsAsync(await lifecycle.CreatePermissionPlanAsync(installed.Id, default), [], default);
            (await client.GetAsync("/api/apps")).EnsureSuccessStatusCode();
            await SetPermissions(host, installed.Id, []);
            await lifecycle.ObserveAppPermissionsAsync(default);
            Assert.True(AppRuntimeStates.IsUp((await apps.GetAppAsync(installed.Id))!.RuntimeState));
            await AssertError(await client.GetAsync("/api/apps"), HttpStatusCode.Forbidden, "app_permission_required");
        }
        finally
        {
            if (await apps.GetAppAsync("example.console") is not null) await lifecycle.StopAsync("example.console");
            Directory.Delete(folder, true);
        }
    }

    [Fact]
    public async Task ReadApps_DoesNotDiscloseSettingsOrMountBindings()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await CreateAppClient(host, "example.console", [CoreAppPermissions.ReadApps]);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var app = (await apps.GetAppAsync("example.console"))!;
        await apps.UpsertAppAsync(app with { Settings = new Dictionary<string, AppSettingValue>
            { ["ordinary"] = new("ordinary", "string", "private-configuration", false) } });
        var text = await client.GetStringAsync("/api/apps");
        Assert.DoesNotContain("private-configuration", text);
        await SetPermissions(host, app.Id, [CoreAppPermissions.ReadApps, CoreAppPermissions.ConfigureApps]);
        Assert.Contains("private-configuration", await client.GetStringAsync("/api/apps"));
    }

    [Theory]
    [InlineData("/api/core/settings", "core.configure")]
    [InlineData("/api/core/logs", "core.logs")]
    [InlineData("/api/global-mounts", "core.configure")]
    [InlineData("/api/auth/users", "users.read")]
    [InlineData("/api/notifications", "apps.notifications")]
    public async Task MappedRead_RequiresItsOwnPermission(string route, string permission)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await CreateAppClient(host, "example.console", [CoreAppPermissions.ReadApps]);
        await AssertError(await client.GetAsync(route), HttpStatusCode.Forbidden, "app_permission_required");
        await SetPermissions(host, "example.console", [permission]);
        (await client.GetAsync(route)).EnsureSuccessStatusCode();
    }

    [Theory]
    [InlineData("POST", "/api/apps/missing/start", "apps.lifecycle")]
    [InlineData("POST", "/api/apps/missing/stop", "apps.lifecycle")]
    [InlineData("POST", "/api/apps/missing/restart", "apps.lifecycle")]
    [InlineData("POST", "/api/apps/missing/configure", "apps.configure")]
    [InlineData("GET", "/api/apps/missing/settings/password/value", "apps.configure")]
    [InlineData("GET", "/api/apps/missing/backups", "apps.configure")]
    [InlineData("GET", "/api/apps/missing/public-origins", "apps.configure")]
    [InlineData("GET", "/api/apps/missing/remove-impact", "apps.install")]
    [InlineData("GET", "/api/apps/missing/feeds", "apps.install")]
    [InlineData("GET", "/api/apps/missing/update/plan", "apps.install")]
    [InlineData("POST", "/api/apps/missing/update", "apps.install")]
    [InlineData("GET", "/api/apps/missing/logs", "apps.logs")]
    [InlineData("GET", "/api/apps/missing/permissions", "apps.read")]
    [InlineData("GET", "/api/apps/missing/source", "apps.lifecycle")]
    [InlineData("GET", "/api/apps/missing/source/status", "apps.sources")]
    [InlineData("GET", "/api/apps/missing/source-access", "apps.sources")]
    [InlineData("GET", "/api/core/agents", "core.configure")]
    [InlineData("GET", "/api/core/public-origin", "core.configure")]
    [InlineData("GET", "/api/core/development", "core.read")]
    [InlineData("GET", "/api/auth/invitations", "users.read")]
    [InlineData("PATCH", "/api/auth/users/missing", "users.manage")]
    public async Task OperationMapping_DeniesMissingGrant_AndRoutesAuthorizedRequests(string method, string route, string permission)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await CreateAppClient(host, "example.console", []);
        HttpRequestMessage Request() => new(new HttpMethod(method), route) {
            Content = method == "GET" ? null : JsonContent.Create(new { }) };
        await AssertError(await client.SendAsync(Request()), HttpStatusCode.Forbidden, "app_permission_required");
        await SetPermissions(host, "example.console", [permission]);
        using var response = await client.SendAsync(Request());
        var text = await response.Content.ReadAsStringAsync();
        // Unknown targets/body values may fail domain validation; they must reach the mapped route.
        Assert.DoesNotContain("app_operation_forbidden", text);
        Assert.DoesNotContain("app_permission_required", text);
        Assert.NotEqual(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.NotEqual(HttpStatusCode.InternalServerError, response.StatusCode);
    }

    [Theory]
    [InlineData("POST", "/api/apps/install")]
    [InlineData("POST", "/api/apps/example.console/remove")]
    [InlineData("POST", "/api/auth/credentials")]
    [InlineData("POST", "/api/auth/device/requests/approve")]
    [InlineData("POST", "/api/auth/oauth/requests/example/decide")]
    [InlineData("POST", "/api/apps/another.app/launch-code")]
    [InlineData("POST", "/api/apps/another.app/delegated-token")]
    [InlineData("POST", "/api/auth/apps/authorize")]
    [InlineData("GET", "/install/permissions/example.console")]
    public async Task AllManagementPermissions_DoNotGrantCoreSessionAuthority(string method, string route)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await CreateAppClient(host, "example.console", CoreAppPermissions.Known);
        using var request = new HttpRequestMessage(new HttpMethod(method), route) { Content = JsonContent.Create(new { }) };
        await AssertError(await client.SendAsync(request), HttpStatusCode.Forbidden, "app_operation_forbidden");
    }

    [Fact]
    public async Task MixedCookie_CannotSubstituteForMissingAppPermission()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await CreateAppClient(host, "example.console", []);
        client.DefaultRequestHeaders.Add("Cookie", "hosty_session=operator");
        await AssertError(await client.GetAsync("/api/apps"), HttpStatusCode.Forbidden, "app_credential_mixed");
    }

    [Fact]
    public async Task ServiceCredential_AndUserGrantMustNameTheSameApp()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await CreateAppClient(host, "example.console", CoreAppPermissions.Known);
        client.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken("other.app"));
        await AssertError(await client.GetAsync("/api/apps"), HttpStatusCode.Forbidden, "token_app_mismatch");
    }

    [Fact]
    public async Task UserRoleAndRevocation_AreRecheckedOnEveryOperation()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await CreateAppClient(host, "example.console", [CoreAppPermissions.ReadUsers]);
        (await client.GetAsync("/api/auth/users")).EnsureSuccessStatusCode();
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        await users.UpdateAsync(s => s with { Users = s.Users.Select(u => u with { Role = "host.user" }).ToArray(),
            Assignments = [new("example.console", "actor", DateTimeOffset.UtcNow)] });
        await AssertError(await client.GetAsync("/api/auth/users"), HttpStatusCode.Forbidden, "admin_required");
        await host.Services.GetRequiredService<AppSessionGrantStore>().RevokeByAuthorizingSessionAsync("operator", DateTimeOffset.UtcNow);
        await AssertError(await client.GetAsync("/api/auth/session"), HttpStatusCode.Unauthorized, "token_revoked");
    }

    [Fact]
    public async Task AssignedSystemApp_WithAllAppGrants_CannotGiveMemberAdministrativePowers()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await CreateAppClient(host, "hosty.shell", CoreAppPermissions.Known);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync((await apps.GetAppAsync("hosty.shell"))! with { System = true });
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        await users.UpdateAsync(s => s with { Users = s.Users.Select(u => u with { Role = "host.user" }).ToArray(),
            Assignments = [new("hosty.shell", "actor", DateTimeOffset.UtcNow)] });
        (await client.GetAsync("/api/auth/session")).EnsureSuccessStatusCode();
        (await client.GetAsync("/api/apps")).EnsureSuccessStatusCode();
        await AssertError(await client.GetAsync("/api/auth/users"), HttpStatusCode.Forbidden, "admin_required");
        await AssertError(await client.PostAsJsonAsync("/api/apps/hosty.shell/stop", new { }),
            HttpStatusCode.Forbidden, "admin_required");
        await users.UpdateAsync(s => s with { Assignments = [] });
        await AssertError(await client.GetAsync("/api/auth/session"), HttpStatusCode.Forbidden, "app_access_denied");
    }

    [Theory]
    [InlineData("installed-apps")]
    [InlineData("app-directory")]
    [InlineData("installed-apps/not.installed/update-status")]
    public async Task ServiceRosterRoutes_AlsoRequireReadApps(string suffix)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await CreateAppClient(host, "example.console", []);
        client.DefaultRequestHeaders.Remove(AppManagementAuthorization.IdentityHeader);
        var route = "/api/internal/apps/example.console/" + suffix;
        await AssertError(await client.GetAsync(route), HttpStatusCode.Forbidden, "app_permission_required");
        await SetPermissions(host, "example.console", [CoreAppPermissions.ReadApps]);
        (await client.GetAsync(route)).EnsureSuccessStatusCode();
        await SetPermissions(host, "example.console", []);
        await AssertError(await client.GetAsync(route), HttpStatusCode.Forbidden, "app_permission_required");
    }

    [Fact]
    public async Task ConfigureWithAutostart_AlsoRequiresLifecyclePermission()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await CreateAppClient(host, "example.console", [CoreAppPermissions.ConfigureApps]);
        await AssertError(await client.PostAsJsonAsync("/api/apps/example.console/configure", new { autostart = true }),
            HttpStatusCode.Forbidden, "app_permission_required");
    }

    [Fact]
    public async Task PermissionReview_PreservesAppOwnership_AndCannotReviewOtherApps()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await CreateAppClient(host, "example.console", []);
        using var response = await client.PostAsJsonAsync("/api/installations", new { permissionsAppId = "example.console" });
        response.EnsureSuccessStatusCode();
        var id = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var request = host.Services.GetRequiredService<InstallationApprovalStore>().Get(id);
        Assert.Equal("example.console", request.CallerAppId);
        Assert.NotNull(request.IdentityToken);
        await AssertError(await client.PostAsJsonAsync("/api/installations", new { permissionsAppId = "another.app" }),
            HttpStatusCode.Forbidden, "app_access_denied");
        (await client.PostAsJsonAsync($"/api/installations/{id}/submit", new { })).EnsureSuccessStatusCode();
        Assert.NotEqual("approved", request.Status);
    }

    [Theory]
    [InlineData("role")]
    [InlineData("permission")]
    [InlineData("session")]
    public async Task EventStream_StopsBeforeDeliveringDataAfterAuthorityChanges(string change)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await CreateAppClient(host, "example.console", CoreAppPermissions.Known);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var response = await client.GetAsync("/api/events", HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        response.EnsureSuccessStatusCode();
        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(timeout.Token));
        Assert.Equal(": connected", await reader.ReadLineAsync(timeout.Token));
        Assert.Equal("", await reader.ReadLineAsync(timeout.Token));
        if (change == "role")
            await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(s => s with
            {
                Users = s.Users.Select(u => u with { Role = "host.user" }).ToArray(),
                Assignments = [new("example.console", "actor", DateTimeOffset.UtcNow)],
            });
        else if (change == "permission")
            await SetPermissions(host, "example.console", []);
        else
            await host.Services.GetRequiredService<AppSessionGrantStore>()
                .RevokeByAuthorizingSessionAsync("operator", DateTimeOffset.UtcNow);
        host.Services.GetRequiredService<CoreEventHub>().PublishAppEvent(CoreEventHub.AppChanged, "private.app");
        Assert.Null(await reader.ReadLineAsync(timeout.Token));
    }

    [Fact]
    public async Task OwnProfileAppApi_NeedsOnlyIdentity_AndKeepsOwnerAndSecretsInsideCore()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await CreateAppClient(host, "example.console", []);
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var now = DateTimeOffset.UtcNow;
        await users.UpdateAsync(s => s with {
            Users = [.. s.Users, new("other", "other@example.test", "Other", "host.admin", false, now, now)],
            ProviderConnections = [
                new("own", "actor", "Personal", "github", "", "", "42", "alice", "pat", "never-export", null, null, null, now, now, "connected", "revision"),
                new("foreign", "other", "Other account", "github", "", "", "43", "bob", "pat", "foreign-secret", null, null, null, now, now, "connected", "revision")]
        });
        using var read = await client.GetAsync("/api/profile");
        read.EnsureSuccessStatusCode();
        var body = await read.Content.ReadAsStringAsync();
        Assert.DoesNotContain("Personal", body); Assert.DoesNotContain("connections", body); Assert.DoesNotContain("gitIdentity", body); Assert.DoesNotContain("Other account", body);
        Assert.DoesNotContain("never-export", body); Assert.DoesNotContain("foreign-secret", body);
        (await client.PutAsJsonAsync("/api/profile", new { displayName = "Changed", userId = "other", role = "host.user", updateGitIdentity = true, gitIdentity = new { name = "Forged", email = "forged@example.test" } })).EnsureSuccessStatusCode();
        var state = await users.ReadAsync();
        Assert.Equal("Other", state.Users.Single(u => u.Id == "other").DisplayName);
        Assert.Equal("Changed", state.Users.Single(u => u.Id == "actor").DisplayName);
        Assert.Null(state.Users.Single(u => u.Id == "actor").GitIdentity);
        Assert.Equal("host.admin", state.Users.Single(u => u.Id == "actor").Role);
        await host.Services.GetRequiredService<AppSessionGrantStore>().RevokeByAuthorizingSessionAsync("operator", now);
        await AssertError(await client.PutAsJsonAsync("/api/profile", new { displayName = "Revoked" }), HttpStatusCode.Unauthorized, "token_revoked");
    }

    [Fact]
    public async Task SourceConnections_SeparateConsumptionFromManagement_RequireAdmin_AndNeverCrossOwnersOrExportTokens()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await CreateAppClient(host, "example.console", [CoreAppPermissions.ManageUsers]);
        await AssertError(await client.GetAsync("/api/source-connections"), HttpStatusCode.Forbidden, "app_permission_required");
        await AssertError(await client.PutAsJsonAsync("/api/source-connections/identity", new { gitIdentity = new { name = "Author", email = "author@example.test" } }), HttpStatusCode.Forbidden, "app_permission_required");
        await SetPermissions(host, "example.console", [CoreAppPermissions.Sources]);
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var now = DateTimeOffset.UtcNow;
        await users.UpdateAsync(s => s with {
            Users = [.. s.Users, new("other", "other@example.test", "Other", "host.admin", false, now, now)],
            ProviderConnections = [
                new("own", "actor", "Personal", "github", "", "", "42", "alice", "pat", "never-export", null, null, null, now, now, "connected", "revision"),
                new("foreign", "other", "Other account", "github", "", "", "43", "bob", "pat", "foreign-secret", null, null, null, now, now, "connected", "revision")]
        });
        using var response = await client.GetAsync("/api/source-connections");
        response.EnsureSuccessStatusCode();
        Assert.True(response.Headers.CacheControl!.NoStore);
        var text = await response.Content.ReadAsStringAsync();
        Assert.Contains("Personal", text); Assert.DoesNotContain("Other account", text);
        using var profile = JsonDocument.Parse(text);
        Assert.Equal("github", Assert.Single(profile.RootElement.GetProperty("providers").EnumerateArray()).GetProperty("id").GetString());
        Assert.DoesNotContain("never-export", text); Assert.DoesNotContain("foreign-secret", text);
        await AssertError(await client.PutAsJsonAsync("/api/source-connections/identity", new { gitIdentity = new { name = "Denied", email = "denied@example.test" } }), HttpStatusCode.Forbidden, "app_permission_required");
        await AssertError(await client.DeleteAsync("/api/source-connections/own"), HttpStatusCode.Forbidden, "app_permission_required");
        await SetPermissions(host, "example.console", [CoreAppPermissions.SourceConnections]);
        (await client.GetAsync("/api/source-connections")).EnsureSuccessStatusCode();
        (await client.PutAsJsonAsync("/api/source-connections/identity", new { userId = "other", displayName = "Must not change", gitIdentity = new { name = "Author", email = "author@example.test" } })).EnsureSuccessStatusCode();
        var state = await users.ReadAsync();
        Assert.Equal("Actor", state.Users.Single(u => u.Id == "actor").DisplayName);
        Assert.Equal("Author", state.Users.Single(u => u.Id == "actor").GitIdentity!.Name);
        Assert.Null(state.Users.Single(u => u.Id == "other").GitIdentity);
        Assert.Equal(HttpStatusCode.NotFound, (await client.DeleteAsync("/api/source-connections/foreign")).StatusCode);
        (await client.PutAsJsonAsync("/api/source-connections/own", new { label = "Renamed" })).EnsureSuccessStatusCode();
        (await client.DeleteAsync("/api/source-connections/own")).EnsureSuccessStatusCode();
        Assert.Equal("foreign", Assert.Single((await users.ReadAsync()).ProviderConnections!).Id);
        await SetPermissions(host, "example.console", []);
        await AssertError(await client.GetAsync("/api/source-connections"), HttpStatusCode.Forbidden, "app_permission_required");
        await SetPermissions(host, "example.console", [CoreAppPermissions.Sources]);
        await users.UpdateAsync(s => s with { Users = s.Users.Select(u => u.Id == "actor" ? u with { Role = "host.user" } : u).ToArray(), Assignments = [new("example.console", "actor", now)] });
        await AssertError(await client.GetAsync("/api/source-connections"), HttpStatusCode.Forbidden, "admin_required");
    }

    [Fact]
    public async Task SourceDeviceAuthorization_BindsInternallyToParentBrowserSession()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await CreateAppClient(host, "example.console", [CoreAppPermissions.SourceConnections]);
        var identities = host.Services.GetRequiredService<AppIdentityService>();
        var grant = client.DefaultRequestHeaders.GetValues(AppManagementAuthorization.IdentityHeader).Single();
        Assert.Equal("operator", await identities.AuthorizingBrowserSessionAsync(grant, "example.console", default));
        // An unsupported provider validates the browser grant without making external calls.
        await AssertError(await client.PostAsJsonAsync("/api/source-connections/device", new { provider = "azure-devops", organization = "team" }), HttpStatusCode.Conflict, "provider_unsupported");
        var diagnostic = await identities.CreateLaunchTokenAsync("example.console", "actor");
        client.DefaultRequestHeaders.Remove(AppManagementAuthorization.IdentityHeader);
        client.DefaultRequestHeaders.Add(AppManagementAuthorization.IdentityHeader, diagnostic.AccessToken);
        await AssertError(await client.PostAsJsonAsync("/api/source-connections/device", new { label = "GitHub", provider = "github" }), HttpStatusCode.Unauthorized, "reauth_required");
        await host.Services.GetRequiredService<AppSessionGrantStore>().RevokeByAuthorizingSessionAsync("operator", DateTimeOffset.UtcNow);
        await Assert.ThrowsAsync<AppIdentityException>(() => identities.AuthorizingBrowserSessionAsync(grant, "example.console", default));
    }

    internal static async Task<HttpClient> CreateAppClient(CoreHttpHarness host, string appId, IReadOnlyList<string> permissions)
    {
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
            [new("actor", "actor@example.test", "Actor", "host.admin", false, now, now)], [], [],
            [new("operator", "actor", now, now.AddHours(8), null, now, BrowserOrigin: "http://localhost:7070")]));
        await host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(new AppRecord(
            appId, "Management client", null, "1.0.0", "runtime", false, "manifest", null, null, "dev",
            "installed", "stopped", null, null, [], new Dictionary<string, AppSettingValue>(), [], [], [], now, now,
            GrantedCorePermissions: permissions, RequiredCorePermissions: [], OptionalCorePermissions: CoreAppPermissions.Known));
        var identity = host.Services.GetRequiredService<AppIdentityService>();
        // Create a real app-bound grant through a code; only fixture accounts/sessions are seeded.
        var codes = host.Services.GetRequiredService<AppAuthCodeStore>();
        await codes.AppendCodeAsync(new("qa-code", appId, "actor", "http://app.test/callback", now, now.AddMinutes(5), null, "operator", ActivityAuthorized: true, CodeChallenge: AuthCodeProof.Challenge), now);
        var token = await identity.ExchangeCodeAsync("qa-code", appId, AuthCodeProof.Verifier);
        var client = host.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(appId));
        client.DefaultRequestHeaders.Add(AppManagementAuthorization.IdentityHeader, token.AccessToken);
        return client;
    }

    private static async Task SetPermissions(CoreHttpHarness host, string appId, IReadOnlyList<string> permissions)
    {
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync((await apps.GetAppAsync(appId))! with { GrantedCorePermissions = permissions });
    }

    private static async Task AssertError(HttpResponseMessage response, HttpStatusCode status, string code)
    {
        using (response)
        {
            var text = await response.Content.ReadAsStringAsync();
            Assert.True(response.StatusCode == status, $"Expected {status}; received {response.StatusCode}: {text}");
            Assert.Equal(code, JsonDocument.Parse(text).RootElement.GetProperty("code").GetString());
        }
    }
}
