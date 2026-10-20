using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Haas.Hosty.Core;
using Haas.Hosty.Core.Tests.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData("aggregate-json")]
    [InlineData("aggregate-incomplete")]
    [InlineData("dev-missing")]
    [InlineData("dev-corrupt")]
    [InlineData("legacy-json")]
    [InlineData("legacy-directory")]
    [InlineData("package-json")]
    public async Task ExecutionInventory_PerAppStateReadFailureIsIsolatedWhileDirectAppRequestRetainsDiagnosis(string failure)
    {
        var (f, owner, workspaces, healthyTree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, healthyTree);
        var badRequest = NewApp("test.bad-recipe");
        await f.Service.CreateLocalAppAsync(owner, badRequest, null, default);
        var badTree = await workspaces.PrepareAsync(owner, new(badRequest.RequestId, owner.SessionId,
            badRequest.AppId, "/assistant", "main"), default);
        string metadataPath;
        string? contents = null;
        if (failure == "package-json")
        {
            metadataPath = Path.Combine(AppExecutionStore.DirectoryFor(f.Paths, badRequest.AppId), "package.json");
            contents = "{ unreadable";
        }
        else if (failure.StartsWith("dev-", StringComparison.Ordinal))
        {
            var journalId = Guid.NewGuid().ToString("D");
            await f.Apps.UpdateAppAsync(badRequest.AppId, app => app with { DevModeId = journalId });
            metadataPath = AppDevStore.Record(f.Paths, badRequest.AppId, journalId);
            if (failure == "dev-corrupt") contents = "{ unreadable";
        }
        else
        {
            var legacy = failure.StartsWith("legacy-", StringComparison.Ordinal);
            metadataPath = Path.Combine(AppExecutionStore.DirectoryFor(f.Paths, badRequest.AppId),
                legacy ? "recipes" : "workspace-recipes", (legacy ? badTree.Id : badTree.WorkspaceId) + ".json");
            if (failure == "legacy-directory") Directory.CreateDirectory(metadataPath);
            else contents = failure == "aggregate-incomplete" ? "{}" : "{ unreadable";
        }
        if (contents is not null)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(metadataPath)!);
            await File.WriteAllTextAsync(metadataPath, contents);
        }
        var appRecords = (await f.Apps.ListAppRecordsAsync()).ToDictionary(app => app.Id, app => CoreJson.Text(app));
        await using var host = await CoreHttpHarness.StartAsync(f.Clock, services =>
        {
            services.RemoveAll<AppExecutionTargetService>();
            services.AddSingleton(sp => new AppExecutionTargetService(f.Paths, f.Apps, f.Service, workspaces,
                new WorkspaceInspectionService(workspaces, f.Apps, f.Clock),
                sp.GetRequiredService<WorkspaceActivationAccess>(), NullLogger<AppExecutionTargetService>.Instance));
        });
        var now = f.Clock.UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
            [new(owner.UserId, "admin@example.test", "Admin", "host.admin", false, now, now)], [], [],
            [new("inventory-browser", owner.UserId, now, now.AddHours(8), null, now, BrowserOrigin: "http://localhost:7070")]));
        using var client = host.CreateClient();
        client.DefaultRequestHeaders.Add("Cookie", "hosty_session=inventory-browser");

        var response = await client.GetAsync("/api/apps/execution-targets");
        Assert.True(response.StatusCode == HttpStatusCode.OK, await response.Content.ReadAsStringAsync());
        var inventory = (await response.Content.ReadFromJsonAsync(CoreJson.TypeInfo<AppExecutionInventory>()))!;
        var healthy = Assert.Single(inventory.Apps);
        Assert.Equal("test.created", healthy.AppId);
        Assert.Contains(healthy.Choices, choice => choice.Kind == "package" && choice.Runtime == "docker");
        Assert.Contains(healthy.Choices, choice => choice.Kind == "workspace" && choice.WorktreeId == healthyTree.Id && choice.Available);
        if (failure.StartsWith("legacy-", StringComparison.Ordinal) || failure == "package-json")
        {
            var direct = await Record.ExceptionAsync(() => client.GetAsync($"/api/apps/{badRequest.AppId}/execution-targets"));
            Assert.True(direct is JsonException or IOException or UnauthorizedAccessException, direct?.ToString());
        }
        else
        {
            var direct = await client.GetAsync($"/api/apps/{badRequest.AppId}/execution-targets");
            Assert.Equal(HttpStatusCode.Conflict, direct.StatusCode);
            Assert.Equal(failure.StartsWith("dev-", StringComparison.Ordinal) ? "dev_state_unavailable" : "dev_recipe_invalid",
                (await direct.Content.ReadFromJsonAsync(CoreJson.TypeInfo<ErrorResponse>()))!.Code);
        }
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/apps/test.created/execution-targets")).StatusCode);
        if (contents is not null) Assert.Equal(contents, await File.ReadAllTextAsync(metadataPath));
        else if (failure == "legacy-directory") Assert.True(Directory.Exists(metadataPath));
        else Assert.False(File.Exists(metadataPath));
        foreach (var app in await f.Apps.ListAppRecordsAsync()) Assert.Equal(appRecords[app.Id], CoreJson.Text(app));
        Assert.Equal(0, f.Adapter.StartCount);
        Assert.Equal(0, f.Adapter.StopCount);
    }
}
