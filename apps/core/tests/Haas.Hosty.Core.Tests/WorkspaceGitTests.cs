using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task WorkspaceGit_MaterializesAndObservesPathsBeyondWindowsMaxPath()
    {
        var (fixture, repository) = await SourceFixtureAsync(shortPaths: true);
        // Keep Git's linked-worktree metadata short; tracked files still exceed MAX_PATH.
        var relative = Path.Combine(new string('a', 90), new string('b', 90), new string('c', 90), "live-source.txt");
        var source = Path.Combine(repository, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(source)!);
        await File.WriteAllTextAsync(source, "source");
        async Task<ProcessRunResult> Git(string directory, string[] args)
        {
            var result = await DevelopmentWorkspaceService.Git(directory, args, default, allowFailure: true);
            Assert.True(result.ExitCode == 0, result.StandardError);
            return result;
        }
        await Git(repository, ["add", "--", relative]);
        await Git(repository, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Long source path"]);
        var worktree = Path.Combine(fixture.Root, "linked-worktree");
        var file = Path.Combine(worktree, relative);
        Assert.True(file.Length > 260);

        await Git(repository, ["worktree", "add", "--detach", worktree, "HEAD"]);

        Assert.Equal("source", await File.ReadAllTextAsync(file));
        Assert.Empty((await Git(worktree, ["status", "--porcelain"])).StandardOutput.Trim());
        await File.WriteAllTextAsync(file, "live edit");
        var observed = await AppSourceService.ReadScopeStatusAsync("fixture", () => worktree, null,
            DateTimeOffset.UtcNow, default, entireRepository: true);
        Assert.True(observed.State == "changes", observed.Error ?? observed.State);
        Assert.Equal(relative.Replace(Path.DirectorySeparatorChar, '/'), Assert.Single(observed.Files).Path);
        await Git(repository, ["worktree", "remove", "--force", worktree]);
        Assert.False(Directory.Exists(worktree));
    }
}
