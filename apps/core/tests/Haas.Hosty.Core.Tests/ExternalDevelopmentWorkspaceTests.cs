using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static WorkspaceOwner ExternalOwner(string task = "task-one", string principal = "oauth:grant-one", string label = "Codex")
        => WorkspaceOwner.ForExternal("admin", principal, task, label);

    private static WorkspacePrepare ExternalPrepare(string task = "task-one", string? label = null)
        => new(Guid.NewGuid().ToString(), task, SourceTestApp, null, "main", Guid.NewGuid().ToString(), label);

    [Fact]
    public async Task ExternalWorkspaces_PreserveLegacyAllocationSerializationAndRestartBinding()
    {
        const string legacy = "{\"appId\":\"hosty.harness\",\"installation\":\"2026-10-07T10:00:00+00:00\",\"userId\":\"admin\",\"sessionId\":\"session-one\"}";
        var owner = new WorkspaceOwner("hosty.harness", new DateTimeOffset(2026, 10, 7, 10, 0, 0, TimeSpan.Zero), "admin", "session-one");
        Assert.Equal(legacy, CoreJson.Text(owner));
        Assert.Equal(legacy, DevelopmentWorkspaceService.OwnerIdentity(owner));
        var (fixture, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(fixture.Paths, fixture.Apps, fixture.Clock);
        var input = WorkspaceRequest();
        var workspace = await service.PrepareAsync(owner, input, default);
        Assert.Equal(DevelopmentWorkspaceService.Hash(legacy + "\n" + workspace.RepositoryId), workspace.Id);
        Assert.DoesNotContain("externalLabel", CoreJson.Text(input));
        Assert.Null(workspace.Owner.External);
        Assert.DoesNotContain("\"external\"", await File.ReadAllTextAsync(Path.Combine(fixture.Paths.CoreRoot, "development/workspaces", workspace.Id + ".json")));
        var restarted = new DevelopmentWorkspaceService(fixture.Paths, fixture.Apps, fixture.Clock);
        Assert.Equal(workspace.Id, (await restarted.PrepareAsync(owner, input, default)).Id);
    }

    [Fact]
    public async Task ExternalWorkspaces_AllocateSeparateTasksAndGrantsButReuseRepositories()
    {
        var (fixture, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(fixture.Paths, fixture.Apps, fixture.Clock);
        var input = ExternalPrepare();
        var first = await service.PrepareAsync(ExternalOwner(), input, default);
        Assert.Equal(first.Id, (await service.PrepareAsync(ExternalOwner(), input, default)).Id);
        Assert.Null(first.SessionPath);
        Assert.True(first.Owner.IsExternal);
        Assert.Equal("Codex", first.Owner.External!.Label);
        var second = await service.PrepareAsync(ExternalOwner("task-two"), ExternalPrepare("task-two"), default);
        var third = await service.PrepareAsync(ExternalOwner(principal: "oauth:grant-two"), ExternalPrepare(), default);
        Assert.Equal(3, new[] { first.Id, second.Id, third.Id }.Distinct().Count());
        Assert.Equal(first.RepositoryId, second.RepositoryId);
        Assert.Equal(first.RepositoryId, third.RepositoryId);
        Assert.Single((await service.ListAsync(ExternalOwner(), false, default)).Workspaces);
        var denied = await Assert.ThrowsAsync<AppLifecycleException>(() => service.ObserveAsync(first.Id, third.Owner, default));
        Assert.Equal("workspace_forbidden", denied.Code);
        Assert.Equal("workspace_forbidden", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            service.DiffAsync(first.Id, third.Owner, new("README.md"), default))).Code);
        Assert.Equal("workspace_forbidden", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            service.CommandAsync(first.Id, third.Owner, "refresh", new(Guid.NewGuid().ToString()), default))).Code);
        Assert.True(Directory.Exists(first.Path));
    }

    [Fact]
    public async Task ExternalWorkspaces_DisplayLabelDoesNotRekeyButPreparationReplayChecksItsArguments()
    {
        var (fixture, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(fixture.Paths, fixture.Apps, fixture.Clock);
        var input = ExternalPrepare(label: "Codex");
        var first = await service.PrepareAsync(ExternalOwner(), input, default);
        Assert.True(first.Owner.SameIdentity(ExternalOwner(label: "Editor")));
        Assert.Equal(DevelopmentWorkspaceService.OwnerIdentity(first.Owner), DevelopmentWorkspaceService.OwnerIdentity(ExternalOwner(label: "Editor")));
        var changed = input with { ExternalLabel = "Editor" };
        Assert.Equal("workspace_request_conflict", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            service.PrepareAsync(ExternalOwner(label: "Editor"), changed, default))).Code);
        changed = changed with { RequestId = Guid.NewGuid().ToString() };
        var renamed = await service.PrepareAsync(ExternalOwner(label: "Editor"), changed, default);
        Assert.Equal(first.Id, renamed.Id);
        Assert.Equal("Editor", renamed.Owner.External!.Label);
        Assert.Equal(first.Id, (await new DevelopmentWorkspaceService(fixture.Paths, fixture.Apps, fixture.Clock)
            .PrepareAsync(ExternalOwner(label: "Editor"), changed, default)).Id);
    }

    [Fact]
    public async Task ExternalWorkspaces_ObserveUncommittedAndNativeCommittedPlansWithoutChangingTrackedBranch()
    {
        var (fixture, origin, service, documents) = await DocumentFixtureAsync();
        var workspace = await service.PrepareAsync(ExternalOwner(), ExternalPrepare(), default);
        var changed = PlanText.Replace("status: Ready", "status: In Progress").Replace("- [ ] D1.", "- [x] D1.");
        await File.WriteAllTextAsync(Path.Combine(workspace.Path, PlanPath), changed);
        await service.ObserveAvailableAsync(workspace.Id, default);
        var entry = Assert.Single((await documents.ListRepositoriesAsync("admin", default)).Repositories);
        var target = await documents.ListDocumentsAsync(entry.Id, "admin", false, default);
        var tracked = await documents.ReadContentAsync(entry.Id, "admin", new(PlanPath, Commit: target.Commit), default);
        Assert.Equal(PlanText, tracked.Content);
        var projected = Assert.Single((await documents.ListWorkspacesAsync("admin", null, default)).Workspaces);
        Assert.Equal("external", projected.OwnerKind);
        Assert.Equal("Codex", projected.OwnerLabel);
        Assert.Null(projected.AssistantAppId);
        Assert.Null(projected.SessionUrl);
        Assert.Null(projected.SessionUrlError);
        Assert.Equal(PlanPath, Assert.Single(projected.Changes!).Path);
        var local = await documents.ListDocumentsAsync(entry.Id, "admin", false, default, "worktree", workspace.Id);
        var localContent = await documents.ReadContentAsync(entry.Id, "admin", new(PlanPath, "worktree", workspace.Id,
            ExpectedSha: Assert.Single(local.Documents).Sha), default);
        Assert.Equal(changed, localContent.Content);
        await RunGitAsync(workspace.Path, ["add", PlanPath]);
        await CommitDocsAsync(workspace.Path, "Verified external plan progress");
        var observed = await service.ObserveAsync(workspace.Id, workspace.Owner, default);
        Assert.Empty(observed.Observation!.Local!.Files);
        Assert.Contains(PlanPath, observed.Observation.SessionFiles!);
        Assert.Equal(PlanPath, Assert.Single(Assert.Single((await documents.ListWorkspacesAsync("admin", null, default)).Workspaces).Changes!).Path);
        Assert.Equal(PlanText, await File.ReadAllTextAsync(Path.Combine(origin, PlanPath)));
    }

    [Fact]
    public async Task ExternalWorkspaces_CleanupRetainsLeasedDirtyAndUnmergedSource()
    {
        var (fixture, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(fixture.Paths, fixture.Apps, fixture.Clock);
        var input = ExternalPrepare();
        var workspace = await service.PrepareAsync(ExternalOwner(), input, default);
        async Task<DevelopmentWorkspace> Cleanup() => await service.CommandAsync(workspace.Id, workspace.Owner, "cleanup",
            new(Guid.NewGuid().ToString(), (await service.ObserveAsync(workspace.Id, workspace.Owner, default)).Observation!.Head), default);
        await Assert.ThrowsAsync<AppLifecycleException>(Cleanup);
        Assert.True(Directory.Exists(workspace.Path));
        var restarted = new DevelopmentWorkspaceService(fixture.Paths, fixture.Apps, fixture.Clock);
        Assert.Contains(input.LeaseId!, (await restarted.ObserveAsync(workspace.Id, workspace.Owner, default)).Leases);
        await service.CommandAsync(workspace.Id, workspace.Owner, "release-lease", new(Guid.NewGuid().ToString(), LeaseId: input.LeaseId), default);
        await File.WriteAllTextAsync(Path.Combine(workspace.Path, "README.md"), "external edits");
        await Assert.ThrowsAsync<AppLifecycleException>(Cleanup);
        workspace = await service.CommandAsync(workspace.Id, workspace.Owner, "commit", WorkspaceCommit(workspace.OriginalBase, "feat: external work", "README.md"), default);
        await Assert.ThrowsAsync<AppLifecycleException>(Cleanup);
        Assert.True(Directory.Exists(workspace.Path));
    }

    [Theory]
    [InlineData("clear")]
    [InlineData("rebind")]
    [InlineData("revoke")]
    public async Task ExternalWorkspaces_RevalidatePrivateSourceBeforeManagedReadsAndMutations(string transition)
    {
        var (fixture, _, initial, _) = await DocumentFixtureAsync();
        var workspace = await initial.PrepareAsync(ExternalOwner(), ExternalPrepare(), default);
        var (users, access, grant) = await PrivateDocumentAccessAsync(fixture, workspace.Repository);
        await fixture.Apps.UpdateAppAsync(SourceTestApp, app => app with { PrivateSources = new(Git: grant) });
        workspace = workspace with { SourceGrant = grant };
        await JsonStorage.WriteAsync(Path.Combine(fixture.Paths.CoreRoot, "development/workspaces", workspace.Id + ".json"), workspace);
        var service = new DevelopmentWorkspaceService(fixture.Paths, fixture.Apps, fixture.Clock, privateSources: access);
        await File.WriteAllTextAsync(Path.Combine(workspace.Path, PlanPath), "# Local private plan\n");
        await service.ObserveAsync(workspace.Id, workspace.Owner, default);
        await service.DiffAsync(workspace.Id, workspace.Owner, new(PlanPath), default);
        if (transition == "revoke")
            await users.UpdateAsync(state => state with { ProviderConnections = state.ProviderConnections!.Where(c => c.Id != "source-admin").ToArray() });
        else
        {
            var replacement = transition == "rebind" ? await access.BindAsync("bob", "source-bob", workspace.Repository, false, default) : null;
            await fixture.Apps.UpdateAppAsync(SourceTestApp, app => app with { PrivateSources = replacement is null ? null : new(Git: replacement) });
        }
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ObserveAsync(workspace.Id, workspace.Owner, default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.DiffAsync(workspace.Id, workspace.Owner, new(PlanPath), default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.CommandAsync(workspace.Id, workspace.Owner, "commit",
            WorkspaceCommit(workspace.OriginalBase, "feat: denied", PlanPath), default));
        Assert.Equal("# Local private plan\n", await File.ReadAllTextAsync(Path.Combine(workspace.Path, PlanPath)));
    }
}
