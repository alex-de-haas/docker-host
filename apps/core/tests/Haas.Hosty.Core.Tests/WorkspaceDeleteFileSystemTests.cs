using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static async Task CreateDeleteDirectoryLink(string link, string target)
    {
        if (!OperatingSystem.IsWindows())
        {
            Directory.CreateSymbolicLink(link, target);
            return;
        }
        // Junctions exercise Windows reparse points without requiring symlink privileges.
        // Both arguments are freshly allocated isolated test paths, never host resources.
        var start = new System.Diagnostics.ProcessStartInfo("cmd.exe") { UseShellExecute = false };
        foreach (var argument in new[] { "/c", "mklink", "/J", link, target }) start.ArgumentList.Add(argument);
        var result = await ProcessRunner.RunAsync(start, TimeSpan.FromSeconds(10), default);
        Assert.Equal(0, result.ExitCode);
    }

    [Fact]
    public async Task WorkspaceDelete_RemovesReadOnlyFilesAndBrokenLinksWithoutChangingOutsideTargets()
    {
        using var f = await DiscardFixtureAsync();
        var outside = Path.Combine(f.F.Root, "outside-workspace");
        Directory.CreateDirectory(outside);
        var keep = Path.Combine(outside, "keep.txt");
        await File.WriteAllTextAsync(keep, "outside source survives");
        File.SetAttributes(keep, File.GetAttributes(keep) | FileAttributes.ReadOnly);
        var outsideAttributes = File.GetAttributes(keep);
        var modules = Path.Combine(f.Tree.Path, "node_modules");
        Directory.CreateDirectory(modules);
        var readOnly = Path.Combine(modules, "readonly-package");
        await File.WriteAllTextAsync(readOnly, "temporary package contents");
        File.SetAttributes(readOnly, File.GetAttributes(readOnly) | FileAttributes.ReadOnly);
        var brokenTarget = Path.Combine(f.F.Root, "removed-package-target");
        Directory.CreateDirectory(brokenTarget);
        await CreateDeleteDirectoryLink(Path.Combine(modules, "external-package"), outside);
        await CreateDeleteDirectoryLink(Path.Combine(modules, "broken-package"), brokenTarget);
        Directory.Delete(brokenTarget);
        if (!OperatingSystem.IsWindows())
        {
            File.CreateSymbolicLink(Path.Combine(modules, "external-file"), keep);
            File.CreateSymbolicLink(Path.Combine(modules, "broken-file"), Path.Combine(brokenTarget, "missing"));
        }
        try
        {
            var cleanup = DeleteCleanup(f);
            var command = new WorkspaceDeleteCommand(Guid.NewGuid().ToString());
            var deleted = await cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "admin", null, command, default);
            Assert.True(deleted.State == "removed", deleted.Error);
            Assert.False(DevelopmentWorkspaceService.PathEntryExists(f.Tree.Path));
            Assert.Equal("outside source survives", await File.ReadAllTextAsync(keep));
            Assert.Equal(outsideAttributes, File.GetAttributes(keep));
            var registrations = await RunGitAsync(DiscardRepo(f, f.Tree), ["worktree", "list", "--porcelain", "-z"]);
            Assert.False(GitWorktreeRegistrations.Contains(registrations, f.Tree.Path, "refs/heads/" + f.Tree.Branch));
            Assert.DoesNotContain("refs/heads/" + f.Tree.Branch, await RunGitAsync(DiscardRepo(f, f.Tree), ["show-ref"]));
            Assert.Equal("removed", (await cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "another-admin", null, command, default)).State);
        }
        finally
        {
            // Only these isolated fixture files are ours; link target attributes stay intact
            // until after the assertions, then return to normal for fixture disposal.
            File.SetAttributes(keep, FileAttributes.Normal);
            if (File.Exists(readOnly)) File.SetAttributes(readOnly, FileAttributes.Normal);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WorkspaceDelete_RecoversAcceptedRequestAfterPhysicalRemovalBeforeGitCleanup(bool partial)
    {
        using var f = await DiscardFixtureAsync();
        var requestId = Guid.NewGuid().ToString();
        var journal = await f.Service.AdmitDeleteAsync(f.Owner, "admin", requestId, [], default);
        // Simulate the durable boundary before physical cleanup, followed by a crash before
        // Git registration removal. All native file changes are inside this fixture's tree.
        var operation = new WorkspaceOperation("discard-" + requestId, "discard", journal.Command.Digest,
            "pending", journal.Plan!.Trees[0].Head);
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development", "workspaces", f.Tree.Id + ".json"),
            f.Tree with { State = "releasing", Operations = [.. f.Tree.Operations, operation] });
        Directory.Delete(f.Tree.Path, recursive: true);
        if (partial) Directory.CreateDirectory(Path.Combine(f.Tree.Path, "apps", "example", "node_modules"));
        var registrations = await RunGitAsync(DiscardRepo(f, f.Tree), ["worktree", "list", "--porcelain", "-z"]);
        Assert.True(GitWorktreeRegistrations.Contains(registrations, f.Tree.Path));
        if (OperatingSystem.IsWindows())
        {
            Assert.Contains("worktree " + f.Tree.Path.Replace('\\', '/') + "\0", registrations);
            Assert.DoesNotContain("worktree " + f.Tree.Path + "\0", registrations);
        }
        var restarted = new DevelopmentWorkspaceService(f.F.Paths, f.F.Apps, f.F.Clock);
        var deleted = await restarted.FinishDiscardAsync(f.Owner, "another-admin", journal.Command, default);
        Assert.Equal("removed", deleted.State);
        Assert.Equal(requestId, deleted.Command.RequestId);
        Assert.False(DevelopmentWorkspaceService.PathEntryExists(f.Tree.Path));
        Assert.Empty((await restarted.ListAsync(null, true, default)).Workspaces);
        registrations = await RunGitAsync(DiscardRepo(f, f.Tree), ["worktree", "list", "--porcelain", "-z"]);
        Assert.False(GitWorktreeRegistrations.Contains(registrations, f.Tree.Path, "refs/heads/" + f.Tree.Branch));
        Assert.Equal("removed", (await restarted.FinishDiscardAsync(f.Owner, "admin", journal.Command, default)).State);
    }

    [Fact]
    public async Task WorkspaceDelete_PreservesAnotherWorktreeUsingThePrivateBranchAndRetriesTheSameRequest()
    {
        using var f = await DiscardFixtureAsync();
        var other = Path.Combine(f.F.Root, "other-worktree");
        var repo = DiscardRepo(f, f.Tree);
        await RunGitAsync(repo, ["worktree", "add", "--force", other, f.Tree.Branch]);
        await File.WriteAllTextAsync(Path.Combine(other, "keep.txt"), "unrelated working directory survives");
        var cleanup = DeleteCleanup(f);
        var command = new WorkspaceDeleteCommand(Guid.NewGuid().ToString());
        var pending = await cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "admin", null, command, default);
        Assert.Equal("pending", pending.State);
        Assert.Equal(command.RequestId, pending.RequestId);
        Assert.Contains("Git registration", pending.Error!);
        Assert.False(Directory.Exists(f.Tree.Path));
        Assert.Equal("unrelated working directory survives", await File.ReadAllTextAsync(Path.Combine(other, "keep.txt")));
        Assert.Contains("refs/heads/" + f.Tree.Branch, await RunGitAsync(repo, ["show-ref"]));
        // Git canonicalizes the macOS /var temporary-directory alias when registering a tree.
        var registeredOther = (await RunGitAsync(other, ["rev-parse", "--show-toplevel"])).Trim();
        Assert.True(GitWorktreeRegistrations.Contains(await RunGitAsync(repo, ["worktree", "list", "--porcelain", "-z"]), registeredOther));
        // Resolve only the intentionally created test consumer, then recover the accepted request.
        await RunGitAsync(repo, ["worktree", "remove", "--force", other]);
        Assert.Equal("removed", (await cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "another-admin", null, command, default)).State);
    }

    [Fact]
    public async Task WorkspaceDelete_RejectsAReparsePointReplacingItsRootAndPreservesItsTarget()
    {
        using var f = await DiscardFixtureAsync();
        var saved = f.Tree.Path + ".saved";
        var outside = Path.Combine(f.F.Root, "outside-replacement");
        Directory.CreateDirectory(outside);
        await File.WriteAllTextAsync(Path.Combine(outside, "keep.txt"), "preserve replacement target");
        Directory.Move(f.Tree.Path, saved);
        await CreateDeleteDirectoryLink(f.Tree.Path, outside);
        var cleanup = DeleteCleanup(f);
        var command = new WorkspaceDeleteCommand(Guid.NewGuid().ToString());
        var pending = await cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "admin", null, command, default);
        Assert.Equal("pending", pending.State);
        Assert.Equal(command.RequestId, pending.RequestId);
        Assert.NotNull(pending.Error);
        Assert.Equal("preserve replacement target", await File.ReadAllTextAsync(Path.Combine(outside, "keep.txt")));
        Directory.Delete(f.Tree.Path); // Remove this fixture's junction/link itself, never its target.
        Directory.Move(saved, f.Tree.Path);
        Assert.Equal("removed", (await cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "another-admin", null, command, default)).State);
        Assert.Equal("preserve replacement target", await File.ReadAllTextAsync(Path.Combine(outside, "keep.txt")));
    }
}
