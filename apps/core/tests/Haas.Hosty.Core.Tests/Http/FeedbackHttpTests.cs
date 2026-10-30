using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class FeedbackHttpTests
{
    [Fact]
    public async Task IndependentReporterNeedsNoManagementGrantAndCannotReadReports()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var tokens = host.Services.GetRequiredService<AppServiceTokenService>();
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        var reporter = Record("vendor.canvas", now);
        await apps.UpsertAppAsync(reporter);
        await users.UpdateAsync(s => s with {
            Users = [new("person", "person@example.test", "Person", "host.user", false, now, now),
                new("owner", "owner@example.test", "Owner", "host.admin", false, now, now)],
            Assignments = [new(reporter.Id, "person", now)],
        });
        using var client = host.CreateClient();
        const string own = "/api/internal/apps/vendor.canvas/ui/feedback";
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(own)).StatusCode);
        client.DefaultRequestHeaders.Authorization = new("Bearer", tokens.CreateToken(reporter.Id));
        var grant = await BrowserAuthorityFixture.Grant(host, reporter.Id, "person");
        client.DefaultRequestHeaders.Add("X-Hosty-User-Token", grant.AccessToken);
        var capability = await client.GetFromJsonAsync<JsonElement>(own);
        Assert.False(capability.GetProperty("administrator").GetBoolean());
        var input = new { requestId = Guid.NewGuid().ToString(), comment = "Ordinary observation", annotations = new[] {
            new { id = Guid.NewGuid().ToString(), text = "Please align the label", route = "/document", capturedAt = now } } };
        var accepted = await client.PostAsJsonAsync(own, input); accepted.EnsureSuccessStatusCode();
        var id = (await accepted.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString();
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/internal/apps/vendor.canvas/feedback")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(own + "/" + id + "/review-targets")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/feedback")).StatusCode);
        await apps.UpsertAppAsync(reporter with { DevModeId = Guid.NewGuid().ToString() });
        var missingContext = await client.PostAsJsonAsync(own, new { requestId = Guid.NewGuid().ToString(), input.comment, input.annotations });
        missingContext.EnsureSuccessStatusCode();
        var missingId = (await missingContext.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString();
        var unknown = (await host.Services.GetRequiredService<FeedbackStore>().ListAsync(default)).Reports.Single(r => r.Id == missingId);
        Assert.Equal("unknown", unknown.Context.ExecutionKind); Assert.Null(unknown.WorkspaceId);
        await apps.UpsertAppAsync(reporter);
        var collection = await host.Services.GetRequiredService<FeedbackStore>().ListAsync(default);
        var report = collection.Reports.Single(r => r.Id == id); Assert.Empty(collection.Dispatches);
        Assert.Equal("vendor.canvas", report.Context.AppId); Assert.Null(report.WorkspaceId);

        grant = await BrowserAuthorityFixture.Grant(host, reporter.Id, "owner", "admin-browser");
        client.DefaultRequestHeaders.Remove("X-Hosty-User-Token"); client.DefaultRequestHeaders.Add("X-Hosty-User-Token", grant.AccessToken);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/internal/apps/vendor.canvas/feedback")).StatusCode);
        var none = await client.GetFromJsonAsync<JsonElement>(own + "/" + id + "/review-targets");
        Assert.Equal(0, none.GetProperty("targets").GetArrayLength());
        var manager = Record("other.review", now) with {
            GrantedCorePermissions = [CoreAppPermissions.FeedbackManage],
            Endpoints = [new("web", "http", "http://app.test", true)],
            Ui = AppUiContract.FromManifest(new RuntimeAppUiManifest { PortKey = "web", Navigation = [
                new() { Path = "/custom/inbox", Label = "Review", FeedbackReview = true }] }),
        };
        await apps.UpsertAppAsync(manager);
        var targets = await client.GetFromJsonAsync<JsonElement>(own + "/" + id + "/review-targets");
        var target = Assert.Single(targets.GetProperty("targets").EnumerateArray());
        var href = Uri.UnescapeDataString(target.GetProperty("href").GetString()!);
        Assert.Contains("other.review", href); Assert.Contains("/custom/inbox?feedback=" + id, href);
        await apps.UpsertAppAsync(reporter with { GrantedCorePermissions = [CoreAppPermissions.FeedbackManage] });
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/internal/apps/vendor.canvas/feedback")).StatusCode);
        await users.UpdateAsync(s => s with { Assignments = [] });
        var revoked = await client.PostAsJsonAsync(own, input); // The admin remains allowed, independently of assignments.
        revoked.EnsureSuccessStatusCode();
    }
    private static AppRecord Record(string id, DateTimeOffset now) => new(
        Id: id, DisplayName: "Independent app", Description: "Test", Version: "1.0.0", Kind: "runtime", System: false,
        Source: "installed", ManifestPath: $"apps/{id}/manifest.json", ManifestUrl: null, SelectedRuntime: "docker",
        OperationStatus: "installed", RuntimeState: "stopped", LastOperation: null, LastError: null,
        Capabilities: ["open"], Settings: new Dictionary<string, AppSettingValue>(), StorageMappings: [], Dependencies: [],
        Endpoints: [], InstalledAt: now, UpdatedAt: now);
}
