using System.Diagnostics;
using Haas.Hosty.Core;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Core.Tests;

public sealed class CoreSourceInspectionTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "hosty-core-inspection-" + Guid.NewGuid().ToString("N"));
    private HostyCoreRuntimeConfig Config => new(root, Path.Combine(root, "run"), Path.Combine(root, "run/control.json"),
        7070, "http://localhost:7070", null, "localhost", null, false);
    private const string ProjectPath = "apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj";

    private async Task<string> CheckoutAsync(string name)
    {
        var path = Path.Combine(root, name);
        Directory.CreateDirectory(Path.GetDirectoryName(Path.Combine(path, ProjectPath))!);
        await File.WriteAllTextAsync(Path.Combine(path, ProjectPath), "<Project />\n");
        await File.WriteAllTextAsync(Path.Combine(path, "tracked.txt"), "original\n");
        await File.WriteAllTextAsync(Path.Combine(path, "deleted.txt"), "remove me\n");
        await GitAsync(path, "init", "--initial-branch=main");
        await GitAsync(path, "add", ".");
        await GitAsync(path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture");
        return path;
    }

    private CoreDevelopmentService Service(string checkout) => new(Config,
        new CoreLaunchIdentity("dev", Path.Combine(checkout, ProjectPath), null, 4321, DateTimeOffset.UtcNow));

    [Fact]
    public async Task RunningRepositoryRemainsTheScopeAfterPendingSourceChange()
    {
        var original = await CheckoutAsync("running");
        var replacement = await CheckoutAsync("selected");
        await File.WriteAllTextAsync(Path.Combine(original, "tracked.txt"), "staged\n");
        await GitAsync(original, "add", "tracked.txt");
        await File.WriteAllTextAsync(Path.Combine(original, "tracked.txt"), "working\n");
        Directory.CreateDirectory(Path.Combine(original, "docs"));
        await File.WriteAllTextAsync(Path.Combine(original, "docs/new.txt"), "one\ntwo\n");
        File.Delete(Path.Combine(original, "deleted.txt"));
        await File.WriteAllTextAsync(Path.Combine(replacement, "selected-only.txt"), "not running\n");
        var service = Service(original);
        await service.SaveAsync(new(replacement, "initial"), default);

        var status = await service.GetSourceStatusAsync();
        var summary = await service.GetAsync();
        Assert.True(summary.RestartRequired);
        Assert.Equal(MountPathPolicy.ResolveRealPath(original), status.ScopePath);
        Assert.Equal(new[] { "deleted.txt", "docs/new.txt", "tracked.txt" }, status.Files.Select(file => file.Path));
        Assert.All(status.Files, file => Assert.False(file.CanDiscard));
        Assert.Equal(status.FileCount, summary.ChangedFiles);
        Assert.Equal(status.LineStats?.Additions, summary.Additions);
        Assert.Equal(status.LineStats?.Deletions, summary.Deletions);
        Assert.Equal(new AppSourceLineStats(3, 2), status.LineStats);
        var diff = await service.GetSourceDiffAsync(new("tracked.txt"));
        Assert.Contains("+working", diff.Combined);
        Assert.Contains("+staged", diff.Staged);
        Assert.Contains("-remove me", (await service.GetSourceDiffAsync(new("deleted.txt"))).Combined);
        Assert.Equal("one\ntwo\n", (await service.GetSourceDiffAsync(new("docs/new.txt"))).Combined);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.GetSourceDiffAsync(new("selected-only.txt")));
        Assert.Equal("working\n", await File.ReadAllTextAsync(Path.Combine(original, "tracked.txt")));
    }

    [Fact]
    public async Task SymlinkedRepositoryAncestorKeepsChangedFilesAndDiffsInScope()
    {
        if (OperatingSystem.IsWindows()) return;
        var checkout = await CheckoutAsync("running");
        var alias = Path.Combine(root, "alias");
        Directory.CreateSymbolicLink(alias, checkout);
        await File.WriteAllTextAsync(Path.Combine(checkout, "tracked.txt"), "changed through alias\n");
        await File.WriteAllTextAsync(Path.Combine(checkout, "new.txt"), "untracked\n");
        var service = Service(alias);

        var status = await service.GetSourceStatusAsync();
        Assert.Equal(MountPathPolicy.ResolveRealPath(checkout), status.ScopePath);
        Assert.Equal(new[] { "new.txt", "tracked.txt" }, status.Files.Select(file => file.Path));
        Assert.Equal(new AppSourceLineStats(2, 1), status.LineStats);
        Assert.Contains("+changed through alias", (await service.GetSourceDiffAsync(new("tracked.txt"))).Combined);
        Assert.Equal("untracked\n", (await service.GetSourceDiffAsync(new("new.txt"))).Combined);
    }

    [Theory]
    [InlineData("../selected/tracked.txt")]
    [InlineData("/etc/passwd")]
    [InlineData(".git/config")]
    [InlineData("docs/../../tracked.txt")]
    public async Task DiffRejectsPathsOutsideTheChangedFileList(string path)
    {
        var checkout = await CheckoutAsync("running");
        await Assert.ThrowsAsync<AppLifecycleException>(() => Service(checkout).GetSourceDiffAsync(new(path)));
    }

    [Fact]
    public async Task DiffRejectsSymlinks()
    {
        if (OperatingSystem.IsWindows()) return;
        var checkout = await CheckoutAsync("running");
        var outside = Path.Combine(root, "private.txt");
        await File.WriteAllTextAsync(outside, "private");
        File.CreateSymbolicLink(Path.Combine(checkout, "link.txt"), outside);
        var service = Service(checkout);
        Assert.Equal("link.txt", Assert.Single((await service.GetSourceStatusAsync()).Files).Path);
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => service.GetSourceDiffAsync(new("link.txt")));
        Assert.Equal("source_diff_unsupported", error.Code);
    }

    [Fact]
    public async Task MissingRunningSourceDoesNotFallBackToSelectedCheckout()
    {
        var checkout = await CheckoutAsync("selected");
        var service = Service(Path.Combine(root, "missing"));
        await service.SaveAsync(new(checkout, "initial"), default);
        Assert.Equal("missing", (await service.GetSourceStatusAsync()).State);
        Assert.Null((await service.GetAsync()).ChangedFiles);
    }

    [Fact]
    public async Task RepositoryWithoutCommitsCanPreviewNewFiles()
    {
        var checkout = Path.Combine(root, "unborn");
        Directory.CreateDirectory(Path.GetDirectoryName(Path.Combine(checkout, ProjectPath))!);
        await GitAsync(checkout, "init", "--initial-branch=main");
        await File.WriteAllTextAsync(Path.Combine(checkout, "new.txt"), "new\n");
        var service = Service(checkout);
        var status = await service.GetSourceStatusAsync();
        Assert.Null(status.Head);
        Assert.Equal(1, status.FileCount);
        Assert.Equal("new\n", (await service.GetSourceDiffAsync(new("new.txt"))).Combined);
    }

    private static async Task GitAsync(string path, params string[] arguments)
    {
        var start = new ProcessStartInfo("git") { WorkingDirectory = path, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        await output;
        Assert.True(process.ExitCode == 0, await error);
    }

    public void Dispose()
    {
        if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
    }
}
