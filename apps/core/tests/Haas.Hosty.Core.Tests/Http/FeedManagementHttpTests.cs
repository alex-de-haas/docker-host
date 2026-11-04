using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Haas.Hosty.Launch;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class FeedManagementHttpTests
{
    [Theory]
    [InlineData(CoreAppPermissions.Install)]
    [InlineData(CoreAppPermissions.Sources)]
    public async Task PublisherSwitchRequiresBothSourceAndInstallAuthority(string permission)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var app = await AppManagementHttpTests.CreateAppClient(host, "thirdparty.manager", [permission]);
        using var response = await app.PostAsJsonAsync("/api/apps/other/update-source/plan", new { });
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Contains("app_permission_required", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task PlatformFeedGrantCannotSelectWithoutOperatorConfirmation()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var app = await AppManagementHttpTests.CreateAppClient(host, "thirdparty.manager", [CoreAppPermissions.ConfigureCore]);
        using var response = await app.PutAsJsonAsync("/api/core/update-feed", new { indexRef = "https://publisher.test/feeds.json", feedId = "Custom" });
        Assert.Equal(428, (int)response.StatusCode);
        var review = (await response.Content.ReadFromJsonAsync<SettingsChangeView>())!;
        Assert.Equal(HttpStatusCode.Forbidden, (await app.GetAsync("/settings/confirm/" + review.Id)).StatusCode);
        var config = host.Services.GetRequiredService<HostyCoreRuntimeConfig>();
        Assert.Null(Haas.Hosty.Releases.PlatformFeedFiles.ReadSource(config.DataRoot));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SourceSwitchReviewShowsExactBindingsAndRejectsChangedRequest(bool batch)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        const string id = "thirdparty.manager";
        using var app = await AppManagementHttpTests.CreateAppClient(host, id, [CoreAppPermissions.Install, CoreAppPermissions.Sources]);
        await ProtectedSettingsHttpTests.NormalizeBrowser(host);
        var digest = new string('a', 64);
        var plan = new AppUpdateSourcePlan(id, new("https://old.test/manifest.json", null, null),
            new("https://new.test/release.json", "https://new.test/index.json", "Candidate"), "revision", "feed", "manifest", "1.0.0", null,
            "installed-ahead", "Binding only", null, DateTimeOffset.UtcNow, digest);
        var config = host.Services.GetRequiredService<HostyCoreRuntimeConfig>();
        CoreLaunchFiles.Write(Path.Combine(config.DataRoot, "core", "update-source", "plans", digest + ".json"), plan,
            CoreJsonSerializerContext.Default.AppUpdateSourcePlan);
        var requestId = Guid.NewGuid().ToString("N");
        object Body(string request) => batch ? new AppUpdateSourceBatchRequest(request, [new(id, digest)]) : new AppUpdateSourceApplyRequest(digest, request);
        var path = batch ? "/api/apps/update-source/apply" : $"/api/apps/{id}/update-source/apply";
        using var response = await app.PostAsJsonAsync(path, Body(requestId));
        Assert.Equal(428, (int)response.StatusCode);
        var review = (await response.Content.ReadFromJsonAsync<SettingsChangeView>())!;
        using var browser = ProtectedSettingsHttpTests.Browser(host);
        var html = await browser.GetStringAsync("/settings/confirm/" + review.Id);
        Assert.Contains("https://old.test/manifest.json", html);
        Assert.Contains("https://new.test/index.json", html);
        Assert.Contains("Candidate", html);
        Assert.DoesNotContain("planDigest", html);
        await ProtectedSettingsHttpTests.Decide(browser, review.Id, html, "approve");
        app.DefaultRequestHeaders.Add(ProtectedSettingsChanges.Header, review.Id);
        using var changed = await app.PostAsJsonAsync(path, Body(Guid.NewGuid().ToString("N")));
        Assert.Equal(HttpStatusCode.Forbidden, changed.StatusCode);
        Assert.Contains("settings_change_mismatch", await changed.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task DirectBrowserMutationStillRequiresCsrf()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var setup = await AppManagementHttpTests.CreateAppClient(host, "thirdparty.manager", []);
        await ProtectedSettingsHttpTests.NormalizeBrowser(host);
        using var browser = ProtectedSettingsHttpTests.Browser(host);
        using var response = await browser.PutAsJsonAsync("/api/core/update-feed", new { indexRef = "https://publisher.test/feeds.json", feedId = "Custom" });
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Contains("csrf_invalid", await response.Content.ReadAsStringAsync());
    }
}
