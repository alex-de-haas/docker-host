using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Haas.Hosty.Core;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class ProviderHttpTests
{
    [Fact]
    public async Task NamedCatalogRequiresExactPublisherAndSupportsQualifiedReplaySafeInvocations()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var tokens = host.Services.GetRequiredService<AppServiceTokenService>();
        var caller = Record("independent.consumer") with { GrantedCorePermissions = [CoreAppPermissions.TranslationProviders] };
        var publisher = Speech("independent.linguist") with { DisplayName = "Linguist", ConfirmedRoles = ["translation"],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> {
                ["translation"] = [new("local", "api", "/local", 1, []),
                    new("accounts", "api", "/dynamic", 1, [NamedProviderImplementations.Capability])] }
        };
        using var consumer = host.CreateClient();
        consumer.DefaultRequestHeaders.Authorization = new("Bearer", tokens.CreateToken(caller.Id));
        using var supplier = host.CreateClient();
        supplier.DefaultRequestHeaders.Authorization = new("Bearer", tokens.CreateRuntimeToken(publisher));
        var list = $"/api/internal/apps/{caller.Id}/providers/translation";
        var publish = $"/api/internal/apps/{publisher.Id}/providers/translation/implementations";
        var introspect = $"/api/internal/apps/{publisher.Id}/provider/introspect";
        Task<HttpResponseMessage> Publish(long revision, params ProviderImplementation[] entries)
            => supplier.PostAsJsonAsync(publish, new ProviderImplementationPublication("accounts", revision, entries));
        Task<HttpResponseMessage> Issue(string id) => consumer.PostAsJsonAsync(list + "/token",
            new ProviderTokenRequest(publisher.Id, "accounts", PanelIdentity.Installation(publisher), id));
        Task<HttpResponseMessage> Validate(string token) => supplier.PostAsJsonAsync(introspect, new { token, kind = "translation", key = "accounts" });
        await apps.UpsertAppAsync(caller);
        Assert.Empty((await consumer.GetFromJsonAsync<JsonElement>(list + "?named=true")).GetProperty("providers").EnumerateArray());
        await apps.UpsertAppAsync(publisher);
        var alpha = new ProviderImplementation("provider-owned:A", "Business", true);
        var beta = new ProviderImplementation("provider-owned:B", "Business", false);
        var body = new ProviderImplementationPublication("accounts", 1, [alpha, beta]);
        Assert.Equal(HttpStatusCode.Unauthorized, (await consumer.PostAsJsonAsync(publish, body)).StatusCode);
        using var legacyPublisher = host.CreateClient();
        legacyPublisher.DefaultRequestHeaders.Authorization = new("Bearer", tokens.CreateToken(publisher.Id));
        Assert.Equal(HttpStatusCode.Forbidden, (await legacyPublisher.PostAsJsonAsync(publish, body)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await supplier.PostAsJsonAsync(publish, body with { Key = "local" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Publish(1, alpha, alpha)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Publish(1, alpha, beta)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Publish(1, beta, alpha)).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await Publish(1, beta)).StatusCode);
        var visible = (await consumer.GetFromJsonAsync<JsonElement>(list + "?named=true")).GetProperty("providers").EnumerateArray().ToArray();
        Assert.Equal(3, visible.Length);
        var named = visible.Where(p => p.GetProperty("key").GetString() == "accounts").ToArray();
        Assert.Equal(2, named.Length);
        Assert.All(named, p => Assert.Equal("Business", p.GetProperty("implementationName").GetString()));
        Assert.NotEqual(named[0].GetProperty("displayName").GetString(), named[1].GetProperty("displayName").GetString());
        var legacy = Assert.Single((await consumer.GetFromJsonAsync<JsonElement>(list)).GetProperty("providers").EnumerateArray());
        Assert.Equal("local", legacy.GetProperty("key").GetString());
        Assert.Equal(HttpStatusCode.OK, (await consumer.PostAsJsonAsync(list + "/token", new ProviderTokenRequest(publisher.Id, "local"))).StatusCode);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await consumer.PostAsJsonAsync(list + "/token", new ProviderTokenRequest(publisher.Id, "accounts"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await consumer.PostAsJsonAsync(list + "/token",
            new ProviderTokenRequest(publisher.Id, "accounts", "stale-install", alpha.Id))).StatusCode);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await Issue(beta.Id)).StatusCode);
        var issued = await Issue(alpha.Id);
        issued.EnsureSuccessStatusCode();
        var token = (await issued.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("token").GetString()!;
        var verification = await Validate(token); verification.EnsureSuccessStatusCode();
        Assert.Equal(alpha.Id, (await verification.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("implementationId").GetString());

        Assert.Equal(HttpStatusCode.OK, (await Publish(2, alpha with { DisplayName = "Renamed" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Validate(token)).StatusCode);
        var freshRegistry = new AppRegistryStore(host.Services.GetRequiredService<CoreDataPaths>());
        var reloaded = (await freshRegistry.GetAppAsync(publisher.Id))!;
        Assert.Equal("Renamed", ProviderAccessService.Find(reloaded, "translation", "accounts", alpha.Id)!.ImplementationName);
        Assert.Equal("provider_publication_conflict", (await Assert.ThrowsAsync<AppIdentityException>(() =>
            freshRegistry.PublishImplementationsAsync(reloaded, "translation", body, default))).Code);
        Assert.Equal(HttpStatusCode.OK, (await Publish(3)).StatusCode);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await Validate(token)).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await Publish(2, alpha)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Publish(4, alpha)).StatusCode);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await Validate(token)).StatusCode);
        await apps.UpdateAppAsync(caller.Id, current => current with { GrantedCorePermissions = [] });
        Assert.Equal(HttpStatusCode.Forbidden, (await Issue(alpha.Id)).StatusCode);
        await apps.UpdateAppAsync(publisher.Id, current => current with { ConfirmedRoles = [] });
        Assert.Equal(HttpStatusCode.Forbidden, (await Publish(5, alpha)).StatusCode);

        var replacement = publisher with { InstalledAt = publisher.InstalledAt.AddMinutes(1) };
        await apps.UpsertAppAsync(replacement);
        Assert.Null(ProviderAccessService.Find((await apps.GetAppAsync(publisher.Id))!, "translation", "accounts", alpha.Id));
        Assert.Equal(HttpStatusCode.Forbidden, (await Publish(5, alpha)).StatusCode);
        supplier.DefaultRequestHeaders.Authorization = new("Bearer", tokens.CreateRuntimeToken(replacement));
        Assert.Equal(HttpStatusCode.OK, (await Publish(1, beta)).StatusCode);
    }

    [Theory]
    [InlineData("http")]
    [InlineData(null)]
    public async Task NamedEntryRequiresAnUnambiguousEndpointAtPublicationAndUse(string? endpoint)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        const string kind = "speech-to-text";
        var provider = Speech("independent.multiservice");
        var first = new AppEndpointContract("one.http", "http", "http://one.invalid", true);
        var second = new AppEndpointContract("two.http", "http", "http://two.invalid", true);
        AppRecord WithEndpoints(string? key, params AppEndpointContract[] endpoints) => provider with
        {
            Endpoints = endpoints,
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>>
            {
                [kind] = [new("static", key, "/static", 1, []), new("named", key, "/speech", 1, [NamedProviderImplementations.Capability])]
            }
        };
        var original = WithEndpoints(endpoint, first);
        await apps.UpsertAppAsync(original);
        var snapshot = new ProviderImplementationPublication("named", 1, [new("account", "Account", true)]);
        await apps.PublishImplementationsAsync(original, kind, snapshot, default);
        var single = ProviderAccessService.Find((await apps.GetAppAsync(provider.Id))!, kind, "named", "account");
        Assert.Equal("http://one.invalid/speech", single!.Url);

        var ambiguous = WithEndpoints(endpoint, first, second);
        await apps.UpsertAppAsync(ambiguous);
        var current = (await apps.GetAppAsync(provider.Id))!;
        var blocked = ProviderAccessService.Find(current, kind, "named", "account");
        Assert.False(blocked!.Available);
        Assert.Null(blocked.Url);
        Assert.Equal("http://one.invalid/static", ProviderAccessService.Find(current, kind, "static", null)!.Url);
        Assert.Equal("provider_publication_denied", (await Assert.ThrowsAsync<AppIdentityException>(() =>
            apps.PublishImplementationsAsync(current, kind, snapshot, default))).Code);

        var qualified = WithEndpoints("two.http", first, second);
        await apps.UpsertAppAsync(qualified);
        await apps.PublishImplementationsAsync(qualified, kind, snapshot, default);
        var selected = ProviderAccessService.Find((await apps.GetAppAsync(provider.Id))!, kind, "named", "account");
        Assert.True(selected!.Available);
        Assert.Equal("http://two.invalid/speech", selected.Url);
    }

    [Fact]
    public async Task ChangedDeclarationRequiresRepublishingAndDamagedCatalogPreservesStaticDiscovery()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var tokens = host.Services.GetRequiredService<AppServiceTokenService>();
        var provider = Speech("independent.reader");
        var oldEntry = provider.Interfaces!["speech-to-text"][0] with { Key = "dynamic", Capabilities = [NamedProviderImplementations.Capability] };
        AppRecord WithEntry(AppInterfaceContract entry) => provider with { Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>>
            { ["speech-to-text"] = [provider.Interfaces!["speech-to-text"][0], entry] } };
        var original = WithEntry(oldEntry);
        await apps.UpsertAppAsync(original);
        using var supplier = host.CreateClient();
        supplier.DefaultRequestHeaders.Authorization = new("Bearer", tokens.CreateRuntimeToken(original));
        var endpoint = $"/api/internal/apps/{provider.Id}/providers/speech-to-text/implementations";
        var publication = new ProviderImplementationPublication("dynamic", 1, [new("channel", "Channel", true)]);
        Assert.Equal(HttpStatusCode.OK, (await supplier.PostAsJsonAsync(endpoint, publication)).StatusCode);
        var first = ProviderAccessService.Find((await apps.GetAppAsync(provider.Id))!, "speech-to-text", "dynamic", "channel");
        Assert.NotNull(first);

        var updated = WithEntry(oldEntry with { Path = "/revised" });
        await apps.UpsertAppAsync(updated);
        Assert.Null(ProviderAccessService.Find((await apps.GetAppAsync(provider.Id))!, "speech-to-text", "dynamic", "channel"));
        Assert.Equal(HttpStatusCode.Forbidden, (await supplier.PostAsJsonAsync(endpoint, publication)).StatusCode);
        supplier.DefaultRequestHeaders.Authorization = new("Bearer", tokens.CreateRuntimeToken(updated));
        Assert.Equal(HttpStatusCode.OK, (await supplier.PostAsJsonAsync(endpoint, publication)).StatusCode);
        var rebound = ProviderAccessService.Find((await apps.GetAppAsync(provider.Id))!, "speech-to-text", "dynamic", "channel");
        Assert.NotNull(rebound);
        Assert.EndsWith("/revised", rebound.Url);
        Assert.NotEqual(first.Incarnation, rebound.Incarnation);

        var paths = host.Services.GetRequiredService<CoreDataPaths>();
        var catalogPath = Path.Combine(paths.AppsRoot, provider.Id, NamedProviderImplementations.FileName);
        var damaged = JsonSerializer.Serialize(new { installationId = PanelIdentity.Installation(provider), snapshots = new object?[] { null } });
        await File.WriteAllTextAsync(catalogPath, damaged);
        var fresh = new AppRegistryStore(paths);
        var loaded = (await fresh.GetAppAsync(provider.Id))!;
        Assert.Equal("default", Assert.Single(ProviderAccessService.Describe(loaded, "speech-to-text", true)).Key);
        Assert.Equal("provider_catalog_unavailable", (await Assert.ThrowsAsync<AppIdentityException>(() =>
            fresh.PublishImplementationsAsync(loaded, "speech-to-text", publication, default))).Code);
        Assert.Equal(damaged, await File.ReadAllTextAsync(catalogPath));
    }

    [Theory]
    [InlineData("text-to-speech", CoreAppPermissions.TextToSpeechProviders)]
    [InlineData("tasks", CoreAppPermissions.TaskProviders)]
    [InlineData("task-executor", CoreAppPermissions.TaskExecutors)]
    public async Task TaskCategoriesAreIndependentConfirmedAndInstallationBound(string kind, string permission)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var access = host.Services.GetRequiredService<ProviderAccessService>();
        var caller = Record("unrelated.producer") with { GrantedCorePermissions = [permission] };
        await apps.UpsertAppAsync(caller);
        Assert.Empty((await access.ListAsync(caller, kind, default)).Providers);
        var target = Speech("independent.supplier") with {
            ConfirmedRoles = [kind],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> {
                [kind] = [new("plain", "api", "/v1", 1, ["markdown"])] }
        };
        await apps.UpsertAppAsync(target with { ConfirmedRoles = [] });
        Assert.Empty((await access.ListAsync(caller, kind, default)).Providers);
        await apps.UpsertAppAsync(target);
        var descriptor = Assert.Single((await access.ListAsync(caller, kind, default)).Providers);
        Assert.Equal(target.InstalledAt.ToString("O"), descriptor.InstallationId);
        var issued = await access.IssueAsync(caller, kind, new(target.Id, "plain"), null, default);
        var invocation = await access.ValidateAsync(target, new(issued.Token, kind, "plain"), default);
        Assert.Equal(caller.Id, invocation.CallerAppId);
        Assert.Null(invocation.UserId);
        await Assert.ThrowsAsync<AppIdentityException>(() => access.ValidateAsync(target, new(issued.Token, kind == "tasks" ? "task-executor" : "tasks", "plain"), default));
        await Assert.ThrowsAsync<AppIdentityException>(() => access.ValidateAsync(target with { InstalledAt = target.InstalledAt.AddSeconds(1) }, new(issued.Token, kind, "plain"), default));
        await apps.UpsertAppAsync(caller with { GrantedCorePermissions = [], PermissionRevision = "revoked" });
        await Assert.ThrowsAsync<AppIdentityException>(() => access.ValidateAsync(target, new(issued.Token, kind, "plain"), default));
        Assert.Contains(kind, PlatformCapabilities.RequestedRoles([kind]));
    }

    [Fact]
    public async Task TranslationSupportsTwoStaticKeysWithScopedAuthorityAndLiveRevocation()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var access = host.Services.GetRequiredService<ProviderAccessService>();
        var caller = Record("example.consumer") with { GrantedCorePermissions = [CoreAppPermissions.TranslationProviders] };
        var target = Speech("example.translation") with {
            ConfirmedRoles = ["translation"],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> {
                ["translation"] = [new("codex", "api", "/api/translation/v1/codex", 1, ["text"]),
                    new("claude", "api", "/api/translation/v1/claude", 1, ["text"])] }
        };
        await apps.UpsertAppAsync(caller);
        await apps.UpsertAppAsync(target with { ConfirmedRoles = [] });
        Assert.Empty((await access.ListAsync(caller, "translation", default)).Providers);
        await apps.UpsertAppAsync(target);
        Assert.Equal(["codex", "claude"], (await access.ListAsync(caller, "translation", default)).Providers.Select(p => p.Key));
        await Assert.ThrowsAsync<AppIdentityException>(() => access.ListAsync(caller with { GrantedCorePermissions = [] }, "translation", default));
        var issued = await access.IssueAsync(caller, "translation", new(target.Id, "codex"), null, default);
        var invocation = await access.ValidateAsync(target, new(issued.Token, "translation", "codex"), default);
        Assert.Null(invocation.UserId);
        await Assert.ThrowsAsync<AppIdentityException>(() => access.ValidateAsync(target, new(issued.Token, "translation", "claude"), default));
        await Assert.ThrowsAsync<AppIdentityException>(() => access.ValidateAsync(target, new(issued.Token, "assistant", "codex"), default));
        await apps.UpsertAppAsync(caller with { GrantedCorePermissions = [], PermissionRevision = "revoked" });
        await Assert.ThrowsAsync<AppIdentityException>(() => access.ValidateAsync(target, new(issued.Token, "translation", "codex"), default));
        Assert.Contains("translation", PlatformCapabilities.RequestedRoles(["translation"]));
        Assert.Contains(CoreAppPermissions.TranslationProviders, CoreAppPermissions.ResolveGrants([], [CoreAppPermissions.TranslationProviders], [CoreAppPermissions.TranslationProviders]));
    }

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
        Assert.Equal("panel", panel.GetProperty("kind").GetString());
        Assert.StartsWith("legacy-", panel.GetProperty("panelId").GetString());
        Assert.Equal(target.InstalledAt.ToString("O"), provider.GetProperty("installationId").GetString());
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
        Assert.True(body.GetProperty("reviewAvailable").GetBoolean());
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
