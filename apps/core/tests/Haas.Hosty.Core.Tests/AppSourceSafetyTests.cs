using Haas.Hosty.Core;
using System.Text.Json.Nodes;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task SourceSafety_ClearedOverrideStaysClearedWhenOriginalManifestIsReconciled()
    {
        var (f, repository) = await SourceFixtureAsync();
        var installed = (await f.Apps.GetAppAsync(SourceTestApp))!;
        Assert.Equal(MountPathPolicy.ResolveRealPath(repository), installed.SourceState!.LocalOverridePath);
        var selection = await f.Manifests.LoadAsync(installed.InstallManifestPath!);
        await f.Sources.ClearLocalOverrideAsync(SourceTestApp);

        var restarted = f.RecreateService();
        var current = (await f.Apps.GetAppAsync(SourceTestApp))!;
        await restarted.ReconcileLiveContractAsync(current, new(selection, LiveReconciled: true, ManifestError: null), default);
        Assert.Null((await f.Apps.GetAppAsync(SourceTestApp))!.SourceState!.LocalOverridePath);
        // A deliberately selected override is still preserved by the same reconciliation path.
        await f.Sources.SetLocalOverrideAsync(SourceTestApp, new(repository));
        current = (await f.Apps.GetAppAsync(SourceTestApp))!;
        await restarted.ReconcileLiveContractAsync(current, new(selection, LiveReconciled: true, ManifestError: null), default);
        Assert.Equal(MountPathPolicy.ResolveRealPath(repository), (await f.Apps.GetAppAsync(SourceTestApp))!.SourceState!.LocalOverridePath);
        Assert.Equal("source", await File.ReadAllTextAsync(Path.Combine(repository, "README.md")));
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task SourceSafety_ClearedFolderOverrideStartsAndRestartsFromManagedSource(bool materialized, bool restart)
    {
        var f = await LifecycleFixture.CreateAsync();
        var repository = await CreateLocalCommandGitRepositoryAsync(f.Root);
        var manifestPath = Path.Combine(repository, "manifest.json");
        var manifest = JsonNode.Parse(CreateRemoteLocalCommandManifestJson(repository))!;
        manifest["runtimeProfiles"]![0]!["development"] = true;
        await File.WriteAllTextAsync(manifestPath, manifest.ToJsonString());
        await RunGitAsync(repository, ["add", "manifest.json"]);
        await RunGitAsync(repository, ["-c", "user.name=Hosty Test", "-c", "user.email=hosty@example.test", "commit", "-m", "Add manifest"]);
        await f.Service.InstallAsync(new AppInstallRequest(manifestPath, SelectedRuntime: "dev"));
        const string appId = "com.example.remote-local";
        Assert.Null((await f.Apps.GetAppAsync(appId))!.ManifestUrl);
        if (materialized) await f.Sources.ResolveManagedAsync(appId, new(Branch: "main"));
        await f.Sources.ClearLocalOverrideAsync(appId);
        var service = f.RecreateService();
        try
        {
            var started = restart ? await service.RestartAsync(appId) : await service.StartAsync(appId);
            Assert.Equal("running", started.App?.RuntimeState);
            var app = (await f.Apps.GetAppAsync(appId))!;
            Assert.Null(app.SourceState!.LocalOverridePath);
            Assert.True(Directory.Exists(Path.Combine(app.SourceState.ManagedCheckoutPath!, ".git")));
            var cwd = await File.ReadAllTextAsync(Path.Combine(f.Paths.AppsRoot, appId, "data", "cwd.txt"));
            Assert.Equal(MountPathPolicy.ResolveRealPath(Path.Combine(app.SourceState.ManagedCheckoutPath!, "apps", "remote-app")), cwd.Trim());
            Assert.Equal("", await RunGitAsync(repository, ["status", "--porcelain"]));
            Assert.Equal(manifest.ToJsonString(), await File.ReadAllTextAsync(manifestPath));
        }
        finally { await service.StopAsync(appId); }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SourceSafety_LegacySandboxConsumersAllowIdleOverrideRemovalAndConsumerRegistration(bool omitted)
    {
        var (f, repository) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var record = Path.Combine(f.Paths.CoreRoot, "development", "workspaces", tree.Id + ".json");
        var document = JsonNode.Parse(await File.ReadAllTextAsync(record))!.AsObject();
        if (omitted) document.Remove("sandboxConsumers");
        else document["sandboxConsumers"] = null;
        await File.WriteAllTextAsync(record, document.ToJsonString());
        var legacyRecord = await File.ReadAllTextAsync(record);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "keep.txt"), "uncommitted work");

        service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        Assert.Empty((await service.Read(tree.Id, owner, default)).SandboxConsumers);
        // Observation must not rewrite a record or erase another process's activity.
        Assert.Equal(legacyRecord, await File.ReadAllTextAsync(record));
        await f.Service.CreateRemovalPlanAsync(SourceTestApp, new(), default);
        await f.Sources.ClearLocalOverrideAsync(SourceTestApp);
        await f.Sources.ClearLocalOverrideAsync(SourceTestApp);
        Assert.Null((await f.Apps.GetAppAsync(SourceTestApp))!.SourceState!.LocalOverridePath);
        Assert.Equal("source", await File.ReadAllTextAsync(Path.Combine(repository, "README.md")));
        Assert.Equal("uncommitted work", await File.ReadAllTextAsync(Path.Combine(tree.Path, "keep.txt")));

        var consumer = Guid.NewGuid().ToString("N");
        await service.SetSandboxConsumerAsync(tree.Id, consumer, true, default);
        service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        Assert.Equal([consumer], (await service.Read(tree.Id, owner, default)).SandboxConsumers);
        Assert.Equal("source_in_use", (await Assert.ThrowsAsync<AppLifecycleException>(
            () => f.Sources.ClearLocalOverrideAsync(SourceTestApp))).Code);
        await service.SetSandboxConsumerAsync(tree.Id, consumer, false, default);
        Assert.Empty((await service.Read(tree.Id, owner, default)).SandboxConsumers);
    }

    [Theory]
    [InlineData("lease", "source_in_use")]
    [InlineData("pending", "source_in_use")]
    [InlineData("releasing", "source_in_use")]
    [InlineData("apps", "source_activity_unknown")]
    [InlineData("operations", "source_activity_unknown")]
    [InlineData("leases", "source_activity_unknown")]
    public async Task SourceSafety_LegacyConsumersDoNotHideActiveOrUnknownActivity(string activity, string expected)
    {
        var (f, _, service, tree, created, _) = await LocalHandoffFixture();
        if (activity == "lease") tree = await service.CommandAsync(tree.Id, null, "lease",
            new(Guid.NewGuid().ToString(), LeaseId: Guid.NewGuid().ToString()), default);
        if (activity == "pending") tree = tree with { Operations = [.. tree.Operations,
            new(Guid.NewGuid().ToString(), "commit", "fingerprint", "unknown")] };
        if (activity == "releasing") tree = tree with { State = "releasing" };
        var record = Path.Combine(f.Paths.CoreRoot, "development", "workspaces", tree.Id + ".json");
        await JsonStorage.WriteAsync(record, tree);
        var document = JsonNode.Parse(await File.ReadAllTextAsync(record))!.AsObject();
        document["sandboxConsumers"] = null;
        if (activity is "apps" or "operations" or "leases") document[activity] = null;
        await File.WriteAllTextAsync(record, document.ToJsonString());

        Assert.Equal(expected, (await Assert.ThrowsAsync<AppLifecycleException>(
            () => f.Sources.ClearLocalOverrideAsync("test.created"))).Code);
        Assert.Equal(expected, (await Assert.ThrowsAsync<AppLifecycleException>(
            () => f.Sources.SetLocalOverrideAsync("test.created", new(tree.Path)))).Code);
        Assert.Equal(expected, (await Assert.ThrowsAsync<AppLifecycleException>(
            () => f.Service.RemoveAsync("test.created", new(DeleteSource: true)))).Code);
        Assert.True(File.Exists(Path.Combine(created.Operation.SourcePath, "manifest.json")));
        Assert.True(File.Exists(Path.Combine(tree.Path, "feature.txt")));
    }

    [Theory]
    [InlineData("lease")]
    [InlineData("sandbox")]
    [InlineData("pending")]
    [InlineData("corrupt")]
    public async Task SourceSafety_ActiveOrUnknownConsumersBlockRemovalAndSourceChanges(string activity)
    {
        var (f, owner, service, tree, created, _) = await LocalHandoffFixture();
        var record = Path.Combine(f.Paths.CoreRoot, "development", "workspaces", tree.Id + ".json");
        if (activity == "lease") await service.CommandAsync(tree.Id, owner, "lease",
            new(Guid.NewGuid().ToString(), LeaseId: Guid.NewGuid().ToString()), default);
        if (activity == "sandbox") await service.SetSandboxConsumerAsync(tree.Id, new string('a', 32), true, default);
        if (activity == "pending") await JsonStorage.WriteAsync(record, tree with { Operations = [.. tree.Operations,
            new(Guid.NewGuid().ToString(), "commit", "fingerprint", "unknown")] });
        if (activity == "corrupt") await File.WriteAllTextAsync(record, "{");
        var code = activity == "corrupt" ? "source_activity_unknown" : "source_in_use";
        Assert.Equal(code, (await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.RemoveAsync("test.created", new(DeleteSource: true)))).Code);
        Assert.Equal(code, (await Assert.ThrowsAsync<AppLifecycleException>(() => f.Sources.SetLocalOverrideAsync("test.created", new(tree.Path)))).Code);
        Assert.Equal(code, (await Assert.ThrowsAsync<AppLifecycleException>(() => f.Sources.ClearLocalOverrideAsync("test.created"))).Code);
        Assert.True(File.Exists(Path.Combine(created.Operation.SourcePath, "manifest.json")));
        Assert.NotNull(await f.Apps.GetAppAsync("test.created"));
    }

    [Fact]
    public async Task SourceSafety_ReviewedDeletionDetectsContentEditsEvenWhenGitStatusIsUnchanged()
    {
        var (f, _, _, tree, created, _) = await LocalHandoffFixture();
        var file = Path.Combine(created.Operation.SourcePath, "draft.txt");
        await File.WriteAllTextAsync(file, "before");
        var plan = await f.Service.CreateRemovalPlanAsync("test.created", new(DeleteSource: true), default);
        Assert.Contains(plan.SourceReview!.Details, d => d.Contains("uncommitted changes"));
        Assert.Contains(plan.SourceReview.Details, d => d.Contains("local only"));
        Assert.Contains(plan.SourceReview.Details, d => d.Contains("Integration into canonical source is not verified"));
        await File.WriteAllTextAsync(file, "after!");
        Assert.Equal("removal_source_changed", (await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.ApplyRemovalAsync(plan, default))).Code);
        Assert.Equal("after!", await File.ReadAllTextAsync(file));
        var fresh = await f.Service.CreateRemovalPlanAsync("test.created", new(DeleteSource: true), default);
        await f.Service.ApplyRemovalAsync(fresh, default);
        Assert.False(Directory.Exists(created.Operation.SourcePath));
        Assert.True(File.Exists(Path.Combine(tree.Path, "feature.txt")));
        Assert.Equal("removal_plan_stale", (await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.ApplyRemovalAsync(fresh, default))).Code);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SourceSafety_KeptLocalSourceCanBeExplicitlyReinstalledWithoutAcceptingEdits(bool deleteData)
    {
        var (f, owner, service, tree, created, _) = await LocalHandoffFixture();
        var file = Path.Combine(created.Operation.SourcePath, "draft.txt");
        await File.WriteAllTextAsync(file, "canonical edits");
        await f.Service.RemoveAsync("test.created", new(DeleteData: deleteData));
        var retained = await JsonStorage.ReadAsync<RetainedAppConfig>(Path.Combine(f.Paths.AppsRoot, "test.created", "retained-config.json"));
        Assert.Equal("local-git", retained!.LocalSource!.Type);
        if (deleteData) { Assert.Empty(retained.Settings); Assert.Empty(retained.Mounts); }
        var restarted = f.RecreateService();
        await restarted.RemoveAsync("test.created", new(DeleteData: true));
        retained = await JsonStorage.ReadAsync<RetainedAppConfig>(Path.Combine(f.Paths.AppsRoot, "test.created", "retained-config.json"));
        Assert.Equal(created.Operation.Commit, retained!.LocalSource!.Commit);
        Assert.Empty(retained.Settings);
        await restarted.InstallAsync(new(Path.Combine(created.Operation.SourcePath, "manifest.json"), "dev", Autostart: false));
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        Assert.Equal("local-git", app.SourceState!.Type);
        Assert.Equal(created.Operation.Commit, app.SourceState.Commit);
        Assert.Equal("canonical edits", await File.ReadAllTextAsync(file));
        Assert.True(File.Exists(Path.Combine(tree.Path, "feature.txt")));
        // A replacement installation never silently takes over the old workspace.
        Assert.Equal("workspace_app_reinstalled", (await Assert.ThrowsAsync<AppLifecycleException>(() => service.PrepareAsync(owner,
            new(Guid.NewGuid().ToString(), owner.SessionId, "test.created", "/assistant"), default))).Code);
    }

    [Theory]
    [InlineData("runtime-failure")]
    [InlineData("source-change")]
    public async Task SourceSafety_RuntimeFailureOrConcurrentEditRetainsSourceAndAllowsFreshReview(string fault)
    {
        var (f, _, _, _, created, _) = await LocalHandoffFixture();
        var file = Path.Combine(created.Operation.SourcePath, "new.txt");
        var plan = await f.Service.CreateRemovalPlanAsync("test.created", new(DeleteSource: true), default);
        f.Adapter.RemoveProbe = fault == "runtime-failure"
            ? () => throw new AppLifecycleException("runtime_remove_failed", "Injected Docker failure.")
            : () => File.WriteAllTextAsync(file, "late source change");
        var expected = fault == "runtime-failure" ? "runtime_remove_failed" : "removal_source_changed";
        Assert.Equal(expected, (await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.ApplyRemovalAsync(plan, default))).Code);
        Assert.True(Directory.Exists(created.Operation.SourcePath));
        Assert.NotNull(await f.Apps.GetAppAsync("test.created"));
        f.Adapter.RemoveProbe = null;
        await f.RecreateService().ApplyRemovalAsync(await f.Service.CreateRemovalPlanAsync("test.created", new(DeleteSource: true), default), default);
        Assert.False(Directory.Exists(created.Operation.SourcePath));
    }

    [Fact]
    public async Task SourceSafety_RemovalFencesNewLeaseUntilTheInstallationIsGone()
    {
        var (f, owner, service, tree, _, _) = await LocalHandoffFixture();
        Task<DevelopmentWorkspace>? lease = null;
        f.Adapter.RemoveProbe = () =>
        {
            lease = service.CommandAsync(tree.Id, owner, "lease", new(Guid.NewGuid().ToString(), LeaseId: Guid.NewGuid().ToString()), default);
            Assert.False(lease.IsCompleted);
            return Task.CompletedTask;
        };
        await f.Service.RemoveAsync("test.created", new());
        Assert.Equal("workspace_source_app_missing", (await Assert.ThrowsAsync<AppLifecycleException>(() => lease!)).Code);
        Assert.Empty((await service.Read(tree.Id, null, default)).Leases);
    }

    [Fact]
    public async Task SourceSafety_NoGitAndUnknownAreNotPresentedAsRecoverableGit()
    {
        var f = await LifecycleFixture.CreateAsync();
        await f.Service.InstallAsync(new(await f.WriteManifestAsync("1.0.0")));
        var source = f.Paths.ResolveManagedCheckoutPath("com.example.notes");
        Directory.CreateDirectory(source);
        await File.WriteAllTextAsync(Path.Combine(source, "only-copy.txt"), "no history");
        var plan = await f.Service.CreateRemovalPlanAsync("com.example.notes", new(DeleteSource: true), default);
        Assert.Contains(plan.SourceReview!.Details, d => d.Contains("No Git history"));
        Assert.False(plan.SourceReview.Unknown);
        await File.WriteAllTextAsync(Path.Combine(source, ".git"), "broken metadata");
        plan = await f.Service.CreateRemovalPlanAsync("com.example.notes", new(DeleteSource: true), default);
        Assert.True(plan.SourceReview!.Unknown);
        Assert.Equal("removal_source_unknown", (await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.ApplyRemovalAsync(plan, default))).Code);
        Assert.True(File.Exists(Path.Combine(source, "only-copy.txt")));
    }
}
