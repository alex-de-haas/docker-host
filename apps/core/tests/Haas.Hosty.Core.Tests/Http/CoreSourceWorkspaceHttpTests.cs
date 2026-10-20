using System.Net;
using System.Net.Http.Json;
using Haas.Hosty.Launch;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class CoreSourceWorkspaceHttpTests
{
    [Fact]
    public async Task AdministratorCanPrepareReplayAndDeselectCoreWithoutStartingAnyRuntime()
    {
        var remote = Path.Combine(Path.GetTempPath(), "hosty-core-http-remote-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(remote);
        try
        {
            await File.WriteAllTextAsync(Path.Combine(remote, "Engine.csproj"), "<Project />");
            await DevelopmentWorkspaceService.Git(remote, ["init", "-b", "main"], default);
            await DevelopmentWorkspaceService.Git(remote, ["add", "."], default);
            await DevelopmentWorkspaceService.Git(remote, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "fixture"], default);
            var transport = new CoreLifecycleServiceTests.RemoteGitFixture(remote);
            await using var host = await CoreHttpHarness.StartAsync(configure: services => services.AddSingleton<ISourceGitAccess>(transport));
            await Seed(host, "host.admin");
            using var browser = host.CreateClient();
            browser.DefaultRequestHeaders.Add("Cookie", "hosty_session=operator; hosty_csrf=csrf");
            browser.DefaultRequestHeaders.Add("X-Hosty-CSRF", "csrf");
            var before = (await browser.GetFromJsonAsync<CoreDevelopmentState>("/api/core/development"))!;
            using var saved = await browser.PutAsJsonAsync("/api/core/source", new CoreSourceRequest(null,
                before.Source.Revision, new(CoreLifecycleServiceTests.RemoteGitFixture.Url, "main", "Engine.csproj", "connection")));
            Assert.True(saved.IsSuccessStatusCode, await saved.Content.ReadAsStringAsync());
            var settings = (await saved.Content.ReadFromJsonAsync<CoreSourceSettings>())!;
            var input = new CoreWorkspacePrepare(Guid.NewGuid().ToString(), "core-only", Guid.NewGuid().ToString(), settings.Revision);
            using var prepared = await browser.PostAsJsonAsync("/api/core/source/workspaces", input);
            Assert.True(prepared.IsSuccessStatusCode, await prepared.Content.ReadAsStringAsync());
            var tree = (await prepared.Content.ReadFromJsonAsync<DevelopmentWorkspace>())!;
            Assert.Empty(tree.Apps);
            Assert.NotNull(tree.Core);
            await File.WriteAllTextAsync(Path.Combine(tree.Path, "keep.txt"), "unfinished");
            using var replay = await browser.PostAsJsonAsync("/api/core/source/workspaces", input);
            Assert.Equal(tree.Id, (await replay.Content.ReadFromJsonAsync<DevelopmentWorkspace>())!.Id);
            using var planned = await browser.PostAsJsonAsync($"/api/development/workspaces/{tree.WorkspaceId}/activation-plan", new WorkspaceActivationSelection());
            Assert.True(planned.IsSuccessStatusCode, await planned.Content.ReadAsStringAsync());
            var plan = (await planned.Content.ReadFromJsonAsync<WorkspaceActivationPlan>())!;
            Assert.True(Assert.Single(plan.Participants).Selected);
            using var deselected = await browser.PostAsJsonAsync($"/api/development/workspaces/{tree.WorkspaceId}/activation-plan", new WorkspaceActivationSelection(CoreSelected: false));
            Assert.False(Assert.Single((await deselected.Content.ReadFromJsonAsync<WorkspaceActivationPlan>())!.Participants).Selected);
            Assert.Equal(before.Instance, (await browser.GetFromJsonAsync<CoreDevelopmentState>("/api/core/development"))!.Instance);
            Assert.Empty(await host.Services.GetRequiredService<AppRegistryStore>().ListAppRecordsAsync());
            transport.Revoked = true;
            Assert.Equal(HttpStatusCode.Conflict, (await browser.PostAsJsonAsync("/api/core/source/workspaces", input)).StatusCode);
            Assert.Equal("unfinished", await File.ReadAllTextAsync(Path.Combine(tree.Path, "keep.txt")));
        }
        finally
        {
            foreach (var file in Directory.EnumerateFiles(remote, "*", SearchOption.AllDirectories)) File.SetAttributes(file, FileAttributes.Normal);
            Directory.Delete(remote, true);
        }
    }

    [Theory]
    [InlineData("/api/core/source/prepare")]
    [InlineData("/api/core/source/workspaces")]
    [InlineData("/api/development/workspaces/unknown/activation-plan")]
    public async Task WorkspaceManagementRequiresAdminAndCsrf(string route)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await Seed(host, "host.user");
        using var browser = host.CreateClient();
        browser.DefaultRequestHeaders.Add("Cookie", "hosty_session=operator; hosty_csrf=csrf");
        browser.DefaultRequestHeaders.Add("X-Hosty-CSRF", "csrf");
        var input = new { sourceRevision = "initial", requestId = Guid.NewGuid().ToString(),
            taskId = "test", leaseId = Guid.NewGuid().ToString() };
        Assert.Equal(HttpStatusCode.Forbidden, (await browser.PostAsJsonAsync(route, input)).StatusCode);
        await Seed(host, "host.admin");
        browser.DefaultRequestHeaders.Remove("X-Hosty-CSRF");
        Assert.Equal(HttpStatusCode.Forbidden, (await browser.PostAsJsonAsync(route, input)).StatusCode);
        Assert.Empty((await host.Services.GetRequiredService<DevelopmentWorkspaceService>().ListAsync(null, true, default)).Workspaces);
    }

    [Fact]
    public async Task SourceHttpPersistsRevisionAndReportsBuildSeparatelyWithoutRestartOrCheckout()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await Seed(host, "host.admin");
        using var browser = host.CreateClient();
        browser.DefaultRequestHeaders.Add("Cookie", "hosty_session=operator; hosty_csrf=csrf");
        browser.DefaultRequestHeaders.Add("X-Hosty-CSRF", "csrf");
        var before = (await browser.GetFromJsonAsync<CoreDevelopmentState>("/api/core/development"))!;
        var request = new CoreSourceRequest(null, before.Source.Revision,
            new("https://github.com/EXAMPLE/fork", "feature/test", "src/Engine.csproj"));
        var response = await browser.PutAsJsonAsync("/api/core/source", request);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var source = (await response.Content.ReadFromJsonAsync<CoreSourceSettings>())!;
        var after = (await browser.GetFromJsonAsync<CoreDevelopmentState>("/api/core/development"))!;
        Assert.Equal("https://github.com/example/fork.git", source.RepositoryUrl);
        Assert.Equal(before.Instance, after.Instance);
        Assert.Equal(before.Build, after.Build);
        Assert.Equal(before.Launch, after.Launch);
        Assert.Equal(CoreSourceDefaults.UpdateRepository, after.UpdateRepository);
        Assert.False(Directory.Exists(after.SourcePath));
        Assert.Equal(HttpStatusCode.Conflict, (await browser.PutAsJsonAsync("/api/core/source", request)).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await browser.PostAsJsonAsync("/api/core/source/prepare",
            new CoreSourcePrepare("stale"))).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await browser.PostAsJsonAsync("/api/core/source/workspaces",
            new CoreWorkspacePrepare(Guid.NewGuid().ToString(), "core-only", Guid.NewGuid().ToString(), "stale"))).StatusCode);
        Assert.Empty((await host.Services.GetRequiredService<DevelopmentWorkspaceService>().ListAsync(null, true, default)).Workspaces);
    }

    [Theory]
    [InlineData("/api/core/source/prepare")]
    [InlineData("/api/core/source/workspaces")]
    [InlineData("/api/development/workspaces/unknown/activation-plan")]
    public async Task WorkspaceAppPermissionDoesNotGrantCoreConfiguration(string route)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var app = await AppManagementHttpTests.CreateAppClient(host, "test.assistant", [CoreAppPermissions.WorkspacesRead]);
        Assert.Equal(HttpStatusCode.Forbidden, (await app.PostAsJsonAsync(route, new {})).StatusCode);
    }

    private static Task Seed(CoreHttpHarness host, string role)
    {
        var now = DateTimeOffset.UtcNow;
        return host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new UserDirectoryState(1,
            [new HostUserRecord("admin", "test@example.test", "Test", role, false, now, now)], [], [],
            [new AuthSessionRecord("operator", "admin", now, now.AddHours(1), null, now, BrowserOrigin: "http://localhost")]));
    }
}
