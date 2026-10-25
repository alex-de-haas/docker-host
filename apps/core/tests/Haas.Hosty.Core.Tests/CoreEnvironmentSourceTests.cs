using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData("outside")]
    [InlineData("prefix")]
    [InlineData("symlink")]
    [InlineData("unattached")]
    [InlineData("other-session")]
    public async Task EnvironmentSource_AppCannotSelectUnownedOrEscapingProject(string scenario)
    {
        var (f, _) = await SourceFixtureAsync();
        var workspaces = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await workspaces.PrepareAsync(owner, WorkspaceRequest(), default);
        var service = new CoreEnvironmentService(new(f.Paths), new SourceGuardRuntime(), f.Clock, workspaces);
        var actor = new SandboxActor(owner.UserId, owner.AppId, owner.Installation);
        var outside = Path.Combine(f.Root, "outside.csproj"); await File.WriteAllTextAsync(outside, "<Project />");
        var project = Path.Combine(tree.Path, "Core.csproj"); await File.WriteAllTextAsync(project, "<Project />");
        if (scenario == "outside") project = outside;
        if (scenario == "prefix")
        {
            project = Path.Combine(tree.Path + "-outside", "Core.csproj");
            Directory.CreateDirectory(Path.GetDirectoryName(project)!); await File.WriteAllTextAsync(project, "<Project />");
        }
        if (scenario == "symlink") { File.Delete(project); File.CreateSymbolicLink(project, outside); }
        var input = new CoreEnvironmentCreate(Guid.NewGuid().ToString(), "Source", "source", project,
            new(SessionId: scenario == "other-session" ? "other-session" : owner.SessionId), scenario == "unattached" ? [] : [tree.Id]);
        var error = await Assert.ThrowsAsync<SandboxException>(() => service.CreateAsync(actor, input, default));
        Assert.Equal(403, error.Status);
        Assert.Equal(scenario == "other-session" ? "environment_worktree_forbidden" : "environment_project_forbidden", error.Code);
        Assert.Empty((await service.ListAsync(actor, default)).Environments);
    }

    [Fact]
    public async Task EnvironmentSource_AttachedProjectWorks_ChangedLinkIsRejectedBeforeBuild_OperatorKeepsPathAuthority()
    {
        var (f, _) = await SourceFixtureAsync();
        var workspaces = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await workspaces.PrepareAsync(owner, WorkspaceRequest(), default);
        var runtime = new SourceGuardRuntime();
        var service = new CoreEnvironmentService(new(f.Paths), runtime, f.Clock, workspaces);
        var actor = new SandboxActor(owner.UserId, owner.AppId, owner.Installation);
        var project = Path.Combine(tree.Path, "Core.csproj"); await File.WriteAllTextAsync(project, "<Project />");
        var item = await service.CreateAsync(actor, new(Guid.NewGuid().ToString(), "Source", "source", project,
            new(SessionId: owner.SessionId), [tree.Id]), default);
        Assert.Contains(item.Id, (await workspaces.Read(tree.Id, owner, default)).SandboxConsumers);
        var outside = Path.Combine(f.Root, "outside.csproj"); await File.WriteAllTextAsync(outside, "<Project />");
        File.Delete(project); File.CreateSymbolicLink(project, outside);
        var failed = await service.CommandAsync(actor, item.Id, "start", new(Guid.NewGuid().ToString(), item.Revision), default);
        Assert.Equal("failed", failed.State); Assert.Equal(0, runtime.Builds);
        var direct = await service.CreateAsync(new(owner.UserId, null, null),
            new(Guid.NewGuid().ToString(), "Operator source", "source", outside), default);
        Assert.Equal(outside, direct.ProjectPath);
    }
    private sealed class SourceGuardRuntime : ICoreEnvironmentRuntime
    {
        public int Builds;
        public Task<string> PrepareAsync(CoreEnvironmentRecord record, string root, CancellationToken ct) { Builds++; return Task.FromResult("unused"); }
        public Task<CoreEnvironmentProcess?> ObserveAsync(CoreEnvironmentRecord record, string root, CancellationToken ct) => Task.FromResult<CoreEnvironmentProcess?>(null);
        public Task StartAsync(CoreEnvironmentRecord record, string root, Func<CoreEnvironmentProcess, Task> save, CancellationToken ct) => Task.CompletedTask;
        public Task StopAsync(CoreEnvironmentRecord record, string root, bool remove, CancellationToken ct) => Task.CompletedTask;
    }
}
