using System.Text.Json.Nodes;
using Haas.Hosty.Core;
using Haas.Hosty.Core.Tests.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static async Task<(LifecycleFixture Fixture, WorkspaceOwner Owner, DevelopmentWorkspaceService Workspaces,
        DevelopmentWorkspace First, DevelopmentWorkspace Second)> MultipleRecipeTrees()
    {
        var f = await LifecycleFixture.CreateAsync();
        async Task<string> SourceManifest(string repository, string version)
        {
            var path = await f.WriteManifestAsync(version, sourceRepository: repository, id: "test.created");
            var manifest = JsonNode.Parse(await File.ReadAllTextAsync(path))!.AsObject();
            manifest["runtimeProfiles"]!.AsArray().Add(new JsonObject { ["key"] = "dev", ["type"] = "docker", ["development"] = true });
            foreach (var service in manifest["services"]!.AsArray())
            {
                var runtime = service!["runtimes"]!["docker"]!.DeepClone();
                runtime["artifact"] = "source";
                runtime["command"] = "node index.js";
                runtime["workingDirectory"] = ".";
                runtime["sourceMount"] = new JsonObject { ["path"] = ".", ["target"] = "/workspace", ["mode"] = "ro" };
                service["runtimes"]!["dev"] = runtime;
            }
            var data = manifest["data"]!["targets"]!.AsArray();
            var target = data[0]!.DeepClone(); target["runtime"] = "dev"; data.Add(target);
            await File.WriteAllTextAsync(path, manifest.ToJsonString());
            File.Copy(path, Path.Combine(repository, "manifest.json"));
            await RunGitAsync(repository, ["add", "manifest.json"]);
            await RunGitAsync(repository, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Add runtime manifest"]);
            return path;
        }
        var firstRepository = await CreateGitRepositoryAsync(Path.Combine(f.Root, "first-source"));
        var firstManifest = await SourceManifest(firstRepository, "1.0.0");
        try { await f.Service.InstallAsync(new(firstManifest)); }
        catch (AppManifestException ex) { throw new InvalidOperationException(string.Join("; ", ex.Errors.Select(e => e.Message)), ex); }
        var installation = (await f.Apps.GetAppAsync("test.created"))!.InstalledAt;
        var owner = WorkspaceTestOwner(f);
        var workspaces = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var first = await workspaces.PrepareAsync(owner, new(Guid.NewGuid().ToString(), owner.SessionId,
            "test.created", "/assistant", "main"), default);
        // A reviewed source-repository update preserves the installation and retained worktrees.
        var secondRepository = await CreateGitRepositoryAsync(Path.Combine(f.Root, "second-source"));
        var secondManifest = await SourceManifest(secondRepository, "1.0.1");
        var update = await f.Service.CreateUpdatePlanAsync("test.created", new(secondManifest));
        await f.Service.ApplyUpdateAsync("test.created", new(update.PlanDigest));
        Assert.Equal(installation, (await f.Apps.GetAppAsync("test.created"))!.InstalledAt);
        var second = await workspaces.PrepareAsync(owner, new(Guid.NewGuid().ToString(), owner.SessionId,
            "test.created", "/assistant", "main"), default);
        Assert.NotEqual(first.Id, second.Id);
        Assert.Equal(first.WorkspaceId, second.WorkspaceId);
        Assert.Equal(first.Apps.Single().Installation, second.Apps.Single().Installation);
        Assert.Equal(2, (await workspaces.ListAsync(owner, false, default)).Workspaces.Length);
        return (f, owner, workspaces, first, second);
    }

    private static string AggregateRecipePath(LifecycleFixture f, DevelopmentWorkspace tree) =>
        Path.Combine(AppExecutionStore.DirectoryFor(f.Paths, "test.created"), "workspace-recipes", tree.WorkspaceId + ".json");

    [Fact]
    public async Task WorkspaceRecipe_MultipleRepositoriesConfigureOneTreeForInventoryAndGroupExecution()
    {
        var (f, owner, workspaces, first, second) = await MultipleRecipeTrees();
        var request = new WorkspaceRecipeRequest(Guid.NewGuid().ToString(), "test.created", second.Id, "dev");
        var configured = await f.Service.ConfigureWorkspaceRecipeAsync(first.WorkspaceId, request, owner.UserId, null, default);
        Assert.Equal(second.Id, configured.WorktreeId);
        var inspection = new WorkspaceInspectionService(workspaces, f.Apps, f.Clock);
        var inventory = await inspection.ListAsync(owner.UserId, default);
        var choice = Assert.Single((await f.Service.ReadExecutionTargetsAsync("test.created", inventory, default)).Choices,
            c => c.Kind == "workspace");
        Assert.True(choice.Available, choice.Unavailable);
        Assert.Equal(second.Id, choice.WorktreeId);
        Assert.Equal("dev", choice.Runtime);
        Assert.Equal(0, f.Adapter.StartCount);
        Assert.Equal(0, f.Adapter.StopCount);
        await using var host = await CoreHttpHarness.StartAsync(f.Clock);
        using var targets = new AppExecutionTargetService(f.Paths, f.Apps, f.Service, workspaces, inspection,
            host.Services.GetRequiredService<WorkspaceActivationAccess>(), NullLogger<AppExecutionTargetService>.Instance);
        await targets.StartAsync(default);
        try
        {
            var id = Guid.NewGuid().ToString();
            var result = await targets.SubmitWorkspaceAsync(first.WorkspaceId, new(id, "workspace"),
                new(owner.UserId, "local-control", Principal: "local-control"), default);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while (result.State == "running")
            {
                await Task.Delay(10, timeout.Token);
                result = await targets.WorkspaceStatusAsync(first.WorkspaceId, id, owner.UserId, timeout.Token);
            }
            Assert.Equal("completed", result.State);
            Assert.Equal(second.Id, (await f.Service.GetDevModeAsync("test.created")).WorktreeId);
        }
        finally { await targets.StopAsync(default); }
    }

    [Fact]
    public async Task WorkspaceRecipe_OlderTreeReplayCannotReplaceNewerAggregateSelectionAfterRestart()
    {
        var (f, owner, workspaces, first, second) = await MultipleRecipeTrees();
        var b = new WorkspaceRecipeRequest(Guid.NewGuid().ToString(), "test.created", second.Id, "dev");
        var a = b with { RequestId = Guid.NewGuid().ToString(), WorktreeId = first.Id };
        await f.Service.ConfigureWorkspaceRecipeAsync(first.WorkspaceId, b, owner.UserId, null, default);
        await f.Service.ConfigureWorkspaceRecipeAsync(first.WorkspaceId, a, owner.UserId, null, default);
        var service = f.RecreateService();
        var before = await File.ReadAllTextAsync(AggregateRecipePath(f, first));
        var replay = await service.ConfigureWorkspaceRecipeAsync(first.WorkspaceId, b, owner.UserId, null, default);
        Assert.Equal(first.Id, replay.WorktreeId);
        Assert.Equal(2, replay.Requests!.Length);
        Assert.Equal(before, await File.ReadAllTextAsync(AggregateRecipePath(f, first)));
        Assert.Equal("dev_request_conflict", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            service.ConfigureWorkspaceRecipeAsync(first.WorkspaceId, b with { WorktreeId = first.Id }, owner.UserId, null, default))).Code);
        var inventory = await new WorkspaceInspectionService(workspaces, f.Apps, f.Clock).ListAsync(owner.UserId, default);
        Assert.Equal(first.Id, Assert.Single((await service.ReadExecutionTargetsAsync("test.created", inventory, default)).Choices,
            c => c.Kind == "workspace").WorktreeId);
        Assert.Equal(0, f.Adapter.StartCount);
        Assert.Equal(0, f.Adapter.StopCount);
    }

    [Fact]
    public async Task WorkspaceRecipe_ExplicitTreeWinsWhileCurrentReportsTheActualRuntime()
    {
        var (f, owner, workspaces, first, second) = await MultipleRecipeTrees();
        await f.Service.ConfigureWorkspaceRecipeAsync(first.WorkspaceId,
            new(Guid.NewGuid().ToString(), "test.created", second.Id, "dev"), owner.UserId, null, default);
        Assert.Equal("completed", (await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", first), default)).State);
        var inventory = await new WorkspaceInspectionService(workspaces, f.Apps, f.Clock).ListAsync(owner.UserId, default);
        var result = await f.Service.ReadExecutionTargetsAsync("test.created", inventory, default);
        Assert.Equal(first.Id, result.Current.WorktreeId);
        Assert.Equal(second.Id, Assert.Single(result.Choices, c => c.Kind == "workspace").WorktreeId);
    }

    [Theory]
    [InlineData("unconfigured")]
    [InlineData("stale-binding")]
    public async Task WorkspaceRecipe_AmbiguousOrStaleAggregateChoiceFailsBeforePreparationAndStop(string failure)
    {
        var (f, owner, workspaces, first, second) = await MultipleRecipeTrees();
        if (failure == "stale-binding")
        {
            await f.Service.ConfigureWorkspaceRecipeAsync(first.WorkspaceId,
                new(Guid.NewGuid().ToString(), "test.created", second.Id, "dev"), owner.UserId, null, default);
            var path = Path.Combine(f.Paths.CoreRoot, "development", "workspaces", second.Id + ".json");
            await JsonStorage.WriteAsync(path, second with { Apps = [] });
        }
        await f.Service.StartAsync("test.created");
        var starts = f.Adapter.StartCount; var stops = f.Adapter.StopCount; var preparations = 0;
        f.Adapter.PreparationProbe = _ => { preparations++; return Task.CompletedTask; };
        var inventory = await new WorkspaceInspectionService(workspaces, f.Apps, f.Clock).ListAsync(owner.UserId, default);
        var choice = Assert.Single((await f.Service.ReadExecutionTargetsAsync("test.created", inventory, default)).Choices,
            c => c.Kind == "workspace");
        Assert.False(choice.Available);
        Assert.NotNull(choice.Unavailable);
        var request = await ExecutionRequest(f, owner, "workspace", first);
        request = request with { Request = request.Request with { WorktreeId = null } };
        Assert.Equal("dev_worktree_required", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.ExecuteTargetAsync(request, default))).Code);
        Assert.Equal(starts, f.Adapter.StartCount); Assert.Equal(stops, f.Adapter.StopCount); Assert.Equal(0, preparations);
        Assert.Equal("running", (await f.Apps.GetAppAsync("test.created"))!.RuntimeState);
    }

    [Theory]
    [InlineData("foreign-user")]
    [InlineData("foreign-principal")]
    [InlineData("reinstalled")]
    public async Task WorkspaceRecipe_AggregateSetupIsSharedButRejectsReinstalledBinding(string failure)
    {
        var (f, owner, _, first, second) = await MultipleRecipeTrees();
        var command = new WorkspaceRecipeRequest(Guid.NewGuid().ToString(), "test.created", second.Id, "dev");
        await f.Service.ConfigureWorkspaceRecipeAsync(first.WorkspaceId, command, owner.UserId, null, default);
        var before = await File.ReadAllTextAsync(AggregateRecipePath(f, first));
        if (failure == "reinstalled")
            await f.Apps.UpdateAppAsync("test.created", app => app with { InstalledAt = app.InstalledAt.AddSeconds(1) });
        Task Configure() => f.Service.ConfigureWorkspaceRecipeAsync(first.WorkspaceId,
            command, failure == "foreign-user" ? "other-admin" : owner.UserId,
            failure == "foreign-principal" ? "oauth:other" : null, default);
        if (failure == "reinstalled") await Assert.ThrowsAsync<AppLifecycleException>(Configure);
        else await Configure();
        Assert.Equal(before, await File.ReadAllTextAsync(AggregateRecipePath(f, first)));
        Assert.Equal(0, f.Adapter.StartCount); Assert.Equal(0, f.Adapter.StopCount);
    }

    [Theory]
    [InlineData("null")]
    [InlineData("missing")]
    [InlineData("empty")]
    public async Task WorkspaceRecipe_IncompleteAggregateReceiptsFailClosedWithoutLosingHistory(string damage)
    {
        var (f, owner, workspaces, first, second) = await MultipleRecipeTrees();
        var command = new WorkspaceRecipeRequest(Guid.NewGuid().ToString(), "test.created", second.Id, "dev");
        await f.Service.ConfigureWorkspaceRecipeAsync(first.WorkspaceId, command, owner.UserId, null, default);
        var path = AggregateRecipePath(f, first);
        var metadata = JsonNode.Parse(await File.ReadAllTextAsync(path))!.AsObject();
        if (damage == "missing") metadata.Remove("receipts");
        else metadata["receipts"] = damage == "null" ? null : new JsonArray();
        await File.WriteAllTextAsync(path, metadata.ToJsonString());
        var before = await File.ReadAllTextAsync(path);
        Assert.Equal("dev_recipe_invalid", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.ConfigureWorkspaceRecipeAsync(first.WorkspaceId, command, owner.UserId, null, default))).Code);
        var inventory = await new WorkspaceInspectionService(workspaces, f.Apps, f.Clock).ListAsync(owner.UserId, default);
        Assert.Equal("dev_recipe_invalid", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.ReadExecutionTargetsAsync("test.created", inventory, default))).Code);
        Assert.Equal(before, await File.ReadAllTextAsync(path));
        Assert.Equal(0, f.Adapter.StartCount); Assert.Equal(0, f.Adapter.StopCount);
    }

    [Fact]
    public async Task WorkspaceRecipe_LegacyPerTreeSetupIsReadOnlyFallbackAndCannotRevertAggregateSelection()
    {
        var (f, owner, workspaces, first, second) = await MultipleRecipeTrees();
        var old = new WorkspaceRecipeRequest(Guid.NewGuid().ToString(), "test.created", second.Id, "dev");
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        var path = Path.Combine(AppExecutionStore.DirectoryFor(f.Paths, app.Id), "recipes", second.Id + ".json");
        await JsonStorage.WriteAsync(path, new WorkspaceExecutionRecipe(app.Id, app.InstalledAt, "dev", [old]));
        var before = await File.ReadAllTextAsync(path);
        var inventory = await new WorkspaceInspectionService(workspaces, f.Apps, f.Clock).ListAsync(owner.UserId, default);
        Assert.Equal(second.Id, Assert.Single((await f.Service.ReadExecutionTargetsAsync(app.Id, inventory, default)).Choices,
            c => c.Kind == "workspace").WorktreeId);
        await f.Service.ConfigureWorkspaceRecipeAsync(first.WorkspaceId,
            old with { RequestId = Guid.NewGuid().ToString(), WorktreeId = first.Id }, owner.UserId, null, default);
        Assert.Equal(first.Id, (await f.Service.ConfigureWorkspaceRecipeAsync(first.WorkspaceId, old, owner.UserId, null, default)).WorktreeId);
        Assert.Equal(before, await File.ReadAllTextAsync(path));
    }
}
