using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class RemovalApprovalHttpTests
{
    private const string Target = "example.target";
    private const string Caller = "example.market";
    private const string Internal = "/api/internal/apps/example.market/installations";

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DirectAppRemoval_IsForbidden_RegardlessOfCleanupFlags(bool destructive)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var app = await Setup(host);
        using var response = await app.PostAsJsonAsync($"/api/apps/{Target}/remove", Options(destructive));
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Contains("app_operation_forbidden", await response.Content.ReadAsStringAsync());
        await AssertIntact(host);
    }

    [Theory]
    [InlineData(Internal, false)]
    [InlineData(Internal, true)]
    [InlineData("/api/installations", true)]
    public async Task Removal_RequiresCoreDecision_AndUsesOnlyFrozenOptions(string route, bool destructive)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var app = await Setup(host);
        var id = await Prepare(app, route, destructive);
        // Neither the submit JSON nor decision form may replace the reviewed target or flags.
        (await app.PostAsJsonAsync($"{route}/{id}/submit", new {
            removeAppId = Caller, removalOptions = Options(!destructive), deleteData = !destructive,
        })).EnsureSuccessStatusCode();
        await AssertIntact(host);
        using var browser = Browser(host);
        var html = await browser.GetStringAsync($"/install/confirm/{id}");
        Assert.Contains("Confirm app removal", html);
        Assert.Contains(Target, html);
        Assert.Contains("&lt;Target&gt;", html);
        Assert.DoesNotContain("<Target>", html);
        Assert.Contains("Backups: " + (destructive ? "delete permanently" : "keep"), html);
        Assert.Contains("Managed source checkout: " + (destructive ? "delete permanently" : "keep"), html);
        Assert.Contains("App data, cache, stored secrets and retained configuration: " + (destructive ? "delete permanently" : "keep"), html);
        Assert.Contains("Runtime state: delete", html);
        Assert.Contains("Runtime errors: stop removal", html);
        var nonce = Nonce(html);
        using var wrongOrigin = await Decide(browser, id, nonce, "approve", "http://market.example");
        Assert.Equal(HttpStatusCode.Forbidden, wrongOrigin.StatusCode);
        using var wrongNonce = await Decide(browser, id, "invalid", "approve");
        Assert.False(wrongNonce.IsSuccessStatusCode);
        await AssertIntact(host);
        using var accepted = await Decide(browser, id, nonce, "approve");
        accepted.EnsureSuccessStatusCode();
        Assert.Equal("succeeded", await Wait(host, id));
        Assert.Null(await Apps(host).GetAppAsync(Target));
        Assert.NotNull(await Apps(host).GetAppAsync(Caller));
        foreach (var file in DataFiles(host)) Assert.Equal(!destructive, File.Exists(file));
        using var replay = await Decide(browser, id, nonce, "approve");
        Assert.Equal(HttpStatusCode.Conflict, replay.StatusCode);
    }

    [Theory]
    [InlineData("deny")]
    [InlineData("reinstall")]
    [InlineData("missing")]
    [InlineData("grant-revoked")]
    [InlineData("session-revoked")]
    public async Task DeniedOrStaleRequest_CannotDeleteData(string change)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var app = await Setup(host);
        var id = await Prepare(app, Internal, true);
        (await app.PostAsJsonAsync($"{Internal}/{id}/submit", new { })).EnsureSuccessStatusCode();
        using var browser = Browser(host);
        var nonce = Nonce(await browser.GetStringAsync($"/install/confirm/{id}"));
        if (change == "reinstall")
            await Apps(host).UpsertAppAsync((await Apps(host).GetAppAsync(Target))! with { InstalledAt = DateTimeOffset.UtcNow.AddDays(1) });
        if (change == "missing")
            File.Delete(Path.Combine(host.Services.GetRequiredService<CoreDataPaths>().AppsRoot, Target, "state.json"));
        if (change == "grant-revoked")
            await Apps(host).UpsertAppAsync((await Apps(host).GetAppAsync(Caller))! with { GrantedCorePermissions = [] });
        if (change == "session-revoked")
            await host.Services.GetRequiredService<AppSessionGrantStore>().RevokeByAuthorizingSessionAsync("operator", DateTimeOffset.UtcNow);
        using var decision = await Decide(browser, id, nonce, change == "deny" ? "deny" : "approve");
        decision.EnsureSuccessStatusCode();
        Assert.Equal(change == "deny" ? "denied" : "failed", await Wait(host, id));
        foreach (var file in DataFiles(host)) Assert.True(File.Exists(file), file);
        if (change != "missing") Assert.NotNull(await Apps(host).GetAppAsync(Target));
    }

    [Fact]
    public async Task Preparation_RequiresInstallPermission_ExistingTarget_AndSingleOperation()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var app = await Setup(host);
        using var combined = await app.PostAsJsonAsync(Internal, new { removeAppId = Target, updateAppId = Caller });
        Assert.Contains("removal_request_invalid", await combined.Content.ReadAsStringAsync());
        using var missing = await app.PostAsJsonAsync(Internal, new { removeAppId = "absent.app" });
        Assert.False(missing.IsSuccessStatusCode);
        await Apps(host).UpsertAppAsync((await Apps(host).GetAppAsync(Caller))! with { GrantedCorePermissions = [] });
        using var forbidden = await app.PostAsJsonAsync(Internal, new { removeAppId = Target });
        Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);
        await AssertIntact(host);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task TrustedOperator_CanStillRemoveDirectly(bool control)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var app = await Setup(host);
        using var client = host.CreateClient();
        if (control) client.DefaultRequestHeaders.Add("X-Hosty-Control-Secret", host.Services.GetRequiredService<ControlSecret>().Value);
        else client.DefaultRequestHeaders.Authorization = new("Bearer", "operator");
        var route = $"{(control ? "/control/v1" : "/api")}/apps/{Target}/remove";
        (await client.PostAsJsonAsync(route, Options(false))).EnsureSuccessStatusCode();
        Assert.Null(await Apps(host).GetAppAsync(Target));
        foreach (var file in DataFiles(host)) Assert.True(File.Exists(file));
        // Operator cleanup of retained data remains possible after the app is absent.
        (await client.PostAsJsonAsync(route, Options(true))).EnsureSuccessStatusCode();
        foreach (var file in DataFiles(host)) Assert.False(File.Exists(file));
    }

    private static object Options(bool destructive) => new { deleteRuntimeState = true, deleteData = destructive,
        deleteBackups = destructive, deleteSource = destructive, ignoreRuntimeErrors = false };
    private static AppRegistryStore Apps(CoreHttpHarness host) => host.Services.GetRequiredService<AppRegistryStore>();
    private static IEnumerable<string> DataFiles(CoreHttpHarness host)
    {
        var paths = host.Services.GetRequiredService<CoreDataPaths>();
        foreach (var dir in new[] { Path.Combine(paths.AppsRoot, Target, "data"), Path.Combine(paths.AppsRoot, Target, "cache"),
            paths.ResolveManagedCheckoutPath(Target), Path.Combine(paths.BackupsRoot, Target) })
            yield return Path.Combine(dir, "keep.txt");
    }
    private static async Task<HttpClient> Setup(CoreHttpHarness host)
    {
        var client = await AppManagementHttpTests.CreateAppClient(host, Caller, [CoreAppPermissions.Install]);
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(s => s with {
            Sessions = s.Sessions.Select(session => session with { BrowserOrigin = "http://localhost" }).ToArray(),
        });
        var now = DateTimeOffset.UtcNow;
        await Apps(host).UpsertAppAsync(new AppRecord(Target, "<Target>", null, "1.0.0", "runtime", false,
            "manifest", null, null, "dev", "installed", "stopped", null, null, [], new Dictionary<string, AppSettingValue>(),
            [], [], [], now, now));
        foreach (var file in DataFiles(host)) { Directory.CreateDirectory(Path.GetDirectoryName(file)!); await File.WriteAllTextAsync(file, "original"); }
        return client;
    }
    private static HttpClient Browser(CoreHttpHarness host)
    {
        var client = host.CreateClient();
        client.DefaultRequestHeaders.Add("Cookie", "hosty_session=operator");
        return client;
    }
    private static async Task<string> Prepare(HttpClient app, string route, bool destructive)
    {
        using var response = await app.PostAsJsonAsync(route, new { removeAppId = Target, removalOptions = Options(destructive) });
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var text = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain("\"identity\"", text);
        return JsonDocument.Parse(text).RootElement.GetProperty("id").GetString()!;
    }
    private static string Nonce(string html) => Regex.Match(html, "name=nonce value=\"([^\"]+)\"").Groups[1].Value;
    private static Task<HttpResponseMessage> Decide(HttpClient client, string id, string nonce, string decision, string origin = "http://localhost")
        => client.SendAsync(new HttpRequestMessage(HttpMethod.Post, $"/install/confirm/{id}") {
            Content = new FormUrlEncodedContent(new Dictionary<string, string> { ["nonce"] = nonce, ["decision"] = decision,
                ["deleteData"] = "true", ["removeAppId"] = Caller }), Headers = { { "Origin", origin } },
        });
    private static async Task<string> Wait(CoreHttpHarness host, string id)
    {
        var approvals = host.Services.GetRequiredService<InstallationApprovalStore>();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (approvals.Get(id).Status == "executing") await Task.Delay(10, timeout.Token);
        return approvals.Get(id).Status;
    }
    private static async Task AssertIntact(CoreHttpHarness host)
    {
        Assert.NotNull(await Apps(host).GetAppAsync(Target));
        foreach (var file in DataFiles(host)) Assert.Equal("original", await File.ReadAllTextAsync(file));
    }
}
