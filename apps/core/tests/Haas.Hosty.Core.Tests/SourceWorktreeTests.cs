using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private const string SourceTestApp = "com.example.notes";

    private static async Task<(LifecycleFixture Fixture, string Repository)> SourceFixtureAsync()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var repository = await CreateGitRepositoryAsync(fixture.Root);
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0", sourceRepository: repository)));
        await fixture.Sources.SetLocalOverrideAsync(SourceTestApp, new AppSourceOverrideRequest(repository));
        await fixture.Apps.UpdateAppAsync(SourceTestApp, app => app with { SourceState = app.SourceState! with { ManifestSubpath = null } });
        return (fixture, repository);
    }

    [Fact]
    public async Task Worktree_StatusDiffDiscardPreservesUnrelatedWorkAndHead()
    {
        var (fixture, repository) = await SourceFixtureAsync();
        var clean = await fixture.Sources.GetWorktreeStatusAsync(SourceTestApp);
        Assert.Equal("clean", clean.State);
        Assert.Equal("main", clean.Branch);
        await File.WriteAllTextAsync(Path.Combine(repository, "README.md"), "edited");
        await RunGitAsync(repository, ["add", "README.md"]);
        await File.WriteAllTextAsync(Path.Combine(repository, "keep.txt"), "unrelated work");
        var dirty = await fixture.Sources.GetWorktreeStatusAsync(SourceTestApp);
        Assert.Equal(2, dirty.Files.Count);
        var diff = await fixture.Sources.GetWorktreeDiffAsync(SourceTestApp, new("README.md"));
        Assert.Contains("+edited", diff.Combined);
        Assert.Contains("+edited", diff.Staged);
        var plan = await fixture.Sources.PlanDiscardAsync(SourceTestApp, new(["README.md"]));
        var result = await fixture.Service.ApplySourceDiscardAsync(SourceTestApp, new(plan.ReviewId));
        Assert.Equal("source", await File.ReadAllTextAsync(Path.Combine(repository, "README.md")));
        Assert.Equal("unrelated work", await File.ReadAllTextAsync(Path.Combine(repository, "keep.txt")));
        Assert.Equal(clean.Head, result.Head);
        Assert.Equal("keep.txt", Assert.Single(result.Files).Path);
        var reused = await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Service.ApplySourceDiscardAsync(SourceTestApp, new(plan.ReviewId)));
        Assert.Equal("source_review_expired", reused.Code);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Worktree_DiscardNewFileUsesLiteralPathAndPreservesNeighbors(bool staged)
    {
        var (fixture, repository) = await SourceFixtureAsync();
        var name = "literal[1].txt";
        await File.WriteAllTextAsync(Path.Combine(repository, name), "new file");
        await File.WriteAllTextAsync(Path.Combine(repository, "literal1.txt"), "keep");
        if (staged) await RunGitAsync(repository, ["--literal-pathspecs", "add", "--", name]);
        var plan = await fixture.Sources.PlanDiscardAsync(SourceTestApp, new([name]));
        Assert.True(Assert.Single(plan.Files).NewFile);
        await fixture.Service.ApplySourceDiscardAsync(SourceTestApp, new(plan.ReviewId));
        Assert.False(File.Exists(Path.Combine(repository, name)));
        Assert.Equal("keep", await File.ReadAllTextAsync(Path.Combine(repository, "literal1.txt")));
    }

    [Fact]
    public async Task Worktree_RejectsChangedContentsEvenWithSameStatusAndLength()
    {
        var (fixture, repository) = await SourceFixtureAsync();
        var file = Path.Combine(repository, "README.md");
        await File.WriteAllTextAsync(file, "edited");
        var plan = await fixture.Sources.PlanDiscardAsync(SourceTestApp, new(["README.md"]));
        await File.WriteAllTextAsync(file, "newest");
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Service.ApplySourceDiscardAsync(SourceTestApp, new(plan.ReviewId)));
        Assert.Equal("source_review_stale", error.Code);
        Assert.Equal("newest", await File.ReadAllTextAsync(file));
    }

    [Fact]
    public async Task Worktree_RejectsChangedIndexEvenWhenWorktreeUnchanged()
    {
        var (fixture, repository) = await SourceFixtureAsync();
        var file = Path.Combine(repository, "README.md");
        await File.WriteAllTextAsync(file, "stage one");
        await RunGitAsync(repository, ["add", "README.md"]);
        await File.WriteAllTextAsync(file, "working");
        var plan = await fixture.Sources.PlanDiscardAsync(SourceTestApp, new(["README.md"]));
        await File.WriteAllTextAsync(file, "stage two");
        await RunGitAsync(repository, ["add", "README.md"]);
        await File.WriteAllTextAsync(file, "working");
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Service.ApplySourceDiscardAsync(SourceTestApp, new(plan.ReviewId)));
        Assert.Equal("source_review_stale", error.Code);
        Assert.Equal("stage two", await RunGitAsync(repository, ["show", ":README.md"]));
    }

    [Fact]
    public async Task Worktree_MonorepoStatusAndDiscardAreScopedToManifestDirectory()
    {
        var (fixture, repository) = await SourceFixtureAsync();
        var folder = Path.Combine(repository, "apps", "one");
        Directory.CreateDirectory(folder);
        await File.WriteAllTextAsync(Path.Combine(folder, "page.txt"), "original");
        await RunGitAsync(repository, ["add", "."]);
        await RunGitAsync(repository, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Add app"]);
        await fixture.Apps.UpdateAppAsync(SourceTestApp, app => app with { SourceState = app.SourceState! with { ManifestSubpath = "apps/one" } });
        await File.WriteAllTextAsync(Path.Combine(repository, "README.md"), "outside");
        await File.WriteAllTextAsync(Path.Combine(folder, "page.txt"), "preview");
        var status = await fixture.Sources.GetWorktreeStatusAsync(SourceTestApp);
        Assert.Equal("page.txt", Assert.Single(status.Files).Path);
        var plan = await fixture.Sources.PlanDiscardAsync(SourceTestApp, new(["page.txt"]));
        await fixture.Service.ApplySourceDiscardAsync(SourceTestApp, new(plan.ReviewId));
        Assert.Equal("original", await File.ReadAllTextAsync(Path.Combine(folder, "page.txt")));
        Assert.Equal("outside", await File.ReadAllTextAsync(Path.Combine(repository, "README.md")));
        Assert.Equal("clean", (await fixture.Sources.GetWorktreeStatusAsync(SourceTestApp)).State);
    }

    [Theory]
    [InlineData("../README.md")]
    [InlineData(".git/config")]
    [InlineData("/etc/passwd")]
    [InlineData(":(glob)*")]
    public async Task Worktree_RejectsUnlistedOrEscapingPaths(string path)
    {
        var (fixture, repository) = await SourceFixtureAsync();
        await File.WriteAllTextAsync(Path.Combine(repository, "README.md"), "keep");
        await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Sources.PlanDiscardAsync(SourceTestApp, new([path])));
        Assert.Equal("keep", await File.ReadAllTextAsync(Path.Combine(repository, "README.md")));
    }

    [Fact]
    public async Task Worktree_NoGitUnbornAndMissingAreDistinct()
    {
        var (fixture, _) = await SourceFixtureAsync();
        var folder = Path.Combine(fixture.Root, "no-git");
        Directory.CreateDirectory(folder);
        await fixture.Sources.SetLocalOverrideAsync(SourceTestApp, new(folder));
        Assert.Equal("no-git", (await fixture.Sources.GetWorktreeStatusAsync(SourceTestApp)).State);
        await RunGitAsync(folder, ["init", "-b", "new-app"]);
        await File.WriteAllTextAsync(Path.Combine(folder, "new.txt"), "no baseline");
        var unborn = await fixture.Sources.GetWorktreeStatusAsync(SourceTestApp);
        Assert.Null(unborn.Head);
        Assert.Equal("new-app", unborn.Branch);
        Assert.False(Assert.Single(unborn.Files).CanDiscard);
        await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Sources.PlanDiscardAsync(SourceTestApp, new(["new.txt"])));
        Directory.Move(folder, folder + "-moved");
        Assert.Equal("missing", (await fixture.Sources.GetWorktreeStatusAsync(SourceTestApp)).State);
    }

    [Fact]
    public async Task Worktree_SymlinkCannotExposeOrDiscardExternalFile()
    {
        if (OperatingSystem.IsWindows()) return;
        var (fixture, repository) = await SourceFixtureAsync();
        var outside = Path.Combine(fixture.Root, "outside.txt");
        await File.WriteAllTextAsync(outside, "private");
        File.CreateSymbolicLink(Path.Combine(repository, "linked.txt"), outside);
        var status = await fixture.Sources.GetWorktreeStatusAsync(SourceTestApp);
        Assert.False(Assert.Single(status.Files).CanDiscard);
        await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Sources.GetWorktreeDiffAsync(SourceTestApp, new("linked.txt")));
        await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Sources.PlanDiscardAsync(SourceTestApp, new(["linked.txt"])));
        Assert.Equal("private", await File.ReadAllTextAsync(outside));
    }

    [Fact]
    public async Task Worktree_LinkedWorktreeAndDetachedHeadAreRecognized()
    {
        var (fixture, repository) = await SourceFixtureAsync();
        var linked = Path.Combine(fixture.Root, "linked-worktree");
        await RunGitAsync(repository, ["worktree", "add", "--detach", linked, "HEAD"]);
        await fixture.Sources.SetLocalOverrideAsync(SourceTestApp, new(linked));
        var status = await fixture.Sources.GetWorktreeStatusAsync(SourceTestApp);
        Assert.Equal("clean", status.State);
        Assert.Null(status.Branch);
        Assert.NotNull(status.Head);
    }

    [Fact]
    public async Task Worktree_RejectsChangedHeadOrSourceBinding()
    {
        var (fixture, repository) = await SourceFixtureAsync();
        var file = Path.Combine(repository, "README.md");
        await File.WriteAllTextAsync(file, "keep");
        var plan = await fixture.Sources.PlanDiscardAsync(SourceTestApp, new(["README.md"]));
        await RunGitAsync(repository, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "Move HEAD"]);
        var changedHead = await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Service.ApplySourceDiscardAsync(SourceTestApp, new(plan.ReviewId)));
        Assert.Equal("source_review_stale", changedHead.Code);

        plan = await fixture.Sources.PlanDiscardAsync(SourceTestApp, new(["README.md"]));
        var other = Path.Combine(fixture.Root, "other-checkout");
        await RunGitAsync(repository, ["clone", repository, other]);
        await File.WriteAllTextAsync(Path.Combine(other, "README.md"), "keep");
        await fixture.Sources.SetLocalOverrideAsync(SourceTestApp, new(other));
        var changedBinding = await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Service.ApplySourceDiscardAsync(SourceTestApp, new(plan.ReviewId)));
        Assert.Equal("source_review_stale", changedBinding.Code);
        Assert.Equal("keep", await File.ReadAllTextAsync(file));
        Assert.Equal("keep", await File.ReadAllTextAsync(Path.Combine(other, "README.md")));
    }

    [Fact]
    public async Task Worktree_RenameIsReviewedAsExactDeletionAndAddition()
    {
        var (fixture, repository) = await SourceFixtureAsync();
        await RunGitAsync(repository, ["mv", "README.md", "renamed.md"]);
        await File.WriteAllTextAsync(Path.Combine(repository, "keep.txt"), "staged work");
        await RunGitAsync(repository, ["add", "keep.txt"]);
        var plan = await fixture.Sources.PlanDiscardAsync(SourceTestApp, new(["README.md", "renamed.md"]));
        Assert.Equal("D ", plan.Files.Single(file => file.Path == "README.md").Status);
        Assert.True(plan.Files.Single(file => file.Path == "renamed.md").NewFile);

        await fixture.Service.ApplySourceDiscardAsync(SourceTestApp, new(plan.ReviewId));

        Assert.Equal("source", await File.ReadAllTextAsync(Path.Combine(repository, "README.md")));
        Assert.False(File.Exists(Path.Combine(repository, "renamed.md")));
        Assert.Equal("staged work", await RunGitAsync(repository, ["show", ":keep.txt"]));
    }

    [Fact]
    public async Task Worktree_DeletedSymlinkCannotBeRestoredThroughFileDiscard()
    {
        if (OperatingSystem.IsWindows()) return;
        var (fixture, repository) = await SourceFixtureAsync();
        var link = Path.Combine(repository, "link.txt");
        File.CreateSymbolicLink(link, "README.md");
        await RunGitAsync(repository, ["add", "link.txt"]);
        await RunGitAsync(repository, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Add link"]);
        File.Delete(link);

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Sources.PlanDiscardAsync(SourceTestApp, new(["link.txt"])));

        Assert.Equal("source_discard_unsupported", error.Code);
        Assert.False(File.Exists(link));
    }

    [Fact]
    public async Task Worktree_CachedDeletionHasOneRestoreEntryInsteadOfDeletingUntrackedCopy()
    {
        var (fixture, repository) = await SourceFixtureAsync();
        await RunGitAsync(repository, ["rm", "--cached", "README.md"]);
        var status = await fixture.Sources.GetWorktreeStatusAsync(SourceTestApp);
        Assert.False(Assert.Single(status.Files).NewFile);
        var plan = await fixture.Sources.PlanDiscardAsync(SourceTestApp, new(["README.md"]));

        await fixture.Service.ApplySourceDiscardAsync(SourceTestApp, new(plan.ReviewId));

        Assert.Equal("source", await File.ReadAllTextAsync(Path.Combine(repository, "README.md")));
        Assert.Equal("clean", (await fixture.Sources.GetWorktreeStatusAsync(SourceTestApp)).State);
    }

    [Fact]
    public async Task Worktree_SpecialFileRefusesPreviewAndDiscardWithoutOpeningIt()
    {
        if (OperatingSystem.IsWindows()) return;
        var (fixture, repository) = await SourceFixtureAsync();
        var path = Path.Combine(repository, "README.md");
        File.Delete(path);
        var start = new System.Diagnostics.ProcessStartInfo("mkfifo");
        start.ArgumentList.Add(path);
        Assert.Equal(0, (await ProcessRunner.RunAsync(start, TimeSpan.FromSeconds(5))).ExitCode);

        var diffError = await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Sources.GetWorktreeDiffAsync(SourceTestApp, new("README.md")));
        var discardError = await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Sources.PlanDiscardAsync(SourceTestApp, new(["README.md"])));

        Assert.Equal("source_file_unsupported", diffError.Code);
        Assert.Equal("source_file_unsupported", discardError.Code);
    }

    [Fact]
    public async Task Worktree_TruncatesLargeChangeListsAndDiffs()
    {
        var (fixture, repository) = await SourceFixtureAsync();
        await File.WriteAllTextAsync(Path.Combine(repository, "README.md"), new string('x', 100_000));
        Assert.True((await fixture.Sources.GetWorktreeDiffAsync(SourceTestApp, new("README.md"))).Truncated);
        for (var index = 0; index < 520; index++) await File.WriteAllTextAsync(Path.Combine(repository, $"new-{index}.txt"), "new");
        var status = await fixture.Sources.GetWorktreeStatusAsync(SourceTestApp);
        Assert.True(status.Truncated);
        Assert.Equal(512, status.Files.Count);
        await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Sources.PlanDiscardAsync(SourceTestApp, new(["README.md"])));
    }
}
