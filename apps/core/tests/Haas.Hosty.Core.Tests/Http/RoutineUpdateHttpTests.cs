using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class RoutineUpdateHttpTests
{
    [Theory]
    [InlineData("routine")]
    [InlineData("required")]
    [InlineData("optional")]
    [InlineData("command")]
    [InlineData("revoked")]
    public async Task AppUpdate_OnlyRoutineChangesApplyWithoutConfirmation(string change)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await AppManagementHttpTests.CreateAppClient(host, "example.market", [CoreAppPermissions.Install]);
        var lifecycle = host.Services.GetRequiredService<CoreLifecycleService>();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var path = Path.Combine(host.Services.GetRequiredService<CoreDataPaths>().DataRoot, "update-target.json");
        var required = change == "revoked" ? "\"apps.read\"" : "";
        var manifest = $$$$"""
            {"schemaVersion":"app.0.1","id":"example.target","name":"Target","version":"1.0.0",
             "corePermissions":[{{{{required}}}}],"optionalCorePermissions":[],
             "runtimeProfiles":[{"key":"dev","type":"localCommand","default":true}],"defaultRuntime":"dev",
             "services":[{"key":"app","runtimes":{"dev":{"type":"localCommand","command":"echo unused","workingDirectory":"."}}}]}
            """;
        await File.WriteAllTextAsync(path, manifest);
        await lifecycle.InstallAsync(new(path, Autostart: false));
        if (change == "revoked")
            await apps.UpdateAppAsync("example.target", app => app with { GrantedCorePermissions = [] });
        var target = manifest.Replace("1.0.0", "1.0.1");
        target = change switch
        {
            "required" => target.Replace("\"corePermissions\":[]", "\"corePermissions\":[\"apps.read\"]"),
            "optional" => target.Replace("\"optionalCorePermissions\":[]", "\"optionalCorePermissions\":[\"apps.read\"]"),
            "command" => target.Replace("echo unused", "echo changed"),
            _ => target,
        };
        await File.WriteAllTextAsync(path, target);
        var plan = await lifecycle.CreateUpdatePlanAsync("example.target", new(path));
        using var response = await client.PostAsJsonAsync("/api/apps/example.target/update", new { planDigest = plan.PlanDigest });
        if (change is "required" or "optional" or "command")
        {
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Equal("approval_required", (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
            Assert.Equal("1.0.0", (await apps.GetAppAsync("example.target"))!.Version);
        }
        else
        {
            response.EnsureSuccessStatusCode();
            Assert.Equal("updating", (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("status").GetString());
            if (lifecycle.TryGetRunningBackgroundUpdate("example.target") is { } run) await run;
            var updated = (await apps.GetAppAsync("example.target"))!;
            Assert.Equal("1.0.1", updated.Version);
            Assert.Empty(updated.GrantedCorePermissions!);
        }
    }

    [Theory]
    [InlineData("runtime", "runtime:")]
    [InlineData("development", "development:")]
    [InlineData("system", "role:runtime->system")]
    [InlineData("service", "service:")]
    [InlineData("command", "command:")]
    [InlineData("working-directory", "workingDirectory:")]
    [InlineData("setting", "setting:")]
    [InlineData("required-permission", "Core permission added:")]
    [InlineData("optional-permission", "Optional permission added:")]
    [InlineData("mount", "mount:")]
    [InlineData("dependency", "dependency:")]
    [InlineData("endpoint", "endpoint:")]
    [InlineData("data", "data:")]
    [InlineData("capability", "capability:")]
    [InlineData("environment", "environment:")]
    [InlineData("port", "port:")]
    [InlineData("network", "network:")]
    [InlineData("container-capability", "capabilities:")]
    [InlineData("device", "devices:")]
    [InlineData("image-repository", "image:")]
    [InlineData("artifact-unknown", "artifact:")]
    public async Task CoreSessionQueuedUpdate_RefusesEveryReviewCategoryBeforeQueueOrMutation(string change, string expectedChange)
    {
        var imageResolver = new ProbeOnlyAdapter("docker");
        await using var host = await ReviewHostAsync(imageResolver);
        using var client = await CoreBrowserAsync(host);
        var lifecycle = host.Services.GetRequiredService<CoreLifecycleService>();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var paths = host.Services.GetRequiredService<CoreDataPaths>();
        var path = Path.Combine(paths.DataRoot, "core-session-review.json");
        var manifest = ReviewManifest();
        var docker = change is "network" or "container-capability" or "device" or "image-repository" or "artifact-unknown";
        var runtime = docker ? "docker" : "first";
        await File.WriteAllTextAsync(path, manifest.ToJsonString());
        await lifecycle.InstallAsync(new(path, runtime, Autostart: false));
        if (change == "artifact-unknown")
        {
            await apps.UpdateAppAsync("example.review-target", app => app with
            {
                ArtifactLocks = new Dictionary<string, ArtifactLock>
                { ["app"] = new("image", imageResolver.Digest, "ghcr.io/example/target:1", null, null, DateTimeOffset.UtcNow) },
            });
            imageResolver.Digest = null;
        }
        manifest["version"] = "1.0.1";
        var service = manifest["services"]![0]!.AsObject();
        var selected = service["runtimes"]![runtime]!.AsObject();
        switch (change)
        {
            case "runtime": runtime = "second"; break;
            case "development": manifest["runtimeProfiles"]![0]!["development"] = true; break;
            case "system": manifest["role"] = "system"; break;
            case "service":
                var worker = service.DeepClone().AsObject(); worker["key"] = "worker";
                manifest["services"]!.AsArray().Add(worker); break;
            case "command": selected["command"] = "echo reviewed"; break;
            case "working-directory": selected["workingDirectory"] = "child"; break;
            case "setting": manifest["settings"] = JsonNode.Parse("""[{"key":"NEW_MODE","type":"string","default":"local"}]"""); break;
            case "required-permission": manifest["corePermissions"] = new JsonArray("apps.read"); break;
            case "optional-permission": manifest["optionalCorePermissions"] = new JsonArray("apps.read"); break;
            case "mount": manifest["externalMounts"] = JsonNode.Parse("""{"files":{"mode":"ro","service":"app"}}"""); break;
            case "dependency": manifest["dependencies"] = JsonNode.Parse("""[{"id":"example.provider","version":"1","required":false}]"""); break;
            case "endpoint": manifest["endpoints"] = JsonNode.Parse("""[{"key":"web","service":"app","port":"http","protocol":"http","public":false}]"""); break;
            case "data": manifest["data"] = JsonNode.Parse("""{"enabled":true,"targets":[{"runtime":"first","service":"app","environment":"HOSTY_APP_DATA_DIR"}]}"""); break;
            case "capability": manifest["capabilities"] = new JsonArray("logs"); break;
            case "environment": selected["environment"] = JsonNode.Parse("""{"APP_MODE":"preview"}"""); break;
            case "port": selected["ports"]![0]!["containerPort"] = 3001; break;
            case "network": selected["network"] = "host"; break;
            case "container-capability": selected["capabilities"] = new JsonArray("NET_ADMIN"); break;
            case "device": selected["devices"] = new JsonArray("/dev/dri"); break;
            case "image-repository": selected["image"] = "ghcr.io/different/target:1"; break;
        }
        await File.WriteAllTextAsync(path, manifest.ToJsonString());
        var plan = await lifecycle.CreateUpdatePlanAsync("example.review-target", new(path, runtime));
        Assert.True(plan.RequiresReview);
        Assert.Contains(plan.Changes, entry => entry.StartsWith(expectedChange, StringComparison.Ordinal));
        var before = CoreJson.Text((await apps.GetAppAsync(plan.AppId))!);
        using var refused = await client.PostAsJsonAsync($"/api/apps/{plan.AppId}/update", new
        { planDigest = plan.PlanDigest, requiresReview = false });
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        Assert.Equal("approval_required", (await refused.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        Assert.Equal(before, CoreJson.Text((await apps.GetAppAsync(plan.AppId))!));
        Assert.Null(lifecycle.TryGetRunningBackgroundUpdate(plan.AppId));
        Assert.Equal(plan.PlanDigest, (await lifecycle.GetReviewedUpdatePlanAsync(plan.AppId, plan.PlanDigest)).PlanDigest);
        Assert.Equal(0, imageResolver.RuntimeOperations);
    }

    [Fact]
    public async Task CoreSessionQueuedRoutineUpdate_CompletesAndPreservesRevokedGrants()
    {
        await using var host = await ReviewHostAsync(new ProbeOnlyAdapter("docker"));
        using var client = await CoreBrowserAsync(host);
        var lifecycle = host.Services.GetRequiredService<CoreLifecycleService>();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var path = Path.Combine(host.Services.GetRequiredService<CoreDataPaths>().DataRoot, "core-routine.json");
        var manifest = ReviewManifest();
        manifest["corePermissions"] = new JsonArray("apps.read");
        await File.WriteAllTextAsync(path, manifest.ToJsonString());
        await lifecycle.InstallAsync(new(path, "first", Autostart: false));
        await apps.UpdateAppAsync("example.review-target", app => app with { GrantedCorePermissions = [] });
        manifest["version"] = "1.0.1";
        await File.WriteAllTextAsync(path, manifest.ToJsonString());
        var plan = await lifecycle.CreateUpdatePlanAsync("example.review-target", new(path));
        Assert.False(plan.RequiresReview);
        using var accepted = await client.PostAsJsonAsync($"/api/apps/{plan.AppId}/update", new { planDigest = plan.PlanDigest });
        accepted.EnsureSuccessStatusCode();
        Assert.Equal("updating", (await accepted.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("status").GetString());
        if (lifecycle.TryGetRunningBackgroundUpdate(plan.AppId) is { } run) await run;
        var updated = (await apps.GetAppAsync(plan.AppId))!;
        Assert.Equal("1.0.1", updated.Version);
        Assert.Empty(updated.GrantedCorePermissions!);
        Assert.Null(updated.LastError);
    }

    [Theory]
    [InlineData("confirmation")]
    [InlineData("control")]
    public async Task ReviewedCommandUpdate_RemainsAvailableThroughConfirmedOrSynchronousControlApply(string route)
    {
        await using var host = await ReviewHostAsync(new ProbeOnlyAdapter("docker"));
        using var client = await CoreBrowserAsync(host);
        var lifecycle = host.Services.GetRequiredService<CoreLifecycleService>();
        var path = Path.Combine(host.Services.GetRequiredService<CoreDataPaths>().DataRoot, "approved-review.json");
        var manifest = ReviewManifest();
        await File.WriteAllTextAsync(path, manifest.ToJsonString());
        await lifecycle.InstallAsync(new(path, "first", Autostart: false));
        manifest["version"] = "1.0.1";
        manifest["services"]![0]!["runtimes"]!["first"]!["command"] = "echo reviewed";
        await File.WriteAllTextAsync(path, manifest.ToJsonString());
        var plan = await lifecycle.CreateUpdatePlanAsync("example.review-target", new(path));
        Assert.True(plan.RequiresReview);
        using var refused = await client.PostAsJsonAsync($"/api/apps/{plan.AppId}/update", new { planDigest = plan.PlanDigest });
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        if (route == "control")
        {
            using var control = host.CreateClient();
            control.DefaultRequestHeaders.Add("X-Hosty-Control-Secret", host.Services.GetRequiredService<ControlSecret>().Value);
            using var applied = await control.PostAsJsonAsync($"/control/v1/apps/{plan.AppId}/update", new { planDigest = plan.PlanDigest });
            applied.EnsureSuccessStatusCode();
            Assert.Equal("updated", (await applied.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("status").GetString());
        }
        else
        {
            using var prepared = await client.PostAsJsonAsync("/api/installations", new { updateAppId = plan.AppId, planDigest = plan.PlanDigest });
            prepared.EnsureSuccessStatusCode();
            var id = (await prepared.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
            using var submitted = await client.PostAsJsonAsync($"/api/installations/{id}/submit", new { });
            submitted.EnsureSuccessStatusCode();
            var html = await client.GetStringAsync($"/install/confirm/{id}");
            var nonce = Regex.Match(html, "name=nonce value=\"([^\"]+)\"").Groups[1].Value;
            Assert.NotEmpty(nonce);
            using var request = new HttpRequestMessage(HttpMethod.Post, $"/install/confirm/{id}")
            {
                Content = new FormUrlEncodedContent(new Dictionary<string, string> { ["nonce"] = nonce, ["decision"] = "approve" }),
                Headers = { { "Origin", "http://localhost" } },
            };
            using var approved = await client.SendAsync(request);
            approved.EnsureSuccessStatusCode();
            var store = host.Services.GetRequiredService<InstallationApprovalStore>();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while (store.Get(id).Status == "executing") await Task.Delay(10, timeout.Token);
            Assert.Equal("succeeded", store.Get(id).Status);
        }
        var installed = (await host.Services.GetRequiredService<AppRegistryStore>().GetAppAsync(plan.AppId))!;
        Assert.Equal("1.0.1", installed.Version);
        var saved = JsonNode.Parse(await File.ReadAllTextAsync(installed.ManifestPath!))!;
        Assert.Equal("echo reviewed", saved["services"]![0]!["runtimes"]!["first"]!["command"]!.GetValue<string>());
        Assert.Null(lifecycle.TryGetRunningBackgroundUpdate(plan.AppId));
    }

    private static Task<CoreHttpHarness> ReviewHostAsync(ProbeOnlyAdapter imageResolver)
        => CoreHttpHarness.StartAsync(configure: services =>
        {
            services.RemoveAll<IAppRuntimeAdapter>();
            services.AddSingleton<IAppRuntimeAdapter>(imageResolver);
            services.AddSingleton<IAppRuntimeAdapter>(new ProbeOnlyAdapter("localCommand"));
        });

    private static async Task<HttpClient> CoreBrowserAsync(CoreHttpHarness host)
    {
        var now = DateTimeOffset.UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
            [new("admin", "admin@example.test", "Admin", "host.admin", false, now, now)], [], [],
            [new("core-browser", "admin", now, now.AddHours(1), null, now, BrowserOrigin: "http://localhost")]));
        var client = host.CreateClient();
        client.DefaultRequestHeaders.Add("Cookie", "hosty_session=core-browser; hosty_csrf=review-csrf");
        client.DefaultRequestHeaders.Add(CoreSessionAuthorization.CsrfHeaderName, "review-csrf");
        return client;
    }

    private static JsonObject ReviewManifest() => JsonNode.Parse("""
        {"schemaVersion":"app.0.1","id":"example.review-target","name":"Review target","version":"1.0.0",
         "corePermissions":[],"optionalCorePermissions":[],"settings":[],"capabilities":[],"defaultRuntime":"first",
         "runtimeProfiles":[{"key":"first","type":"localCommand","default":true},{"key":"second","type":"localCommand"},{"key":"docker","type":"docker"}],
         "services":[{"key":"app","runtimes":{
           "first":{"type":"localCommand","command":"echo first","workingDirectory":".","ports":[{"key":"http","containerPort":3000,"protocol":"http","public":false}]},
           "second":{"type":"localCommand","command":"echo second","workingDirectory":".","ports":[{"key":"http","containerPort":3000,"protocol":"http","public":false}]},
           "docker":{"type":"docker","image":"ghcr.io/example/target:1","ports":[{"key":"http","containerPort":3000,"protocol":"http","public":false}]}}}]}
        """)!.AsObject();

    private sealed class ProbeOnlyAdapter(string type) : IAppRuntimeAdapter, IImageDigestResolver
    {
        public string Type => type;
        internal string? Digest { get; set; } = "sha256:" + new string('a', 64);
        internal int RuntimeOperations { get; private set; }
        public Task<string?> ResolveRemoteDigestAsync(RuntimeDockerImage image, CancellationToken cancellationToken = default) => Task.FromResult(Digest);
        public Task<AppRuntimeStartResult> StartAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
        { RuntimeOperations++; throw new InvalidOperationException("No runtime launch is expected in these stopped-app HTTP tests."); }
        public Task<AppRuntimeOperationResult> StopAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
        { RuntimeOperations++; return Task.FromResult(new AppRuntimeOperationResult("stopped")); }
        public Task<AppRuntimeOperationResult> RemoveAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
        { RuntimeOperations++; return Task.FromResult(new AppRuntimeOperationResult("removed")); }
        public Task<AppRuntimeLogsResult> GetLogsAsync(RuntimeLifecycleContext context, int tail, CancellationToken cancellationToken = default) => Task.FromResult(new AppRuntimeLogsResult(""));
        public Task<AppRuntimeHealthResult> GetHealthAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default) => Task.FromResult(new AppRuntimeHealthResult("stopped", []));
    }
}
