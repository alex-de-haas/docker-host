using System.Security.Cryptography;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private sealed record DiscardFixture(LifecycleFixture F, string Origin, DevelopmentWorkspaceService Service,
        WorkspaceOwner Owner, DevelopmentWorkspace Tree) : IDisposable
    {
        public void Dispose()
        {
            // Every path in this fixture belongs to a newly allocated temporary test data root.
            try { Directory.Delete(F.Root, recursive: true); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        }
    }

    private static async Task<DiscardFixture> DiscardFixtureAsync(bool external = false, LocalCommandProcessRegistry? processes = null)
    {
        // Linked-worktree Git metadata also includes the allocation ID; Windows fixtures
        // need the existing short-root option before they can exercise physical cleanup.
        var (f, origin) = await SourceFixtureAsync(shortPaths: true);
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, processes);
        var owner = external ? ExternalOwner() : WorkspaceTestOwner(f);
        var input = (external ? ExternalPrepare() : WorkspaceRequest()) with { Name = "Unwanted test work" };
        var tree = await service.PrepareAsync(owner, input, default);
        if (external) tree = await service.CommandAsync(tree.Id, owner, "release-lease", new(Guid.NewGuid().ToString(), LeaseId: input.LeaseId), default);
        return new(f, origin, service, owner, tree);
    }

    private static WorkspaceDiscardApply DiscardInput(WorkspaceDiscardPlan plan)
        => new(Guid.NewGuid().ToString(), plan.Revision, plan.Digest, plan.Name);

    private static string DiscardRepo(DiscardFixture fixture, DevelopmentWorkspace tree)
        => Path.Combine(fixture.F.Paths.CoreRoot, "development", "repositories", tree.RepositoryId + ".git");

    private static async Task<DevelopmentWorkspace> AdditionalDiscardTree(DiscardFixture fixture)
    {
        var app = (await fixture.F.Apps.GetAppAsync(SourceTestApp))!;
        var repository = await CreateGitRepositoryAsync(Path.Combine(fixture.F.Root, "additional-source"));
        await fixture.F.Apps.UpsertAppAsync(app with { Id = "example.discard-other", SourceState = app.SourceState! with { Repository = repository, LocalOverridePath = repository } });
        var input = (fixture.Owner.IsExternal ? ExternalPrepare() : WorkspaceRequest()) with { AppId = "example.discard-other" };
        var tree = await fixture.Service.PrepareAsync(fixture.Owner, input, default);
        if (fixture.Owner.IsExternal) tree = await fixture.Service.CommandAsync(tree.Id, fixture.Owner, "release-lease", new(Guid.NewGuid().ToString(), LeaseId: input.LeaseId), default);
        return tree;
    }

    private static async Task AddDiscardableSource(DevelopmentWorkspace tree)
    {
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "committed.txt"), "unmerged local work\n");
        await File.WriteAllTextAsync(Path.Combine(tree.Path, ".gitignore"), "cache/\n");
        await RunGitAsync(tree.Path, ["add", "committed.txt", ".gitignore"]);
        await RunGitAsync(tree.Path, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Unmerged local test work"]);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "README.md"), "unfinished tracked source\n");
        await File.WriteAllBytesAsync(Path.Combine(tree.Path, "untracked.bin"), [0, 1, 255, 8]);
        Directory.CreateDirectory(Path.Combine(tree.Path, "cache"));
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "cache", "ignored.txt"), "ignored build output\n");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WorkspaceDiscard_RemovesReviewedDirtyUntrackedIgnoredAndUnmergedSourceWithoutOriginalAgent(bool external)
    {
        using var f = await DiscardFixtureAsync(external);
        var second = await AdditionalDiscardTree(f);
        foreach (var tree in new[] { f.Tree, second }) await AddDiscardableSource(tree);
        var unrelatedOwner = f.Owner.IsExternal ? ExternalOwner("keep-task") : WorkspaceTestOwner(f.F, "keep-session");
        var unrelatedInput = f.Owner.IsExternal ? ExternalPrepare("keep-task") : WorkspaceRequest("keep-session");
        var unrelated = await f.Service.PrepareAsync(unrelatedOwner, unrelatedInput, default);
        await File.WriteAllTextAsync(Path.Combine(unrelated.Path, "keep.txt"), "other work remains");
        var appBefore = CoreJson.Text((await f.F.Apps.GetAppAsync(SourceTestApp))!);
        var appData = Path.Combine(f.F.Paths.AppsRoot, SourceTestApp, "data", "keep.txt");
        Directory.CreateDirectory(Path.GetDirectoryName(appData)!);
        await File.WriteAllTextAsync(appData, "ordinary application data remains");
        var root = Path.Combine(f.F.Paths.CoreRoot, "development");
        foreach (var tree in new[] { f.Tree, second })
        {
            foreach (var folder in new[] { "publications", "publications/external", "publications/review-operations" })
            {
                var file = Path.Combine(root, folder, tree.Id + ".json");
                Directory.CreateDirectory(Path.GetDirectoryName(file)!);
                await File.WriteAllTextAsync(file, "private workspace publication metadata");
            }
        }
        var plan = await f.Service.PrepareDiscardAsync(f.Owner, "admin", [], default);
        Assert.Empty(plan.Blockers);
        Assert.Equal(2, plan.Trees.Length);
        Assert.All(plan.Trees, tree => {
            Assert.Contains("README.md", tree.ChangedFiles);
            Assert.Contains("untracked.bin", tree.UntrackedFiles);
            Assert.Contains("cache/", tree.IgnoredFiles);
            Assert.Equal(1, tree.UnmergedCommits);
        });
        Assert.Equal("Unwanted test work", plan.Name);
        var command = DiscardInput(plan);
        await f.Service.AdmitDiscardAsync(f.Owner, "admin", command, [], default);
        Assert.Equal("deleting", (await f.Service.WorkflowAsync(f.Owner, default)).State);
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.PrepareAsync(f.Owner,
            f.Owner.IsExternal ? ExternalPrepare() : WorkspaceRequest(), default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.WithResourceContextAsync(new("admin"),
            new(WorkspaceId: f.Tree.WorkspaceId), () => Task.FromResult(true), default));
        await f.Service.FinishDiscardAsync(f.Owner, "admin", command, default);
        var restarted = new DevelopmentWorkspaceService(f.F.Paths, f.F.Apps, f.F.Clock);
        await restarted.FinishDiscardAsync(f.Owner, "admin", command, default);
        Assert.Empty((await restarted.ListAsync(f.Owner, true, default)).Workspaces);
        Assert.DoesNotContain((await new WorkspaceInspectionService(restarted, f.F.Apps, f.F.Clock).ListAsync("admin", default)).Workspaces, w => w.Id == f.Tree.WorkspaceId);
        foreach (var tree in new[] { f.Tree, second })
        {
            Assert.False(Directory.Exists(tree.Path));
            var repo = DiscardRepo(f, tree);
            Assert.DoesNotContain("refs/heads/" + tree.Branch, await RunGitAsync(repo, ["show-ref"]));
            var registration = await RunGitAsync(repo, ["worktree", "list", "--porcelain"]);
            Assert.DoesNotContain("worktree " + tree.Path, registration);
            Assert.DoesNotContain("branch refs/heads/" + tree.Branch, registration);
            Assert.False(File.Exists(Path.Combine(root, "workspaces", tree.Id + ".json")));
            foreach (var folder in new[] { "publications", "publications/external", "publications/review-operations" })
                Assert.False(File.Exists(Path.Combine(root, folder, tree.Id + ".json")));
            Assert.True(Directory.Exists(repo)); // Shared objects are outside the destructive scope.
        }
        Assert.True(await restarted.SessionWorkspaceAbsentAsync(f.Owner, default));
        Assert.Equal("source", await File.ReadAllTextAsync(Path.Combine(f.Origin, "README.md")));
        Assert.Equal("other work remains", await File.ReadAllTextAsync(Path.Combine(unrelated.Path, "keep.txt")));
        Assert.Equal(appBefore, CoreJson.Text((await f.F.Apps.GetAppAsync(SourceTestApp))!));
        Assert.Equal("ordinary application data remains", await File.ReadAllTextAsync(appData));
        Assert.Null(await restarted.ReadDeletionAsync(f.Tree.WorkspaceId, default));
        Assert.Null(await restarted.ReadMetadataAsync(f.Owner, default));
        var receipt = (await restarted.ReadDiscardAsync(f.Tree.WorkspaceId, command.RequestId, "admin", default))!;
        Assert.Equal("removed", receipt.State);
        Assert.Null(receipt.Owner); Assert.Null(receipt.Plan); Assert.Null(receipt.Snapshots); Assert.Empty(receipt.Cleanup);
        Assert.All(receipt.Trees, item => Assert.Equal("removed", item.State));
        var persistedReceipt = CoreJson.Text(receipt);
        Assert.DoesNotContain(f.Tree.Path, persistedReceipt);
        Assert.DoesNotContain("unfinished tracked source", persistedReceipt);
        Assert.False(File.Exists(Path.Combine(root, "discards", "reviews", command.Digest + ".json")));
        Assert.Empty(Directory.EnumerateFiles(Path.Combine(root, "workflows"), "*.json"));
    }

    [Theory]
    [InlineData("tracked")]
    [InlineData("untracked")]
    [InlineData("ignored")]
    [InlineData("new-untracked")]
    [InlineData("new-ignored")]
    [InlineData("index")]
    public async Task WorkspaceDiscard_ChangedSourceInvalidatesReviewEvenWithUnchangedHead(string kind)
    {
        using var f = await DiscardFixtureAsync();
        await AddDiscardableSource(f.Tree);
        var plan = await f.Service.PrepareDiscardAsync(f.Owner, "admin", [], default);
        var head = await RunGitAsync(f.Tree.Path, ["rev-parse", "HEAD"]);
        var relative = kind switch {
            "tracked" => "README.md", "untracked" => "untracked.bin", "ignored" => "cache/ignored.txt",
            "new-untracked" => "new.txt", "new-ignored" => "cache/new.txt", _ => "README.md" };
        var file = Path.Combine(f.Tree.Path, relative);
        if (kind == "index") await RunGitAsync(f.Tree.Path, ["add", "README.md"]);
        else await File.AppendAllTextAsync(file, "new bytes after operator review");
        var bytes = File.ReadAllBytes(file);
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.AdmitDiscardAsync(f.Owner, "admin", DiscardInput(plan), [], default));
        Assert.Equal("workspace_discard_review_changed", error.Code);
        Assert.Equal(head, await RunGitAsync(f.Tree.Path, ["rev-parse", "HEAD"]));
        Assert.Equal(bytes, File.ReadAllBytes(file));
        Assert.Equal("in-progress", (await f.Service.WorkflowAsync(f.Owner, default)).State);
    }

    [Theory]
    [InlineData("name")]
    [InlineData("revision")]
    [InlineData("expired")]
    [InlineData("renamed")]
    [InlineData("repository-set")]
    [InlineData("head")]
    public async Task WorkspaceDiscard_RejectsUnconfirmedExpiredOrChangedReviewsBeforeAdmission(string change)
    {
        using var f = await DiscardFixtureAsync();
        await AddDiscardableSource(f.Tree);
        var plan = await f.Service.PrepareDiscardAsync(f.Owner, "admin", [], default);
        var command = DiscardInput(plan);
        if (change == "name") command = command with { ConfirmationName = "not the reviewed workspace" };
        if (change == "revision") command = command with { ExpectedRevision = plan.Revision + 1 };
        if (change == "expired") f.F.Clock.UtcNow = plan.ExpiresAt.AddSeconds(1);
        if (change == "renamed") await f.Service.RenameAsync(f.Owner, new(Guid.NewGuid().ToString(), "Another name"), default);
        if (change == "repository-set") await AdditionalDiscardTree(f);
        if (change == "head")
        {
            await RunGitAsync(f.Tree.Path, ["add", "README.md"]);
            await RunGitAsync(f.Tree.Path, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Later commit"]);
        }
        var before = File.ReadAllBytes(Path.Combine(f.Tree.Path, "README.md"));
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.AdmitDiscardAsync(f.Owner, "admin", command, [], default));
        Assert.Equal(before, File.ReadAllBytes(Path.Combine(f.Tree.Path, "README.md")));
        Assert.Equal("in-progress", (await f.Service.WorkflowAsync(f.Owner, default)).State);
    }

    [Theory]
    [InlineData("lease")]
    [InlineData("pending-operation")]
    [InlineData("unknown-operation")]
    [InlineData("sandbox")]
    [InlineData("source")]
    [InlineData("native")]
    [InlineData("unknown-native")]
    [InlineData("core-transition")]
    public async Task WorkspaceDiscard_DoesNotBypassLiveOrUnknownConsumers(string kind)
    {
        var processes = new LocalCommandProcessRegistry();
        using var f = await DiscardFixtureAsync(external: true, processes);
        await AddDiscardableSource(f.Tree);
        var tree = f.Tree;
        if (kind == "lease") await f.Service.CommandAsync(tree.Id, f.Owner, "lease", new(Guid.NewGuid().ToString(), LeaseId: Guid.NewGuid().ToString()), default);
        if (kind == "sandbox") await f.Service.SetSandboxConsumerAsync(tree.Id, Guid.NewGuid().ToString("N"), true, default);
        if (kind.EndsWith("operation", StringComparison.Ordinal))
            await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development", "workspaces", tree.Id + ".json"),
                tree with { Operations = [.. tree.Operations, new(Guid.NewGuid().ToString(), "commit", "arguments", kind.StartsWith("pending", StringComparison.Ordinal) ? "pending" : "unknown")] });
        if (kind == "source")
        {
            var app = (await f.F.Apps.GetAppAsync(SourceTestApp))!;
            await f.F.Apps.UpsertAppAsync(app with { SourceState = app.SourceState! with { LocalOverridePath = tree.Path } });
        }
        using var process = System.Diagnostics.Process.GetCurrentProcess();
        if (kind == "native") processes.Set(SourceTestApp, "fixture", new(process, "unused", tree.Path, new Dictionary<string, int>(), false, null));
        if (kind == "unknown-native") processes.Block(SourceTestApp, "Unverified process identity");
        if (kind == "core-transition") Haas.Hosty.Launch.WorkspaceRuntimeFiles.Save(f.F.Paths.DataRoot,
            new Haas.Hosty.Launch.WorkspaceRuntimeActivation(Guid.NewGuid().ToString(), tree.WorkspaceId, f.Owner.UserId, "review", "instance", "revision", tree.Id,
                Path.Combine(tree.Path, "Core.csproj"), new("release", null, null, 1, f.F.Clock.UtcNow), [], "core-starting"));
        var expected = SHA256.HashData(File.ReadAllBytes(Path.Combine(tree.Path, "README.md")));
        var plan = await f.Service.PrepareDiscardAsync(f.Owner, "admin", [], default);
        Assert.NotEmpty(plan.Blockers);
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.AdmitDiscardAsync(f.Owner, "admin", DiscardInput(plan), [], default));
        Assert.Equal(expected, SHA256.HashData(File.ReadAllBytes(Path.Combine(tree.Path, "README.md"))));
        Assert.True(Directory.Exists(tree.Path));
        Assert.Equal("in-progress", (await f.Service.WorkflowAsync(f.Owner, default)).State);
    }

    [Fact]
    public async Task WorkspaceDiscard_CannotApplyAnotherUsersReviewOrChangeAdmittedRequestArguments()
    {
        using var f = await DiscardFixtureAsync(external: true);
        await AddDiscardableSource(f.Tree);
        var plan = await f.Service.PrepareDiscardAsync(f.Owner, "admin", [], default);
        var command = DiscardInput(plan);
        Assert.Empty((await f.Service.PrepareDiscardAsync(f.Owner, "another-admin", [], default)).Blockers);
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.AdmitDiscardAsync(f.Owner, "another-admin", command, [], default));
        await f.Service.AdmitDiscardAsync(f.Owner, "admin", command, [], default);
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.AdmitDiscardAsync(f.Owner, "admin", command with { RequestId = Guid.NewGuid().ToString() }, [], default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.AdmitDiscardAsync(f.Owner, "admin", command with { Digest = new string('0', 64) }, [], default));
        Assert.Equal("removed", (await f.Service.FinishDiscardAsync(f.Owner, "another-admin", command, default)).State);
        Assert.Equal("removed", (await f.Service.FinishDiscardAsync(f.Owner, "admin", command, default)).State);
    }

    [Theory]
    [InlineData("complete")]
    [InlineData("delete")]
    public async Task WorkspaceDiscard_DoesNotWeakenOrdinaryDirtyAndUnmergedWorkflowProtection(string action)
    {
        using var f = await DiscardFixtureAsync();
        if (action == "delete") await f.Service.ChangeWorkflowAsync(f.Owner, "admin", "complete", new(Guid.NewGuid().ToString(), 0), new Dictionary<string, string>(), default);
        await File.WriteAllTextAsync(Path.Combine(f.Tree.Path, "README.md"), "unfinished source");
        var revision = (await f.Service.WorkflowAsync(f.Owner, default)).Revision;
        var input = new WorkspaceWorkflowCommand(Guid.NewGuid().ToString(), revision);
        Assert.Equal("workspace_dirty", (await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.ChangeWorkflowAsync(f.Owner, "admin", action, input, new Dictionary<string, string>(), default))).Code);
        await RunGitAsync(f.Tree.Path, ["add", "README.md"]);
        await RunGitAsync(f.Tree.Path, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Unmerged work"]);
        Assert.Equal("workspace_unmerged", (await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.ChangeWorkflowAsync(f.Owner, "admin", action, input with { RequestId = Guid.NewGuid().ToString() }, new Dictionary<string, string>(), default))).Code);
        Assert.Equal("unfinished source", await File.ReadAllTextAsync(Path.Combine(f.Tree.Path, "README.md")));
        Assert.True(Directory.Exists(f.Tree.Path));
    }

    [Fact]
    public async Task WorkspaceDiscard_RevalidatesDirtyBytesAfterAdmissionBeforeTheFirstRemoval()
    {
        using var f = await DiscardFixtureAsync();
        await AddDiscardableSource(f.Tree);
        var plan = await f.Service.PrepareDiscardAsync(f.Owner, "admin", [], default);
        var command = DiscardInput(plan);
        await f.Service.AdmitDiscardAsync(f.Owner, "admin", command, [], default);
        await File.AppendAllTextAsync(Path.Combine(f.Tree.Path, "README.md"), "later native edit");
        var bytes = File.ReadAllBytes(Path.Combine(f.Tree.Path, "README.md"));
        Assert.Equal("workspace_discard_review_changed", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.FinishDiscardAsync(f.Owner, "admin", command, default))).Code);
        Assert.Equal(bytes, File.ReadAllBytes(Path.Combine(f.Tree.Path, "README.md")));
        Assert.Equal("review-required", (await f.Service.ReadDiscardAsync(f.Tree.WorkspaceId, command.RequestId, "admin", default))!.State);
        var refreshed = await f.Service.PrepareDiscardAsync(f.Owner, "admin", [], default);
        Assert.Empty(refreshed.Blockers);
        var freshCommand = DiscardInput(refreshed);
        Assert.NotEqual(command.Digest, freshCommand.Digest);
        await f.Service.AdmitDiscardAsync(f.Owner, "admin", freshCommand, [], default);
        Assert.Equal("removed", (await f.Service.FinishDiscardAsync(f.Owner, "admin", freshCommand, default)).State);
        Assert.False(Directory.Exists(f.Tree.Path));
        var oldReceipt = (await f.Service.ReadDiscardAsync(f.Tree.WorkspaceId, command.RequestId, "admin", default))!;
        Assert.Null(oldReceipt.Owner); Assert.Null(oldReceipt.Plan); Assert.Null(oldReceipt.Snapshots); Assert.Empty(oldReceipt.Cleanup);
        Assert.DoesNotContain(f.Tree.Path, CoreJson.Text(oldReceipt));
        Assert.False(File.Exists(Path.Combine(f.F.Paths.CoreRoot, "development", "discards", "reviews", command.Digest + ".json")));
    }

    [Fact]
    public async Task WorkspaceDiscard_RestartsBetweenRepositoryRemovalsUsingOriginalRequestAndPerTreeProgress()
    {
        using var f = await DiscardFixtureAsync();
        var second = await AdditionalDiscardTree(f);
        foreach (var tree in new[] { f.Tree, second }) await AddDiscardableSource(tree);
        var plan = await f.Service.PrepareDiscardAsync(f.Owner, "admin", [], default);
        var command = DiscardInput(plan);
        await f.Service.AdmitDiscardAsync(f.Owner, "admin", command, [], default);
        var blocked = new[] { f.Tree, second }.Single(t => t.Id == plan.Trees[1].Id);
        var first = new[] { f.Tree, second }.Single(t => t.Id == plan.Trees[0].Id);
        var branchLock = Path.Combine(DiscardRepo(f, blocked), "refs", "heads", blocked.Branch + ".lock");
        Directory.CreateDirectory(Path.GetDirectoryName(branchLock)!);
        await File.WriteAllTextAsync(branchLock, "simulated interrupted Git writer");
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.FinishDiscardAsync(f.Owner, "admin", command, default));
        Assert.False(Directory.Exists(first.Path));
        var interrupted = (await f.Service.ReadDiscardAsync(first.WorkspaceId, command.RequestId, "admin", default))!;
        Assert.Equal("pending", interrupted.State);
        Assert.Equal("removed", interrupted.Trees.Single(t => t.Id == first.Id).State);
        Assert.Equal("pending", interrupted.Trees.Single(t => t.Id == blocked.Id).State);
        Assert.Contains("refs/heads/" + blocked.Branch, await RunGitAsync(DiscardRepo(f, blocked), ["show-ref"]));
        File.Delete(branchLock);
        var restarted = new DevelopmentWorkspaceService(f.F.Paths, f.F.Apps, f.F.Clock);
        Assert.Equal("removed", (await restarted.FinishDiscardAsync(f.Owner, "admin", command, default)).State);
        Assert.Equal("removed", (await restarted.FinishDiscardAsync(f.Owner, "admin", command, default)).State);
        Assert.Empty((await restarted.ListAsync(f.Owner, true, default)).Workspaces);
        foreach (var tree in new[] { first, blocked })
        {
            Assert.False(Directory.Exists(tree.Path));
            Assert.DoesNotContain("refs/heads/" + tree.Branch, await RunGitAsync(DiscardRepo(f, tree), ["show-ref"]));
        }
    }

    [Fact]
    public async Task WorkspaceDiscard_RecoversAfterSomeFinalMetadataRecordsHaveAlreadyBeenRemoved()
    {
        using var f = await DiscardFixtureAsync();
        var second = await AdditionalDiscardTree(f);
        foreach (var tree in new[] { f.Tree, second }) await AddDiscardableSource(tree);
        var records = (await f.Service.ListAsync(f.Owner, true, default)).Workspaces;
        string CachePath(DevelopmentWorkspace tree) => Path.Combine(f.F.Paths.CoreRoot, "development", "publications", "external", tree.Id + ".json");
        // Atomic record rewrites during discard can change filesystem enumeration order.
        // Stop before any metadata removal, then use the durable journal's cleanup order.
        foreach (var tree in records) Directory.CreateDirectory(CachePath(tree));
        var plan = await f.Service.PrepareDiscardAsync(f.Owner, "admin", [], default);
        var command = DiscardInput(plan);
        await f.Service.AdmitDiscardAsync(f.Owner, "admin", command, [], default);
        await Assert.ThrowsAsync<UnauthorizedAccessException>(() => f.Service.FinishDiscardAsync(f.Owner, "admin", command, default));
        Assert.False(Directory.Exists(f.Tree.Path)); Assert.False(Directory.Exists(second.Path));
        var deletion = Assert.IsType<WorkspaceDeletionJournal>(await f.Service.ReadDeletionAsync(f.Tree.WorkspaceId, default));
        Assert.Equal(2, deletion.Worktrees.Length);
        Assert.Equal(2, (await f.Service.ListAsync(f.Owner, true, default)).Workspaces.Length);
        Directory.Delete(CachePath(deletion.Worktrees[0]));
        await Assert.ThrowsAsync<UnauthorizedAccessException>(() => f.Service.FinishDiscardAsync(f.Owner, "admin", command, default));
        var remaining = Assert.Single((await f.Service.ListAsync(f.Owner, true, default)).Workspaces);
        Assert.Equal(deletion.Worktrees[1].Id, remaining.Id);
        Directory.Delete(CachePath(deletion.Worktrees[1]));
        var restarted = new DevelopmentWorkspaceService(f.F.Paths, f.F.Apps, f.F.Clock);
        Assert.Equal("removed", (await restarted.FinishDiscardAsync(f.Owner, "admin", command, default)).State);
        Assert.Empty((await restarted.ListAsync(f.Owner, true, default)).Workspaces);
        Assert.Null(await restarted.ReadDeletionAsync(f.Tree.WorkspaceId, default));
    }

    [Theory]
    [InlineData("pipe")]
    [InlineData("cache/pipe")]
    public async Task WorkspaceDiscard_SpecialFilesBlockReviewWithoutOpeningOrRemovingSource(string relativePath)
    {
        if (OperatingSystem.IsWindows()) return;
        using var f = await DiscardFixtureAsync();
        await AddDiscardableSource(f.Tree);
        var readme = Path.Combine(f.Tree.Path, "README.md");
        var before = await File.ReadAllBytesAsync(readme);
        var specialFile = Path.Combine(f.Tree.Path, relativePath);
        var start = new System.Diagnostics.ProcessStartInfo("mkfifo");
        start.ArgumentList.Add(specialFile);
        Assert.Equal(0, (await ProcessRunner.RunAsync(start, TimeSpan.FromSeconds(5), default)).ExitCode);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));

        var plan = await Task.Run(() => f.Service.PrepareDiscardAsync(f.Owner, "admin", [], timeout.Token))
            .WaitAsync(timeout.Token);

        Assert.Contains(plan.Blockers, blocker => blocker.Contains("Only regular source files", StringComparison.Ordinal));
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.AdmitDiscardAsync(f.Owner, "admin", DiscardInput(plan), [], timeout.Token));
        Assert.Equal("workspace_discard_blocked", error.Code);
        Assert.Equal(before, await File.ReadAllBytesAsync(readme));
        Assert.True(File.Exists(specialFile));
        Assert.Equal("in-progress", (await f.Service.WorkflowAsync(f.Owner, timeout.Token)).State);
        File.Delete(specialFile);
        Assert.Empty((await f.Service.PrepareDiscardAsync(f.Owner, "admin", [], timeout.Token)).Blockers);
    }

    [Fact]
    public async Task WorkspaceDiscard_NestedRepositoryIsExplicitlyBlockedAndPreserved()
    {
        using var f = await DiscardFixtureAsync();
        var nested = await CreateGitRepositoryAsync(Path.Combine(f.Tree.Path, "nested"));
        var before = File.ReadAllBytes(Path.Combine(nested, "README.md"));
        var plan = await f.Service.PrepareDiscardAsync(f.Owner, "admin", [], default);
        Assert.Contains(plan.Blockers, blocker => blocker.Contains("Nested Git", StringComparison.OrdinalIgnoreCase));
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.AdmitDiscardAsync(f.Owner, "admin", DiscardInput(plan), [], default));
        Assert.Equal(before, File.ReadAllBytes(Path.Combine(nested, "README.md")));
        Assert.True(Directory.Exists(f.Tree.Path));
    }


    [Theory]
    [InlineData("revision")]
    [InlineData("state")]
    [InlineData("data-path")]
    [InlineData("set")]
    public async Task WorkspaceDiscard_ResourceEvidenceChangesInvalidateReviewBeforeAdmission(string change)
    {
        using var f = await DiscardFixtureAsync();
        var resource = new WorkspaceDiscardResource(Guid.NewGuid().ToString("N"), "sandbox", "Disposable test data",
            Path.Combine(f.F.Root, "owned-sandbox-data"), "stopped", 2);
        var plan = await f.Service.PrepareDiscardAsync(f.Owner, "admin", [resource], default);
        var current = change switch {
            "revision" => new[] { resource with { Revision = 3 } },
            "state" => [resource with { State = "running" }],
            "data-path" => [resource with { DataPath = Path.Combine(f.F.Root, "different-data") }],
            _ => Array.Empty<WorkspaceDiscardResource>() };
        Assert.Equal("workspace_discard_review_changed", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.AdmitDiscardAsync(f.Owner, "admin", DiscardInput(plan), current, default))).Code);
        Assert.True(Directory.Exists(f.Tree.Path));
        Assert.Equal("in-progress", (await f.Service.WorkflowAsync(f.Owner, default)).State);
    }

    [Fact]
    public async Task WorkspaceDiscard_RetainsResourceRequestIdsOnReplayAndCannotRemoveSourceBeforeOwnedDataFinishes()
    {
        using var f = await DiscardFixtureAsync();
        var resource = new WorkspaceDiscardResource(Guid.NewGuid().ToString("N"), "sandbox", "Disposable test data",
            Path.Combine(f.F.Root, "owned-sandbox-data"), "stopped", 2);
        var plan = await f.Service.PrepareDiscardAsync(f.Owner, "admin", [resource], default);
        var command = DiscardInput(plan);
        var journal = await f.Service.AdmitDiscardAsync(f.Owner, "admin", command, [resource], default);
        var restarted = new DevelopmentWorkspaceService(f.F.Paths, f.F.Apps, f.F.Clock);
        var replay = await restarted.AdmitDiscardAsync(f.Owner, "admin", command, [resource], default);
        Assert.Equal(journal.Cleanup, replay.Cleanup);
        Assert.Single(replay.Cleanup);
        Assert.Equal("workspace_cleanup_pending", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            restarted.FinishDiscardAsync(f.Owner, "admin", command, default))).Code);
        Assert.True(Directory.Exists(f.Tree.Path));
    }

    [Fact]
    public async Task WorkspaceDiscard_ReplacedOwnedPathIsRefusedWithoutDeletingReplacementOrOriginalBytes()
    {
        using var f = await DiscardFixtureAsync();
        await AddDiscardableSource(f.Tree);
        var plan = await f.Service.PrepareDiscardAsync(f.Owner, "admin", [], default);
        var moved = f.Tree.Path + "-original";
        Directory.Move(f.Tree.Path, moved);
        Directory.CreateDirectory(f.Tree.Path);
        await File.WriteAllTextAsync(Path.Combine(f.Tree.Path, "replacement.txt"), "unexpected replacement");
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.AdmitDiscardAsync(f.Owner, "admin", DiscardInput(plan), [], default));
        Assert.Equal("unexpected replacement", await File.ReadAllTextAsync(Path.Combine(f.Tree.Path, "replacement.txt")));
        Assert.Equal("unfinished tracked source\n", await File.ReadAllTextAsync(Path.Combine(moved, "README.md")));
    }

    [Fact]
    public async Task WorkspaceDiscard_RemovesOwnedSymlinkWithoutTraversingOrRemovingExternalData()
    {
        if (OperatingSystem.IsWindows()) return; // Matches the repository's symlink fixture contract.
        using var f = await DiscardFixtureAsync();
        var outside = Path.Combine(f.F.Root, "unrelated-data");
        Directory.CreateDirectory(outside);
        await File.WriteAllTextAsync(Path.Combine(outside, "keep.txt"), "outside data remains");
        Directory.CreateSymbolicLink(Path.Combine(f.Tree.Path, "linked-data"), outside);
        var plan = await f.Service.PrepareDiscardAsync(f.Owner, "admin", [], default);
        Assert.Empty(plan.Blockers);
        var command = DiscardInput(plan);
        await f.Service.AdmitDiscardAsync(f.Owner, "admin", command, [], default);
        await f.Service.FinishDiscardAsync(f.Owner, "admin", command, default);
        Assert.False(Directory.Exists(f.Tree.Path));
        Assert.Equal("outside data remains", await File.ReadAllTextAsync(Path.Combine(outside, "keep.txt")));
    }


    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WorkspaceDiscard_OwnedResourceFailureRetainsSourceAndDataThenResumesOriginalCleanupRequests(bool sourceDrift)
    {
        using var f = await DiscardFixtureAsync(external: true);
        await AddDiscardableSource(f.Tree);
        var store = new CoreEnvironmentStore(f.F.Paths);
        var runtime = new ResourceControlRuntime();
        var environments = new CoreEnvironmentService(store, runtime, f.F.Clock, f.Service);
        WorkspaceCleanupService Controls(DevelopmentWorkspaceService workspaces) => new(f.F.Paths,
            new(workspaces, f.F.Apps, f.F.Clock), workspaces, null!, f.F.Apps, store, environments,
            new(store, environments));
        var app = (await f.F.Apps.GetAppAsync(SourceTestApp))!;
        await f.F.Apps.UpsertAppAsync(app with { GrantedCorePermissions = [CoreAppPermissions.Sources,
            CoreAppPermissions.CoreEnvironmentsRead, CoreAppPermissions.CoreEnvironmentsManage] });
        var actor = new SandboxActor("admin");
        var child = await environments.CreateAsync(actor, new(Guid.NewGuid().ToString(), "Discarded child data",
            Context: new(WorkspaceId: f.Tree.WorkspaceId), WorktreeIds: [f.Tree.Id]), default);
        var unrelated = await environments.CreateAsync(actor, new(Guid.NewGuid().ToString(), "Unrelated retained data"), default);
        var childData = Path.Combine(child.DataRoot!, "sentinel.txt");
        var unrelatedData = Path.Combine(unrelated.DataRoot!, "sentinel.txt");
        await File.WriteAllTextAsync(childData, "owned child data");
        await File.WriteAllTextAsync(unrelatedData, "unrelated data remains");
        var controls = Controls(f.Service);
        var plan = await controls.PrepareDiscardAsync(f.Tree.WorkspaceId, "admin", SourceTestApp, default);
        Assert.Empty(plan.Blockers);
        Assert.Single(plan.Resources);
        Assert.Contains(plan.Resources, item => item.Id == child.Id && item.DataPath == child.DataRoot);
        var command = DiscardInput(plan);
        runtime.FailStop = true;
        var pending = await controls.ApplyDiscardAsync(f.Tree.WorkspaceId, "admin", SourceTestApp, command, default);
        Assert.Equal("pending", pending.State);
        Assert.NotNull(pending.Error);
        Assert.True(File.Exists(childData));
        Assert.True(Directory.Exists(f.Tree.Path));
        var admitted = (await f.Service.ReadDiscardAsync(f.Tree.WorkspaceId, command.RequestId, "admin", default))!;
        Assert.Single(admitted.Cleanup);
        runtime.FailStop = false;
        var restarted = new DevelopmentWorkspaceService(f.F.Paths, f.F.Apps, f.F.Clock);
        if (sourceDrift)
        {
            await File.AppendAllTextAsync(Path.Combine(f.Tree.Path, "README.md"), "later native source edit");
            var stale = await Controls(restarted).ApplyDiscardAsync(f.Tree.WorkspaceId, "admin", SourceTestApp, command, default);
            Assert.Equal("review-required", stale.State);
            Assert.Equal(0, runtime.Stops);
            Assert.True(File.Exists(childData));
            Assert.True(Directory.Exists(f.Tree.Path));
            var refreshed = await Controls(restarted).PrepareDiscardAsync(f.Tree.WorkspaceId, "admin", SourceTestApp, default);
            Assert.Empty(refreshed.Blockers);
            command = DiscardInput(refreshed);
        }
        var result = await Controls(restarted).ApplyDiscardAsync(f.Tree.WorkspaceId, "admin", SourceTestApp, command, default);
        Assert.Equal("removed", result.State);
        Assert.False(Directory.Exists(f.Tree.Path));
        Assert.False(File.Exists(childData));
        Assert.False(Directory.Exists(child.DataRoot));
        Assert.Equal("finished", (await environments.ReadAsync(actor, child.Id, default)).State);
        Assert.Equal("unrelated data remains", await File.ReadAllTextAsync(unrelatedData));
        Assert.Equal("source", await File.ReadAllTextAsync(Path.Combine(f.Origin, "README.md")));
        var childRecord = (await store.ReadAsync(child.Id, default))!;
        Assert.Contains(childRecord.Operations!, item => item.Id == CoreEnvironmentService.RequestId(admitted.Cleanup.Single(r => r.Id == child.Id).RequestId));
        Assert.Equal("removed", (await Controls(restarted).ApplyDiscardAsync(f.Tree.WorkspaceId, "admin", SourceTestApp, command, default)).State);
    }


    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WorkspaceDiscard_RetainedLocalDeletionDoesNotNeedRemoteProviderCredentials(bool admitted)
    {
        var (fixture, users, access, service, tree, _, _) = await PrivateWorkspaceDocumentFixtureAsync();
        using var f = new DiscardFixture(fixture, tree.Repository, service, tree.Owner, tree);
        var store = new CoreEnvironmentStore(fixture.Paths);
        var environments = new CoreEnvironmentService(store, new ResourceControlRuntime(), fixture.Clock, service);
        var controls = new WorkspaceCleanupService(fixture.Paths, new(service, fixture.Apps, fixture.Clock, privateSources: access),
            service, null!, fixture.Apps, store, environments, new(store, environments));
        await fixture.Apps.UpdateAppAsync(SourceTestApp, app => app with { GrantedCorePermissions = [CoreAppPermissions.Sources] });
        var plan = await controls.PrepareDiscardAsync(tree.WorkspaceId, "admin", SourceTestApp, default);
        Assert.Empty(plan.Blockers);
        var command = DiscardInput(plan);
        if (admitted) await service.AdmitDiscardAsync(tree.Owner, "admin", command, [], default);
        var source = Path.Combine(tree.Path, PlanPath);
        var bytes = File.ReadAllBytes(source);
        await users.UpdateAsync(state => state with { ProviderConnections = [] });
        Assert.Equal("removed", (await controls.ApplyDiscardAsync(tree.WorkspaceId, "admin", SourceTestApp, command, default)).State);
        Assert.False(Directory.Exists(tree.Path));

    }


    [Fact]
    public async Task WorkspaceDiscard_PendingReceiptRemainsDiscoverableAfterTheLastSourceAndWorkflowRecordsDisappear()
    {
        using var f = await DiscardFixtureAsync(external: true);
        await AddDiscardableSource(f.Tree);
        var root = Path.Combine(f.F.Paths.CoreRoot, "development");
        var blockedCache = Path.Combine(root, "publications", "external", f.Tree.Id + ".json");
        Directory.CreateDirectory(blockedCache);
        var plan = await f.Service.PrepareDiscardAsync(f.Owner, "admin", [], default);
        var command = DiscardInput(plan);
        await f.Service.AdmitDiscardAsync(f.Owner, "admin", command, [], default);
        await Assert.ThrowsAsync<UnauthorizedAccessException>(() => f.Service.FinishDiscardAsync(f.Owner, "admin", command, default));
        Directory.Delete(blockedCache);
        // Emulate a crash after final metadata removal but before the minimal discard receipt write.
        await f.Service.FinalizeDeletionAsync(f.Owner, default);
        Assert.Empty((await f.Service.ListAsync(f.Owner, true, default)).Workspaces);
        Assert.Null(await f.Service.ReadDeletionAsync(f.Tree.WorkspaceId, default));
        var restarted = new DevelopmentWorkspaceService(f.F.Paths, f.F.Apps, f.F.Clock);
        var inspection = new WorkspaceInspectionService(restarted, f.F.Apps, f.F.Clock);
        var retained = Assert.Single((await inspection.ListAsync("admin", default)).Workspaces);
        Assert.Equal(f.Tree.WorkspaceId, retained.Id);
        Assert.Contains(retained.Workflow!.Operations!, operation => operation.Id == command.RequestId && operation.Kind == "discard" && operation.State == "pending");
        Assert.Single((await inspection.ListAsync("another-admin", default)).Workspaces);
        await Assert.ThrowsAsync<AppLifecycleException>(() => restarted.PrepareAsync(f.Owner, ExternalPrepare(), default));
        Assert.Equal("removed", (await restarted.FinishDiscardAsync(f.Owner, "admin", command, default)).State);
        Assert.Empty((await inspection.ListAsync("admin", default)).Workspaces);
        Assert.False(Directory.Exists(f.Tree.Path));
        var newInput = ExternalPrepare() with { Name = "Allowed after verified removal" };
        var reallocated = await restarted.PrepareAsync(f.Owner, newInput, default);
        Assert.True(Directory.Exists(reallocated.Path));
        await restarted.CommandAsync(reallocated.Id, f.Owner, "release-lease", new(Guid.NewGuid().ToString(), LeaseId: newInput.LeaseId), default);
    }


    [Fact]
    public async Task WorkspaceDiscard_FreshReviewCanFinishAfterEarlierRepositoryWasAlreadyPhysicallyRemoved()
    {
        using var f = await DiscardFixtureAsync();
        var additional = await AdditionalDiscardTree(f);
        foreach (var tree in new[] { f.Tree, additional }) await AddDiscardableSource(tree);
        var plan = await f.Service.PrepareDiscardAsync(f.Owner, "admin", [], default);
        var command = DiscardInput(plan);
        var admitted = await f.Service.AdmitDiscardAsync(f.Owner, "admin", command, [], default);
        var first = new[] { f.Tree, additional }.Single(t => t.Id == plan.Trees[0].Id);
        var remaining = new[] { f.Tree, additional }.Single(t => t.Id != first.Id);
        // Seed the exact durable boundary after one reviewed tree was removed and the process exited.
        await RunGitAsync(DiscardRepo(f, first), ["worktree", "remove", "--force", first.Path]);
        await RunGitAsync(DiscardRepo(f, first), ["update-ref", "-d", "refs/heads/" + first.Branch, plan.Trees[0].Head!]);
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development", "workspaces", first.Id + ".json"),
            first with { State = "released", Observation = null, Operations = [.. first.Operations,
                new("discard-" + command.RequestId, "discard", command.Digest, "succeeded", plan.Trees[0].Head)] });
        await f.Service.SaveDiscardAsync(admitted with { Trees = admitted.Trees.Select(item => item.Id == first.Id ? item with { State = "removed" } : item).ToArray() });
        await File.AppendAllTextAsync(Path.Combine(remaining.Path, "README.md"), "new unfinished work after interruption");
        var restarted = new DevelopmentWorkspaceService(f.F.Paths, f.F.Apps, f.F.Clock);
        Assert.Equal("workspace_discard_review_changed", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            restarted.FinishDiscardAsync(f.Owner, "admin", command, default))).Code);
        Assert.True(Directory.Exists(remaining.Path));
        var refreshed = await restarted.PrepareDiscardAsync(f.Owner, "admin", [], default);
        Assert.Empty(refreshed.Blockers);
        Assert.Contains(first.Id, refreshed.RemovedTrees!);
        Assert.DoesNotContain(first.Id, refreshed.Trees.Select(tree => tree.Id));
        var fresh = DiscardInput(refreshed);
        await restarted.AdmitDiscardAsync(f.Owner, "admin", fresh, [], default);
        Assert.Equal("removed", (await restarted.FinishDiscardAsync(f.Owner, "admin", fresh, default)).State);
        Assert.Empty((await restarted.ListAsync(f.Owner, true, default)).Workspaces);
        foreach (var request in new[] { command, fresh })
        {
            var receipt = (await restarted.ReadDiscardAsync(f.Tree.WorkspaceId, request.RequestId, "admin", default))!;
            Assert.Null(receipt.Owner); Assert.Null(receipt.Plan); Assert.Null(receipt.Snapshots); Assert.Empty(receipt.Cleanup);
            Assert.DoesNotContain(remaining.Path, CoreJson.Text(receipt));
            Assert.False(File.Exists(Path.Combine(f.F.Paths.CoreRoot, "development", "discards", "reviews", request.Digest + ".json")));
        }
    }

    [Fact]
    public async Task WorkspaceDiscard_RepairsSourceRemovedReceiptBeforeTheDeletedWorkflowWrite()
    {
        using var f = await DiscardFixtureAsync();
        await AddDiscardableSource(f.Tree);
        var root = Path.Combine(f.F.Paths.CoreRoot, "development");
        var blockedCache = Path.Combine(root, "publications", "external", f.Tree.Id + ".json");
        Directory.CreateDirectory(blockedCache);
        var plan = await f.Service.PrepareDiscardAsync(f.Owner, "admin", [], default);
        var command = DiscardInput(plan);
        await f.Service.AdmitDiscardAsync(f.Owner, "admin", command, [], default);
        await Assert.ThrowsAsync<UnauthorizedAccessException>(() => f.Service.FinishDiscardAsync(f.Owner, "admin", command, default));
        Assert.True((await f.Service.ReadDiscardAsync(f.Tree.WorkspaceId, command.RequestId, "admin", default))!.SourceRemoved);
        var workflow = await f.Service.WorkflowAsync(f.Owner, default);
        // The finalizer has not started at the simulated earlier boundary, so its later journal is absent.
        File.Delete(Path.Combine(root, "deletions", f.Tree.WorkspaceId + ".json"));
        await JsonStorage.WriteAsync(Path.Combine(root, "workflows", DevelopmentWorkspaceService.Hash(DevelopmentWorkspaceService.OwnerIdentity(f.Owner)) + ".json"),
            workflow with { State = "deleting", Revision = plan.Revision, Operations = [new(command.RequestId, "discard", plan.Revision, "pending")] });
        Directory.Delete(blockedCache);
        var restarted = new DevelopmentWorkspaceService(f.F.Paths, f.F.Apps, f.F.Clock);
        Assert.Equal("removed", (await restarted.FinishDiscardAsync(f.Owner, "admin", command, default)).State);
        Assert.Empty((await restarted.ListAsync(f.Owner, true, default)).Workspaces);
        Assert.Null(await restarted.ReadDeletionAsync(f.Tree.WorkspaceId, default));
    }


    [Fact]
    public async Task WorkspaceDiscard_InterruptedRemovalNeverFollowsAReplacedSymbolicPrivateBranch()
    {
        using var f = await DiscardFixtureAsync();
        await AddDiscardableSource(f.Tree);
        var plan = await f.Service.PrepareDiscardAsync(f.Owner, "admin", [], default);
        var command = DiscardInput(plan);
        await f.Service.AdmitDiscardAsync(f.Owner, "admin", command, [], default);
        var repo = DiscardRepo(f, f.Tree);
        var reference = "refs/heads/" + f.Tree.Branch;
        var branchLock = Path.Combine(repo, "refs", "heads", f.Tree.Branch + ".lock");
        Directory.CreateDirectory(Path.GetDirectoryName(branchLock)!);
        await File.WriteAllTextAsync(branchLock, "simulated interrupted Git writer");
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.FinishDiscardAsync(f.Owner, "admin", command, default));
        Assert.False(Directory.Exists(f.Tree.Path));
        File.Delete(branchLock);
        var unrelated = "refs/heads/unrelated-kept-work";
        await RunGitAsync(repo, ["update-ref", unrelated, plan.Trees[0].Head!]);
        await RunGitAsync(repo, ["symbolic-ref", reference, unrelated]);
        var restarted = new DevelopmentWorkspaceService(f.F.Paths, f.F.Apps, f.F.Clock);
        await Assert.ThrowsAsync<AppLifecycleException>(() => restarted.FinishDiscardAsync(f.Owner, "admin", command, default));
        Assert.Equal(plan.Trees[0].Head, await RunGitAsync(repo, ["rev-parse", unrelated]));
        Assert.Equal(unrelated, await RunGitAsync(repo, ["symbolic-ref", reference]));
        // Repair only this fixture's reviewed private reference, without following the unexpected link.
        await RunGitAsync(repo, ["update-ref", "--no-deref", reference, plan.Trees[0].Head!]);
        Assert.Equal("removed", (await restarted.FinishDiscardAsync(f.Owner, "admin", command, default)).State);
        Assert.Equal(plan.Trees[0].Head, await RunGitAsync(repo, ["rev-parse", unrelated]));
        Assert.DoesNotContain(reference, await RunGitAsync(repo, ["show-ref"]));
    }


    [Fact]
    public async Task WorkspaceDiscard_OldRemovedRequestCannotCompactANewerReallocationForTheSameOwnerAndTask()
    {
        using var f = await DiscardFixtureAsync();
        await AddDiscardableSource(f.Tree);
        var oldPlan = await f.Service.PrepareDiscardAsync(f.Owner, "admin", [], default);
        var old = DiscardInput(oldPlan);
        await f.Service.AdmitDiscardAsync(f.Owner, "admin", old, [], default);
        Assert.Equal("removed", (await f.Service.FinishDiscardAsync(f.Owner, "admin", old, default)).State);
        var next = await f.Service.PrepareAsync(f.Owner, WorkspaceRequest() with { Name = "New generation of work" }, default);
        Assert.Equal(f.Tree.Id, next.Id);
        var path = Path.Combine(next.Path, "README.md");
        await File.WriteAllTextAsync(path, "new work must survive old receipt replay");
        var plan = await f.Service.PrepareDiscardAsync(f.Owner, "admin", [], default);
        var command = DiscardInput(plan);
        await f.Service.AdmitDiscardAsync(f.Owner, "admin", command, [], default);
        Assert.Equal("removed", (await f.Service.FinishDiscardAsync(f.Owner, "admin", old, default)).State);
        var current = (await f.Service.ReadDiscardAsync(next.WorkspaceId, command.RequestId, "admin", default))!;
        Assert.Equal("pending", current.State);
        Assert.NotNull(current.Owner); Assert.NotNull(current.Plan); Assert.NotNull(current.Snapshots);
        Assert.True(File.Exists(Path.Combine(f.F.Paths.CoreRoot, "development", "discards", "reviews", command.Digest + ".json")));
        Assert.Equal("new work must survive old receipt replay", await File.ReadAllTextAsync(path));
        Assert.Equal("removed", (await f.Service.FinishDiscardAsync(f.Owner, "admin", command, default)).State);
        Assert.False(Directory.Exists(next.Path));
    }


    [Fact]
    public async Task WorkspaceDiscard_ReviewMetadataFailureRemainsPendingAndDiscoverableUntilTheLastCleanupWrite()
    {
        using var f = await DiscardFixtureAsync();
        await AddDiscardableSource(f.Tree);
        var store = new CoreEnvironmentStore(f.F.Paths);
        var environments = new CoreEnvironmentService(store, new ResourceControlRuntime(), f.F.Clock, f.Service);
        var controls = new WorkspaceCleanupService(f.F.Paths, new(f.Service, f.F.Apps, f.F.Clock), f.Service, null!, f.F.Apps,
            store, environments, new(store, environments));
        await f.F.Apps.UpdateAppAsync(SourceTestApp, app => app with { GrantedCorePermissions = [CoreAppPermissions.Sources] });
        var plan = await controls.PrepareDiscardAsync(f.Tree.WorkspaceId, "admin", SourceTestApp, default);
        var command = DiscardInput(plan);
        await f.Service.AdmitDiscardAsync(f.Owner, "admin", command, [], default);
        var review = Path.Combine(f.F.Paths.CoreRoot, "development", "discards", "reviews", command.Digest + ".json");
        File.Delete(review); Directory.CreateDirectory(review);
        var result = await controls.ApplyDiscardAsync(f.Tree.WorkspaceId, "admin", SourceTestApp, command, default);
        Assert.Equal("pending", result.State);
        Assert.NotNull(result.Error);
        Assert.False(Directory.Exists(f.Tree.Path));
        Assert.Empty((await f.Service.ListAsync(f.Owner, true, default)).Workspaces);
        var receipt = (await f.Service.ReadDiscardAsync(f.Tree.WorkspaceId, command.RequestId, "admin", default))!;
        Assert.Equal("pending", receipt.State); Assert.True(receipt.SourceRemoved);
        Assert.NotNull(receipt.Owner); Assert.NotNull(receipt.Plan); Assert.NotNull(receipt.Snapshots);
        var inspection = new WorkspaceInspectionService(f.Service, f.F.Apps, f.F.Clock);
        Assert.Equal(f.Tree.WorkspaceId, Assert.Single((await inspection.ListAsync("admin", default)).Workspaces).Id);
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.PrepareAsync(f.Owner, WorkspaceRequest(), default));
        Directory.Delete(review);
        Assert.Equal("removed", (await controls.ApplyDiscardAsync(f.Tree.WorkspaceId, "admin", SourceTestApp, command, default)).State);
        Assert.Empty((await inspection.ListAsync("admin", default)).Workspaces);
        var completed = (await f.Service.ReadDiscardAsync(f.Tree.WorkspaceId, command.RequestId, "admin", default))!;
        Assert.Null(completed.Owner); Assert.Null(completed.Plan); Assert.Null(completed.Snapshots);
    }

    [Fact]
    public async Task WorkspaceDiscard_DurableAdmissionFencesWorkflowAndPreviewBeforeTheOrdinaryFenceWrite()
    {
        using var f = await DiscardFixtureAsync();
        var paused = await f.Service.ChangeWorkflowAsync(f.Owner, "admin", "pause", new(Guid.NewGuid().ToString(), 0), new Dictionary<string, string>(), default);
        var priorResume = new WorkspaceWorkflowCommand(Guid.NewGuid().ToString(), paused.Revision);
        var open = await f.Service.ChangeWorkflowAsync(f.Owner, "admin", "resume", priorResume, new Dictionary<string, string>(), default);
        var plan = await f.Service.PrepareDiscardAsync(f.Owner, "admin", [], default);
        var command = DiscardInput(plan);
        await f.Service.AdmitDiscardAsync(f.Owner, "admin", command, [], default);
        // Recreate the crash boundary after the intent write but before the workflow fence write.
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development", "workflows",
            DevelopmentWorkspaceService.Hash(DevelopmentWorkspaceService.OwnerIdentity(f.Owner)) + ".json"), open);
        foreach (var action in new[] { "complete", "resume", "pause", "close", "delete" })
        {
            var error = await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.ChangeWorkflowAsync(f.Owner, "admin", action,
                new(Guid.NewGuid().ToString(), open.Revision), new Dictionary<string, string>(), default));
            Assert.Equal("workspace_operation_pending", error.Code);
            Assert.Equal(CoreJson.Text(open), CoreJson.Text(await f.Service.WorkflowAsync(f.Owner, default)));
            Assert.Equal("source", await File.ReadAllTextAsync(Path.Combine(f.Tree.Path, "README.md")));
        }
        Assert.Equal(CoreJson.Text(open), CoreJson.Text(await f.Service.ChangeWorkflowAsync(f.Owner, "admin", "resume", priorResume, new Dictionary<string, string>(), default)));
        var invoked = false;
        Assert.Equal("workspace_workflow_closed", (await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.WithIdleSourceAsync(f.Owner,
            () => Task.FromResult(invoked = true), default))).Code);
        Assert.False(invoked);
        await f.Service.AdmitDiscardAsync(f.Owner, "admin", command, [], default);
        Assert.Equal("deleting", (await f.Service.WorkflowAsync(f.Owner, default)).State);
        Assert.Equal("removed", (await f.Service.FinishDiscardAsync(f.Owner, "admin", command, default)).State);
        Assert.False(Directory.Exists(f.Tree.Path));
    }

}
