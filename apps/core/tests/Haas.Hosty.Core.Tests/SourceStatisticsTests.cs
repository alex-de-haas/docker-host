using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task SourceStats_SummaryCountsEveryFileWithoutReturningPathsOrPreviews()
    {
        var (fixture, repository) = await SourceFixtureAsync();
        for (var index = 0; index < 1200; index++)
            await File.WriteAllTextAsync(Path.Combine(repository, $"new-{index:D4}.txt"), "new line\n");
        await RunGitAsync(repository, ["add", "."]);

        var summary = await fixture.Sources.GetWorktreeSummaryAsync(SourceTestApp);
        Assert.Equal(1200, summary.FileCount);
        Assert.False(summary.Truncated);
        Assert.Equal(new AppSourceLineStats(1200, 0), summary.LineStats);
        var json = System.Text.Json.JsonSerializer.Serialize(summary, CoreJsonSerializerContext.Default.AppSourceSummary);
        Assert.DoesNotContain("\"files\"", json);
        Assert.DoesNotContain("new-0000.txt", json);
        Assert.DoesNotContain("\"combined\"", json);
        Assert.DoesNotContain("\"image\"", json);

        var status = await fixture.Sources.GetWorktreeStatusAsync(SourceTestApp);
        Assert.Equal(1200, status.Files.Count);
        Assert.Equal(summary.LineStats, status.LineStats);
        // Files beyond the former cap are previewable and reviewable without loading patches early.
        Assert.Contains("+new line", (await fixture.Sources.GetWorktreeDiffAsync(SourceTestApp, new("new-1199.txt"))).Combined);
        Assert.Equal("new-1199.txt", Assert.Single((await fixture.Sources.PlanDiscardAsync(SourceTestApp, new(["new-1199.txt"]))).Files).Path);
    }

    [Fact]
    public async Task SourceStats_CountsHeadToWorktreeOnceBeforeAnyPreview()
    {
        var (fixture, repository) = await SourceFixtureAsync();
        var path = Path.Combine(repository, "README.md");
        await File.WriteAllTextAsync(path, "staged\n");
        await RunGitAsync(repository, ["add", "README.md"]);
        await File.WriteAllTextAsync(path, "first\nsecond\n");
        var status = await fixture.Sources.GetWorktreeStatusAsync(SourceTestApp);
        Assert.Equal(new AppSourceLineStats(2, 1), status.LineStats);
        Assert.Equal(status.LineStats, Assert.Single(status.Files).LineStats);

        // The index still differs, but the net working-tree change against HEAD is zero.
        await File.WriteAllTextAsync(path, "source");
        status = await fixture.Sources.GetWorktreeStatusAsync(SourceTestApp);
        Assert.Equal(new AppSourceLineStats(0, 0), status.LineStats);
        Assert.Single(status.Files);
    }

    [Theory]
    [InlineData("", 0)]
    [InlineData("first\nsecond", 2)]
    [InlineData("first\nsecond\n", 2)]
    [InlineData("first\r\nsecond\r\n", 2)]
    public async Task SourceStats_NewTextCountsAllLines(string contents, int added)
    {
        var (fixture, repository) = await SourceFixtureAsync();
        await File.WriteAllTextAsync(Path.Combine(repository, "new.txt"), contents);
        var status = await fixture.Sources.GetWorktreeStatusAsync(SourceTestApp);
        Assert.Equal(new AppSourceLineStats(added, 0), Assert.Single(status.Files).LineStats);
        Assert.Equal(new AppSourceLineStats(added, 0), status.LineStats);
    }

    [Fact]
    public async Task SourceStats_EmptyRepositoryCountsStagedAndUntrackedWorkingFiles()
    {
        var (fixture, _) = await SourceFixtureAsync();
        var repository = Path.Combine(fixture.Root, "unborn-statistics");
        Directory.CreateDirectory(repository);
        await RunGitAsync(repository, ["init", "-b", "new-app"]);
        await fixture.Sources.SetLocalOverrideAsync(SourceTestApp, new(repository));
        await File.WriteAllTextAsync(Path.Combine(repository, "staged.txt"), "old staged content\n");
        await RunGitAsync(repository, ["add", "."]);
        await File.WriteAllTextAsync(Path.Combine(repository, "staged.txt"), "one\ntwo\n");
        await File.WriteAllTextAsync(Path.Combine(repository, "untracked.txt"), "three");
        var status = await fixture.Sources.GetWorktreeStatusAsync(SourceTestApp);
        Assert.Null(status.Head);
        Assert.Equal(new AppSourceLineStats(3, 0), status.LineStats);
        Assert.Equal(new AppSourceLineStats(2, 0), status.Files.Single(file => file.Path == "staged.txt").LineStats);
    }

    [Fact]
    public async Task SourceStats_RespectsScopeAndLiteralTabNewlinePaths()
    {
        var (fixture, repository) = await SourceFixtureAsync();
        var folder = Path.Combine(repository, "app");
        Directory.CreateDirectory(folder);
        var name = OperatingSystem.IsWindows() ? "file[1].txt" : "file[1]\tpart\nname.txt";
        await File.WriteAllTextAsync(Path.Combine(folder, name), "old\n");
        await RunGitAsync(repository, ["add", "."]);
        await RunGitAsync(repository, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "App file"]);
        await fixture.Apps.UpdateAppAsync(SourceTestApp, app => app with { SourceState = app.SourceState! with { ManifestSubpath = "app" } });
        await File.WriteAllTextAsync(Path.Combine(repository, "README.md"), "not\ncounted\n");
        File.Delete(Path.Combine(folder, name));
        var status = await fixture.Sources.GetWorktreeStatusAsync(SourceTestApp);
        Assert.Equal(name, Assert.Single(status.Files).Path);
        Assert.Equal(new AppSourceLineStats(0, 1), status.LineStats);
    }

    [Fact]
    public async Task SourceStats_BinaryFilesHaveNoLineCountsAndDoNotInflateTotals()
    {
        var (fixture, repository) = await SourceFixtureAsync();
        await File.WriteAllBytesAsync(Path.Combine(repository, "tracked.bin"), [0, 1, 2]);
        await RunGitAsync(repository, ["add", "."]);
        await RunGitAsync(repository, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Binary baseline"]);
        await File.WriteAllBytesAsync(Path.Combine(repository, "tracked.bin"), [0, 3]);
        await File.WriteAllBytesAsync(Path.Combine(repository, "new.png"), PreviewPng);
        await File.WriteAllTextAsync(Path.Combine(repository, "new.txt"), "one\ntwo");
        var status = await fixture.Sources.GetWorktreeStatusAsync(SourceTestApp);
        Assert.Equal(new AppSourceLineStats(2, 0), status.LineStats);
        foreach (var file in status.Files.Where(file => file.Path != "new.txt"))
        {
            Assert.True(file.Binary);
            Assert.Null(file.LineStats);
        }
    }

    [Fact]
    public async Task SourceStats_LargeNewTextLeavesTotalsUnknownButLargeTrackedDiffIsCounted()
    {
        var (fixture, repository) = await SourceFixtureAsync();
        await File.WriteAllTextAsync(Path.Combine(repository, "README.md"), string.Concat(Enumerable.Repeat("line\n", 20_000)));
        var status = await fixture.Sources.GetWorktreeStatusAsync(SourceTestApp);
        Assert.Equal(new AppSourceLineStats(20_000, 1), status.LineStats);
        await File.WriteAllTextAsync(Path.Combine(repository, "large.txt"), new string('x', 4 * 1024 * 1024 + 1));
        status = await fixture.Sources.GetWorktreeStatusAsync(SourceTestApp);
        Assert.Null(status.LineStats);
        Assert.Null(status.Files.Single(file => file.Path == "large.txt").LineStats);
        Assert.Equal(new AppSourceLineStats(20_000, 1), status.Files.Single(file => file.Path == "README.md").LineStats);
    }

    [Fact]
    public async Task SourceStats_RefusesSymlinksAndDoesNotCountTheirTargets()
    {
        if (OperatingSystem.IsWindows()) return;
        var (fixture, repository) = await SourceFixtureAsync();
        var outside = Path.Combine(fixture.Root, "outside-statistics.txt");
        await File.WriteAllTextAsync(outside, "secret\nlines\n");
        File.CreateSymbolicLink(Path.Combine(repository, "linked.txt"), outside);
        var status = await fixture.Sources.GetWorktreeStatusAsync(SourceTestApp);
        Assert.Null(Assert.Single(status.Files).LineStats);
        Assert.Null(status.LineStats);
    }

    [Fact]
    public async Task SourceStats_BatchedFileChecksTreatShellSyntaxAsLiteralPaths()
    {
        if (OperatingSystem.IsWindows()) return;
        var (fixture, repository) = await SourceFixtureAsync();
        var name = "$(touch injected);'quoted'\tline\nfile.txt";
        await File.WriteAllTextAsync(Path.Combine(repository, name), "one\ntwo");
        var status = await fixture.Sources.GetWorktreeStatusAsync(SourceTestApp);
        Assert.Equal(name, Assert.Single(status.Files).Path);
        Assert.Equal(new AppSourceLineStats(2, 0), status.LineStats);
        Assert.False(File.Exists(Path.Combine(repository, "injected")));
    }

    [Fact]
    public async Task SourceStats_BatchedFileChecksRejectFifosBeforeOpening()
    {
        if (OperatingSystem.IsWindows()) return;
        var (fixture, _) = await SourceFixtureAsync();
        var repository = Path.Combine(fixture.Root, "unborn-fifo");
        Directory.CreateDirectory(repository);
        await RunGitAsync(repository, ["init", "-b", "new-app"]);
        await fixture.Sources.SetLocalOverrideAsync(SourceTestApp, new(repository));
        var path = Path.Combine(repository, "file.txt");
        await File.WriteAllTextAsync(path, "original");
        await RunGitAsync(repository, ["add", "."]);
        File.Delete(path);
        var start = new System.Diagnostics.ProcessStartInfo("mkfifo");
        start.ArgumentList.Add(path);
        Assert.Equal(0, (await ProcessRunner.RunAsync(start, TimeSpan.FromSeconds(5))).ExitCode);
        var status = await fixture.Sources.GetWorktreeStatusAsync(SourceTestApp);
        Assert.Null(Assert.Single(status.Files).LineStats);
        Assert.Null(status.LineStats);
    }
}
