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
    [Theory]
    [InlineData("edit")]
    [InlineData("delete")]
    public async Task IndependentAppMutationsRequireCurrentAdminAndManagementGrant(string action)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        var apps = host.Services.GetRequiredService<AppRegistryStore>(); var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var app = Record("third.party", now); await apps.UpsertAppAsync(app);
        await users.UpdateAsync(s => s with {
            Users = [new("person", "person@example.test", "Person", "host.user", false, now, now),
                new("owner", "owner@example.test", "Owner", "host.admin", false, now, now)],
            Assignments = [new(app.Id, "person", now)],
        });
        var store = host.Services.GetRequiredService<FeedbackStore>(); var report = await SeedFeedback(store, now);
        object input = action == "edit" ? ContentEdit(report) : new FeedbackDelete(Guid.NewGuid().ToString(), report.Revision);
        var route = $"/api/internal/apps/{app.Id}/feedback/{report.Id}/{action}";
        using var client = host.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync(route, input)).StatusCode);
        client.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(app.Id));
        var grant = await BrowserAuthorityFixture.Grant(host, app.Id, "person");
        client.DefaultRequestHeaders.Add("X-Hosty-User-Token", grant.AccessToken);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync(route, input)).StatusCode);
        grant = await BrowserAuthorityFixture.Grant(host, app.Id, "owner", "admin-browser");
        client.DefaultRequestHeaders.Remove("X-Hosty-User-Token"); client.DefaultRequestHeaders.Add("X-Hosty-User-Token", grant.AccessToken);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync(route, input)).StatusCode);
        await apps.UpsertAppAsync(app with { GrantedCorePermissions = [CoreAppPermissions.FeedbackManage] });
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync(route, input)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync(route, input)).StatusCode);
        await users.UpdateAsync(s => s with { Users = s.Users.Select(u => u with { Role = "host.user" }).ToArray() });
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync(route, input)).StatusCode);
    }

    [Fact]
    public async Task DirectAdminMutationsWorkWithNoInstalledAppsAndRequireBrowserCsrf()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new UserDirectoryState(1,
            [new("admin", "admin@example.test", "Admin", "host.admin", false, now, now)], [], [],
            [new("operator", "admin", now, now.AddHours(1), null, now, BrowserOrigin: "http://localhost")]));
        Assert.Empty(await host.Services.GetRequiredService<AppRegistryStore>().ListAppRecordsAsync());
        var store = host.Services.GetRequiredService<FeedbackStore>(); var report = await SeedFeedback(store, now);
        var route = $"/api/feedback/{report.Id}"; var edit = ContentEdit(report);
        using var client = host.CreateClient();
        client.DefaultRequestHeaders.Add("Cookie", "hosty_session=operator; hosty_csrf=feedback-csrf");
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync(route + "/edit", edit)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync(route + "/delete", new FeedbackDelete(Guid.NewGuid().ToString(), 1))).StatusCode);
        client.DefaultRequestHeaders.Add("X-Hosty-CSRF", "feedback-csrf");
        var response = await client.PostAsJsonAsync(route + "/edit", edit); response.EnsureSuccessStatusCode();
        var edited = await response.Content.ReadFromJsonAsync<FeedbackReport>(); Assert.Equal("Edited explanation", edited!.Comment);
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsJsonAsync(route + "/edit", edit with { RequestId = Guid.NewGuid().ToString() })).StatusCode);
        var deletion = new FeedbackDelete(Guid.NewGuid().ToString(), edited.Revision);
        response = await client.PostAsJsonAsync(route + "/delete", deletion); response.EnsureSuccessStatusCode();
        Assert.Equal("deleted", (await response.Content.ReadFromJsonAsync<FeedbackSubmissionReceipt>())!.Status);
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync(route + "/delete", deletion)).StatusCode);
        Assert.Empty((await store.ListAsync(default)).Reports);
    }

    private static FeedbackEdit ContentEdit(FeedbackReport report) => new(Guid.NewGuid().ToString(), report.Revision, "Edited explanation",
        report.Annotations.Select(n => new FeedbackAnnotationEdit(n.Id, "Edited annotation")).ToArray());
    private static async Task<FeedbackReport> SeedFeedback(FeedbackStore store, DateTimeOffset now)
    {
        await store.SubmitAsync("reporter", new("unrelated.reporter", "Reporter", "installation", "1.0.0", now, "package", null, null),
            new(Guid.NewGuid().ToString(), "Original report", [new(Guid.NewGuid().ToString(), "Original annotation", "/original", now)]), default);
        return Assert.Single((await store.ListAsync(default)).Reports);
    }

    private static AppRecord Record(string id, DateTimeOffset now) => new(
        Id: id, DisplayName: "Independent app", Description: "Test", Version: "1.0.0", Kind: "runtime", System: false,
        Source: "installed", ManifestPath: $"apps/{id}/manifest.json", ManifestUrl: null, SelectedRuntime: "docker",
        OperationStatus: "installed", RuntimeState: "stopped", LastOperation: null, LastError: null,
        Capabilities: ["open"], Settings: new Dictionary<string, AppSettingValue>(), StorageMappings: [], Dependencies: [],
        Endpoints: [], InstalledAt: now, UpdatedAt: now);
}
