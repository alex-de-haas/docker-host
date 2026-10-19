using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task WorkspaceGit_MaterializesAndObservesPathsBeyondWindowsMaxPath()
    {
        var (fixture, repository) = await SourceFixtureAsync();
        var worktree = Path.Combine(fixture.Root, new string('a', 90), new string('b', 90), new string('c', 90));
        Directory.CreateDirectory(Path.GetDirectoryName(worktree)!);
        Assert.True(Path.Combine(worktree, "README.md").Length > 260);

        await DevelopmentWorkspaceService.Git(repository, ["worktree", "add", "--detach", worktree, "HEAD"], default);

        Assert.Equal("source", await File.ReadAllTextAsync(Path.Combine(worktree, "README.md")));
        Assert.Empty((await DevelopmentWorkspaceService.Git(worktree, ["status", "--porcelain"], default)).StandardOutput.Trim());
        await File.WriteAllTextAsync(Path.Combine(worktree, "README.md"), "live edit");
        Assert.Contains("README.md", (await DevelopmentWorkspaceService.Git(worktree, ["diff", "--name-only"], default)).StandardOutput);
        await DevelopmentWorkspaceService.Git(repository, ["worktree", "remove", "--force", worktree], default);
        Assert.False(Directory.Exists(worktree));
    }
}
