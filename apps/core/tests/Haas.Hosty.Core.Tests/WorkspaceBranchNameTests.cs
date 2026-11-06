using System.Text;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData("Shared agent skills", "shared-agent-skills")]
    [InlineData("  -- Fix../API @ {errors} 🔧  ", "fix-api-errors")]
    [InlineData("Cafe\u0301 fixes", "café-fixes")]
    [InlineData("Исправить вход", "исправить-вход")]
    [InlineData("\u0301---🔧", "workspace")]
    [InlineData("abcdefghijklmnopqrstuvwxyz012345--tail", "abcdefghijklmnopqrstuvwxyz012345")]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa é", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    public void WorkspaceBranchNames_NormalizeBoundedReadableSlugs(string name, string expected)
    {
        var slug = DevelopmentWorkspaceService.WorkspaceBranchSlug(name);
        Assert.Equal(expected, slug);
        Assert.True(Encoding.UTF8.GetByteCount(slug) <= 32);
        Assert.Equal(slug, DevelopmentWorkspaceService.WorkspaceBranchSlug(slug));
    }

    private static string BranchRecord(LifecycleFixture fixture, DevelopmentWorkspace tree)
        => Path.Combine(fixture.Paths.CoreRoot, "development", "workspaces", tree.Id + ".json");

    [Fact]
    public async Task WorkspaceBranchNames_UsesPurposeAndRetainsBranchOnRenameReplayAndNativeEdit()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var input = WorkspaceRequest() with { Name = "Shared agent skills" };
        var tree = await service.PrepareAsync(owner, input, default);
        Assert.Equal("hosty/shared-agent-skills-" + tree.Id[..12], tree.Branch);
        Assert.Equal(12, tree.BranchNaming!.SuffixLength);
        await RunGitAsync(tree.Path, ["check-ref-format", "refs/heads/" + tree.Branch]);
        await service.RenameAsync(owner, new(Guid.NewGuid().ToString(), "A different task"), default);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "README.md"), "native edits survive");
        var restarted = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var replay = await restarted.PrepareAsync(owner, input, default);
        Assert.Equal(tree.Branch, replay.Branch);
        Assert.Equal(tree.BranchNaming, replay.BranchNaming);
        Assert.Equal(tree.Path, replay.Path);
        Assert.Equal("A different task", replay.Name);
        Assert.Equal("native edits survive", await File.ReadAllTextAsync(Path.Combine(tree.Path, "README.md")));
        Assert.Equal("workspace_request_conflict", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            restarted.PrepareAsync(owner, input with { Name = "Changed request" }, default))).Code);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WorkspaceBranchNames_CollisionExtendsSuffixWithoutAdoptingExistingRef(bool childRef)
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var first = await service.PrepareAsync(WorkspaceTestOwner(f), WorkspaceRequest(), default);
        var owner = WorkspaceTestOwner(f, "colliding");
        var id = DevelopmentWorkspaceService.Hash(DevelopmentWorkspaceService.OwnerIdentity(owner) + "\n" + first.RepositoryId);
        var repo = service.RepositoryPath(first.Repository);
        var occupied = "refs/heads/hosty/fix-playback-" + id[..12] + (childRef ? "/nested" : "");
        await RunGitAsync(repo, ["update-ref", occupied, first.OriginalBase]);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(owner.SessionId) with { Name = "Fix playback" }, default);
        Assert.Equal("hosty/fix-playback-" + id[..16], tree.Branch);
        Assert.Equal(first.OriginalBase, await RunGitAsync(repo, ["rev-parse", occupied]));
        Assert.Equal(16, tree.BranchNaming!.SuffixLength);
    }

    [Fact]
    public async Task WorkspaceBranchNames_AncestorRefBlocksAllocationWithoutMutation()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var first = await service.PrepareAsync(WorkspaceTestOwner(f), WorkspaceRequest(), default);
        await service.CommandAsync(first.Id, null, "cleanup", new(Guid.NewGuid().ToString(), first.OriginalBase), default);
        var repo = service.RepositoryPath(first.Repository);
        await RunGitAsync(repo, ["update-ref", "refs/heads/hosty", first.OriginalBase]);
        var owner = WorkspaceTestOwner(f, "blocked");
        Assert.Equal("workspace_branch_conflict", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            service.PrepareAsync(owner, WorkspaceRequest(owner.SessionId), default))).Code);
        Assert.Equal(first.OriginalBase, await RunGitAsync(repo, ["rev-parse", "refs/heads/hosty"]));
    }

    [Theory]
    [InlineData("intent")]
    [InlineData("refs")]
    [InlineData("worktree")]
    public async Task WorkspaceBranchNames_InterruptedPreparationRecoversExactAllocation(string stage)
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var input = WorkspaceRequest() with { Name = "Recover allocation" };
        var tree = await service.PrepareAsync(owner, input, default);
        var repo = service.RepositoryPath(tree.Repository);
        await service.RenameAsync(owner, new(Guid.NewGuid().ToString(), "Renamed before retry"), default);
        if (stage != "worktree") await RunGitAsync(repo, ["worktree", "remove", tree.Path]);
        if (stage == "intent")
        {
            await RunGitAsync(repo, ["update-ref", "-d", "refs/heads/" + tree.Branch]);
            await RunGitAsync(repo, ["update-ref", "-d", DevelopmentWorkspaceService.BranchAllocationRef(tree)]);
        }
        await JsonStorage.WriteAsync(BranchRecord(f, tree), tree with { State = "preparing",
            Operations = tree.Operations.Select(o => o with { State = "pending" }).ToArray() });
        var recovered = await new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock).PrepareAsync(owner, input, default);
        Assert.Equal("active", recovered.State);
        Assert.Equal(tree.Branch, recovered.Branch);
        Assert.Equal(tree.OriginalBase, recovered.Observation!.Head);
        Assert.Equal("Renamed before retry", recovered.Name);
        Assert.Single((await service.ListAsync(owner, true, default)).Workspaces);
    }

    [Theory]
    [InlineData("missing-proof")]
    [InlineData("foreign-proof")]
    [InlineData("missing-branch")]
    [InlineData("symbolic-branch")]
    public async Task WorkspaceBranchNames_UnprovenPreparationPreservesRefsAndRefusesRecovery(string damage)
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var input = WorkspaceRequest();
        var tree = await service.PrepareAsync(owner, input, default);
        var repo = service.RepositoryPath(tree.Repository);
        await RunGitAsync(repo, ["worktree", "remove", tree.Path]);
        var proofRef = DevelopmentWorkspaceService.BranchAllocationRef(tree);
        if (damage == "missing-proof") await RunGitAsync(repo, ["update-ref", "-d", proofRef]);
        if (damage == "foreign-proof") await RunGitAsync(repo, ["update-ref", proofRef, tree.OriginalBase]);
        if (damage == "missing-branch") await RunGitAsync(repo, ["update-ref", "-d", "refs/heads/" + tree.Branch]);
        if (damage == "symbolic-branch") await RunGitAsync(repo, ["symbolic-ref", "refs/heads/" + tree.Branch, "refs/hosty/targets/" + DevelopmentWorkspaceService.Hash("main")]);
        await JsonStorage.WriteAsync(BranchRecord(f, tree), tree with { State = "preparing",
            Operations = tree.Operations.Select(o => o with { State = "pending" }).ToArray() });
        var before = await RunGitAsync(repo, ["for-each-ref", "--format=%(refname) %(objectname) %(symref)"]);
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock).PrepareAsync(owner, input, default));
        Assert.Contains(error.Code, new[] { "workspace_branch_conflict", "workspace_ownership_invalid" });
        Assert.False(Directory.Exists(tree.Path));
        Assert.Equal(before, await RunGitAsync(repo, ["for-each-ref", "--format=%(refname) %(objectname) %(symref)"]));
    }

    [Theory]
    [InlineData("version")]
    [InlineData("slug")]
    [InlineData("suffix")]
    [InlineData("branch")]
    [InlineData("missing-descriptor")]
    public async Task WorkspaceBranchNames_InconsistentMetadataIsRejected(string field)
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var tree = await service.PrepareAsync(WorkspaceTestOwner(f), WorkspaceRequest(), default);
        var damaged = field switch
        {
            "version" => tree with { BranchNaming = tree.BranchNaming! with { Version = 2 } },
            "slug" => tree with { BranchNaming = tree.BranchNaming! with { Slug = "../main" } },
            "suffix" => tree with { BranchNaming = tree.BranchNaming! with { SuffixLength = 8 } },
            "branch" => tree with { Branch = "main" },
            _ => tree with { BranchNaming = null },
        };
        await JsonStorage.WriteAsync(BranchRecord(f, tree), damaged);
        Assert.Equal("workspace_ownership_invalid", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock).Read(tree.Id, null, default))).Code);
        Assert.Equal(tree.Branch, await RunGitAsync(tree.Path, ["branch", "--show-current"]));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WorkspaceBranchNames_LegacyRecordsReplayAndCleanUpWithoutRenaming(bool preparing)
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var input = WorkspaceRequest() with { Name = "An older workspace" };
        var tree = await service.PrepareAsync(owner, input, default);
        var repo = service.RepositoryPath(tree.Repository);
        // Manufacture a pre-upgrade fixture; no live workspace is migrated by production code.
        var legacy = "hosty/session/" + tree.Id;
        await RunGitAsync(tree.Path, ["branch", "-m", legacy]);
        await RunGitAsync(repo, ["update-ref", "-d", DevelopmentWorkspaceService.BranchAllocationRef(tree)]);
        tree = tree with { Branch = legacy, BranchNaming = null, State = preparing ? "preparing" : "active",
            Operations = tree.Operations.Select(o => o with { State = preparing ? "pending" : "succeeded" }).ToArray() };
        await JsonStorage.WriteAsync(BranchRecord(f, tree), tree);
        if (preparing) await RunGitAsync(repo, ["worktree", "remove", tree.Path]);
        service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var replay = await service.PrepareAsync(owner, input, default);
        await service.RenameAsync(owner, new(Guid.NewGuid().ToString(), "Updated display name"), default);
        Assert.Equal(legacy, replay.Branch);
        Assert.Null(replay.BranchNaming);
        Assert.Equal(legacy, await RunGitAsync(tree.Path, ["branch", "--show-current"]));
        var released = await service.CommandAsync(tree.Id, owner, "cleanup", new(Guid.NewGuid().ToString(), tree.OriginalBase), default);
        Assert.Equal("released", released.State);
        Assert.Null(released.BranchNaming);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WorkspaceBranchNames_CleanupRemovesReceiptAndRecoversAfterRefRemoval(bool interrupted)
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var repo = service.RepositoryPath(tree.Repository);
        var command = new WorkspaceCommand(Guid.NewGuid().ToString(), tree.OriginalBase);
        if (interrupted)
        {
            await RunGitAsync(repo, ["worktree", "remove", tree.Path]);
            await RunGitAsync(repo, ["update-ref", "-d", "refs/heads/" + tree.Branch]);
            var operation = new WorkspaceOperation(command.RequestId, "cleanup",
                DevelopmentWorkspaceService.Hash(CoreJson.Text(command)), "pending", tree.OriginalBase);
            await JsonStorage.WriteAsync(BranchRecord(f, tree), tree with { State = "releasing", Operations = [.. tree.Operations, operation] });
            service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        }
        Assert.Equal("released", (await service.CommandAsync(tree.Id, owner, "cleanup", command, default)).State);
        Assert.Equal("", await RunGitAsync(repo, ["for-each-ref", "--format=%(refname)", DevelopmentWorkspaceService.BranchAllocationRef(tree)]));
    }

    private static async Task<DevelopmentWorkspace> LegacyBranchFixture(LifecycleFixture f, DevelopmentWorkspaceService service, DevelopmentWorkspace tree)
    {
        // This constructs old persisted state only inside a disposable test fixture.
        var branch = "hosty/session/" + tree.Id;
        await RunGitAsync(tree.Path, ["branch", "-m", branch]);
        await RunGitAsync(service.RepositoryPath(tree.Repository), ["update-ref", "-d", DevelopmentWorkspaceService.BranchAllocationRef(tree)]);
        tree = tree with { Branch = branch, BranchNaming = null };
        await JsonStorage.WriteAsync(BranchRecord(f, tree), tree);
        return tree;
    }

    [Fact]
    public async Task WorkspaceBranchNames_MissingReceiptPreservesSourceDuringCleanup()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var repo = service.RepositoryPath(tree.Repository);
        await RunGitAsync(repo, ["update-ref", "-d", DevelopmentWorkspaceService.BranchAllocationRef(tree)]);
        Assert.Equal("workspace_ownership_invalid", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            service.CommandAsync(tree.Id, owner, "cleanup", new(Guid.NewGuid().ToString(), tree.OriginalBase), default))).Code);
        Assert.True(File.Exists(Path.Combine(tree.Path, "README.md")));
        Assert.Equal(tree.OriginalBase, await RunGitAsync(repo, ["rev-parse", "refs/heads/" + tree.Branch]));
    }

    [Fact]
    public async Task WorkspaceBranchNames_ConcurrentOwnersWithSamePurposeHaveIndependentRefs()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var trees = await Task.WhenAll(new[] { "one", "two" }.Select(session =>
            service.PrepareAsync(WorkspaceTestOwner(f, session), WorkspaceRequest(session) with { Name = "Same purpose" }, default)));
        Assert.NotEqual(trees[0].Branch, trees[1].Branch);
        Assert.All(trees, tree => Assert.StartsWith("hosty/same-purpose-", tree.Branch));
        foreach (var tree in trees)
            Assert.Equal(tree.Branch, await RunGitAsync(tree.Path, ["branch", "--show-current"]));
    }

    [Fact]
    public async Task WorkspaceBranchNames_InterruptedCleanupPreservesSymbolicBranchAndItsTarget()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var repo = service.RepositoryPath(tree.Repository);
        await RunGitAsync(repo, ["worktree", "remove", tree.Path]);
        await RunGitAsync(repo, ["update-ref", "refs/heads/unrelated", tree.OriginalBase]);
        await RunGitAsync(repo, ["symbolic-ref", "refs/heads/" + tree.Branch, "refs/heads/unrelated"]);
        var command = new WorkspaceCommand(Guid.NewGuid().ToString(), tree.OriginalBase);
        var operation = new WorkspaceOperation(command.RequestId, "cleanup",
            DevelopmentWorkspaceService.Hash(CoreJson.Text(command)), "pending", tree.OriginalBase);
        await JsonStorage.WriteAsync(BranchRecord(f, tree), tree with { State = "releasing", Operations = [.. tree.Operations, operation] });
        var before = await RunGitAsync(repo, ["for-each-ref", "--format=%(refname) %(objectname) %(symref)"]);
        Assert.Equal("workspace_ownership_invalid", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock).CommandAsync(tree.Id, owner, "cleanup", command, default))).Code);
        Assert.Equal(before, await RunGitAsync(repo, ["for-each-ref", "--format=%(refname) %(objectname) %(symref)"]));
    }
}
