using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Haas.Hosty.Core;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class ProviderHttpTests
{
    [Theory]
    [InlineData("http://127.0.0.1:3456", null)]
    [InlineData("http://127.0.0.1:3456", "https://speech.example.test")]
    [InlineData("http://[::1]:3456", null)]
    [InlineData("http://192.0.2.10:3456", "https://speech.example.test")]
    public async Task SpeechDiscoveryAndCredentialsUseTransportInsteadOfBrowserOrigin(string transport, string? publicOrigin)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var tokens = host.Services.GetRequiredService<AppServiceTokenService>();
        await apps.UpsertAppAsync(Record("example.consumer") with { GrantedCorePermissions = [CoreAppPermissions.SpeechProviders] });
        await apps.UpsertAppAsync(Speech("example.speech") with {
            Endpoints = [new("api", "http", transport, true)],
            Settings = publicOrigin is null ? new Dictionary<string, AppSettingValue>()
                : new Dictionary<string, AppSettingValue> { [PublicOriginSettings.BuildSettingKey("api")] = new(PublicOriginSettings.BuildSettingKey("api"), "string", publicOrigin, false) },
        });
        using var client = host.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", tokens.CreateToken("example.consumer"));

        using var discovery = await client.GetAsync("/api/internal/apps/example.consumer/providers/speech-to-text");
        discovery.EnsureSuccessStatusCode();
        var descriptor = Assert.Single((await discovery.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("providers").EnumerateArray());
        Assert.Equal(transport + "/api/speech/v1", descriptor.GetProperty("url").GetString());
        Assert.True(descriptor.GetProperty("available").GetBoolean());

        using var issuance = await client.PostAsJsonAsync("/api/internal/apps/example.consumer/providers/speech-to-text/token",
            new { providerAppId = "example.speech" });
        issuance.EnsureSuccessStatusCode();
        var binding = (await issuance.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("provider");
        Assert.Equal(transport + "/api/speech/v1", binding.GetProperty("url").GetString());
    }

    [Fact]
    public async Task ProviderWithoutTransportCannotUsePublicOriginToMintCredentials()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var access = host.Services.GetRequiredService<ProviderAccessService>();
        var caller = Record("example.consumer") with { GrantedCorePermissions = [CoreAppPermissions.SpeechProviders] };
        var target = Speech("example.speech") with {
            Endpoints = [new("api", "http", "", true, PublicOrigin: "https://speech.example.test")],
        };
        await apps.UpsertAppAsync(caller);
        await apps.UpsertAppAsync(target);

        var descriptor = Assert.Single((await access.ListAsync(caller, "speech-to-text", default)).Providers);
        Assert.Null(descriptor.Url);
        Assert.False(descriptor.Available);
        var error = await Assert.ThrowsAsync<AppIdentityException>(() => access.IssueAsync(caller, "speech-to-text", new(target.Id), null, default));
        Assert.Equal("provider_unavailable", error.Code);
    }

    [Fact]
    public async Task AssistantDiscoveryProjectsDeclaredBrowserSurfacesWithIndependentEndpoints()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var tokens = host.Services.GetRequiredService<AppServiceTokenService>();
        await apps.UpsertAppAsync(Record("example.consumer") with { GrantedCorePermissions = [CoreAppPermissions.AssistantProviders] });
        var target = Speech("example.assistant") with {
            ConfirmedRoles = ["assistant"],
            Endpoints = [new("api", "http", "http://127.0.0.1:3456", true),
                new("web", "http", "http://127.0.0.1:4567", true, PublicOrigin: "https://assistant.example.test")],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["assistant"] = [new("default", "api", "/api/assistant/v1", 1, ["attachments"])] },
            Ui = new(null, null, "web", "/settings", [], Panels: [new("/assistant", "web", "Assistant")]),
        };
        await apps.UpsertAppAsync(target);
        await apps.UpsertAppAsync(target with { Id = "example.unconfirmed", ConfirmedRoles = [] });
        using var client = host.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", tokens.CreateToken("example.consumer"));
        using var response = await client.GetAsync("/api/internal/apps/example.consumer/providers/assistant");
        response.EnsureSuccessStatusCode();
        var provider = Assert.Single((await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("providers").EnumerateArray());
        Assert.Equal("example.assistant", provider.GetProperty("appId").GetString());
        Assert.Equal("http://127.0.0.1:3456/api/assistant/v1", provider.GetProperty("url").GetString());
        var panel = provider.GetProperty("uiSurfaces").EnumerateArray().Single(surface => surface.GetProperty("path").GetString() == "/assistant");
        Assert.Equal("web", panel.GetProperty("endpoint").GetString());
        var browser = new Uri(panel.GetProperty("url").GetString()!);
        Assert.EndsWith(".hosty.localhost", browser.Host);
        Assert.Equal(4567, browser.Port);
        Assert.Equal("/assistant", browser.AbsolutePath);
        Assert.NotEqual(new Uri(provider.GetProperty("url").GetString()!).Authority, new Uri(panel.GetProperty("url").GetString()!).Authority);
    }

    [Fact]
    public async Task OwnPermissionStateNeedsNoGrant_ReportsUnsupportedNames_AndRejectsForeignApp()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var tokens = host.Services.GetRequiredService<AppServiceTokenService>();
        await apps.UpsertAppAsync(Record("example.consumer") with {
            RequiredCorePermissions = [CoreAppPermissions.ReadApps, "removed.permission"],
            GrantedCorePermissions = [], OptionalCorePermissions = [CoreAppPermissions.AppLogs] });
        await apps.UpsertAppAsync(Record("example.other"));
        using var client = host.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", tokens.CreateToken("example.consumer"));
        using var response = await client.GetAsync("/api/internal/apps/example.consumer/permissions");
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("removed.permission", body.GetProperty("unsupportedRequired")[0].GetString());
        Assert.Equal(2, body.GetProperty("required").GetArrayLength());
        Assert.Empty(body.GetProperty("granted").EnumerateArray());
        Assert.False(body.GetProperty("reviewAvailable").GetBoolean());
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/internal/apps/example.other/permissions")).StatusCode);
    }

    [Fact]
    public async Task OrdinaryConsumerNeedsGrant_AndCredentialIsBoundToProviderAndCategory()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var tokens = host.Services.GetRequiredService<AppServiceTokenService>();
        await apps.UpsertAppAsync(Record("example.consumer"));
        await apps.UpsertAppAsync(Speech("example.speech"));
        await apps.UpsertAppAsync(Speech("example.other"));
        using var client = host.CreateClient();
        async Task<HttpResponseMessage> Call(string app, string suffix, object? body = null)
        {
            using var request = new HttpRequestMessage(body is null ? HttpMethod.Get : HttpMethod.Post, $"/api/internal/apps/{app}/{suffix}");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", tokens.CreateToken(app));
            if (body is not null) request.Content = JsonContent.Create(body);
            return await client.SendAsync(request);
        }
        Assert.Equal(HttpStatusCode.Forbidden, (await Call("example.consumer", "providers/speech-to-text")).StatusCode);
        await apps.UpdateAppAsync("example.consumer", r => r with { GrantedCorePermissions = [CoreAppPermissions.SpeechProviders], RequiredCorePermissions = [], OptionalCorePermissions = [CoreAppPermissions.SpeechProviders], PermissionRevision = "grant-1" });
        var list = await Call("example.consumer", "providers/speech-to-text");
        Assert.Equal(HttpStatusCode.OK, list.StatusCode);
        Assert.Equal(2, (await list.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("providers").GetArrayLength());
        var issued = await Call("example.consumer", "providers/speech-to-text/token", new { providerAppId = "example.speech" });
        Assert.Equal(HttpStatusCode.OK, issued.StatusCode);
        var token = (await issued.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("token").GetString();
        var good = await Call("example.speech", "provider/introspect", new { token, kind = "speech-to-text" });
        Assert.Equal(HttpStatusCode.OK, good.StatusCode);
        Assert.Equal("example.consumer", (await good.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("callerAppId").GetString());
        Assert.Equal(HttpStatusCode.Unauthorized, (await Call("example.other", "provider/introspect", new { token, kind = "speech-to-text" })).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Call("example.speech", "provider/introspect", new { token, kind = "assistant" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await Call("example.consumer", "providers/assistant")).StatusCode);
        // Revocation invalidates already-issued credentials; granting again does not resurrect them.
        var lifecycle = host.Services.GetRequiredService<CoreLifecycleService>();
        var review = await lifecycle.CreatePermissionPlanAsync("example.consumer", default);
        await lifecycle.ApplyOptionalPermissionsAsync(review, [], default);
        Assert.Equal(HttpStatusCode.Forbidden, (await Call("example.speech", "provider/introspect", new { token, kind = "speech-to-text" })).StatusCode);
        await apps.UpdateAppAsync("example.consumer", r => r with { GrantedCorePermissions = [CoreAppPermissions.SpeechProviders], PermissionRevision = "grant-3" });
        Assert.Equal(HttpStatusCode.Forbidden, (await Call("example.speech", "provider/introspect", new { token, kind = "speech-to-text" })).StatusCode);
    }

    [Fact]
    public async Task UnconfirmedRolesAndUnavailableProvidersCannotMintCredentials()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var access = host.Services.GetRequiredService<ProviderAccessService>();
        var caller = Record("example.consumer") with { GrantedCorePermissions = [CoreAppPermissions.SpeechProviders] };
        await apps.UpsertAppAsync(caller);
        var target = Speech("example.speech");
        await apps.UpsertAppAsync(target with { ConfirmedRoles = [] });
        Assert.Empty((await access.ListAsync(caller, "speech-to-text", default)).Providers);
        await Assert.ThrowsAsync<AppIdentityException>(() => access.IssueAsync(caller, "speech-to-text", new(target.Id), null, default));
        await apps.UpsertAppAsync(target with { RuntimeState = "stopped" });
        Assert.False(Assert.Single((await access.ListAsync(caller, "speech-to-text", default)).Providers).Available);
        await Assert.ThrowsAsync<AppIdentityException>(() => access.IssueAsync(caller, "speech-to-text", new(target.Id), null, default));
    }

    [Fact]
    public async Task ProviderReinstallationAndInvalidTokenFailClosed()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var access = host.Services.GetRequiredService<ProviderAccessService>();
        var caller = Record("example.consumer") with { GrantedCorePermissions = [CoreAppPermissions.SpeechProviders] };
        var target = Speech("example.speech");
        await apps.UpsertAppAsync(caller); await apps.UpsertAppAsync(target);
        var issued = await access.IssueAsync(caller, "speech-to-text", new(target.Id), null, default);
        await Assert.ThrowsAsync<AppIdentityException>(() => access.ValidateAsync(target with { InstalledAt = target.InstalledAt.AddSeconds(1) }, new(issued.Token, "speech-to-text"), default));
        await Assert.ThrowsAsync<AppIdentityException>(() => access.ValidateAsync(target, new(null!, "speech-to-text"), default));
        await Assert.ThrowsAsync<AppIdentityException>(() => access.ValidateAsync(target, new(issued.Token + "x", "speech-to-text"), default));
    }

    [Fact]
    public async Task AssistantRequiresActingUserAndRevalidatesBothAppAssignments()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var access = host.Services.GetRequiredService<ProviderAccessService>();
        var identity = host.Services.GetRequiredService<AppIdentityService>();
        var now = DateTimeOffset.UtcNow;
        var caller = Record("example.consumer") with { GrantedCorePermissions = [CoreAppPermissions.AssistantProviders] };
        var target = Speech("example.assistant") with { ConfirmedRoles = ["assistant"],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["assistant"] = [new("default", "api", "/api/assistant/v1", 1, [])] } };
        await apps.UpsertAppAsync(caller); await apps.UpsertAppAsync(target);
        var user = new HostUserRecord("member", "member@example.test", "Member", "host.user", false, now, now);
        var state = new UserDirectoryState(1, [user], [], [new(caller.Id, user.Id, now)], []);
        await users.WriteAsync(state);
        var credential = await BrowserAuthorityFixture.Grant(host, caller.Id, user.Id);
        state = await users.ReadAsync();
        await Assert.ThrowsAsync<AppIdentityException>(() => access.IssueAsync(caller, "assistant", new(target.Id), null, default));
        await Assert.ThrowsAsync<AppIdentityException>(() => access.IssueAsync(caller, "assistant", new(target.Id), credential.AccessToken, default));
        await users.WriteAsync(state with { Assignments = [new(caller.Id, user.Id, now), new(target.Id, user.Id, now)] });
        var issued = await access.IssueAsync(caller, "assistant", new(target.Id), credential.AccessToken, default);
        var invocation = await access.ValidateAsync(target, new(issued.Token, "assistant"), default);
        Assert.Equal(user.Id, invocation.UserId); Assert.Equal("host.user", invocation.HostRole);
        Assert.Equal(caller.InstalledAt.ToString("O"), invocation.CallerInstallation);
        await users.WriteAsync(state);
        await Assert.ThrowsAsync<AppIdentityException>(() => access.ValidateAsync(target, new(issued.Token, "assistant"), default));
    }

    private static AppRecord Speech(string id) => Record(id) with
    {
        RuntimeState = "running", ConfirmedRoles = ["speech-to-text"],
        Endpoints = [new("api", "http", "http://127.0.0.1:3456", true)],
        Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["speech-to-text"] = [new("default", "api", "/api/speech/v1", 1, [])] },
    };
    private static AppRecord Record(string id) => new(id, id, null, "0.1.0", "runtime", false, "installed", null, null,
        "local", "installed", "stopped", null, null, [], new Dictionary<string, AppSettingValue>(), [], [], [], DateTimeOffset.UtcNow, DateTimeOffset.UtcNow);
}
