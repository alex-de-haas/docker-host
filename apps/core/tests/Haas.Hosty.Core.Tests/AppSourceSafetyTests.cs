using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
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
