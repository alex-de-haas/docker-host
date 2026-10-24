using System.Diagnostics;
using Haas.Hosty.Cli.Commands;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class WorkspaceAdoptionLegacySourceTests : IDisposable
{
    private readonly string root = Directory.CreateTempSubdirectory("hosty-legacy-adoption-").FullName;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task LegacyWorktreeOrigin_ResolvesThirdPartyRepositoryWithoutMigratingConfiguration(bool useOverride)
    {
        var repository = Path.Combine(root, "repository"); Directory.CreateDirectory(repository);
        await Git(repository, "init", "-b", "main");
        await File.WriteAllTextAsync(Path.Combine(repository, "README.md"), "fixture");
        await Git(repository, "add", "README.md");
        await Git(repository, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "fixture");
        await Git(repository, "remote", "add", "origin", "https://independent.example/team/platform.git");
        var checkout = useOverride ? Path.Combine(root, "selected-checkout") : Path.Combine(root, "core", "source");
        Directory.CreateDirectory(Path.GetDirectoryName(checkout)!);
        await Git(repository, "worktree", "add", "-b", "source", checkout);
        Assert.True(File.Exists(Path.Combine(checkout, ".git")));
        var saved = new CoreSourceSettings(useOverride ? checkout : null, "reviewed-revision", PendingForInstance: "retained-instance");
        CoreLaunchFiles.Write(CoreLaunchFiles.SourcePath(root), saved, CoreLaunchJson.Default.CoreSourceSettings);
        var bytes = await File.ReadAllBytesAsync(CoreLaunchFiles.SourcePath(root));
        var source = await CoreCommand.ResolveAdoptionSourceAsync(root);
        Assert.Equal("https://independent.example/team/platform.git", source.RepositoryUrl);
        Assert.Equal(saved.OverridePath, source.OverridePath);
        Assert.Equal(saved.Revision, source.Revision);
        Assert.Equal(saved.PendingForInstance, source.PendingForInstance);
        Assert.Equal(saved.ProjectPath, source.ProjectPath);
        Assert.Equal(1, source.SchemaVersion);
        Assert.Equal(bytes, await File.ReadAllBytesAsync(CoreLaunchFiles.SourcePath(root)));

        var treeId = new string('b', 64);
        var tree = Path.Combine(root, "core", "development", "trees", treeId); Directory.CreateDirectory(tree);
        var project = Path.Combine(tree, source.ProjectPath);
        var launch = new CoreLaunchIdentity("dev", project, "generation", 123, DateTimeOffset.UtcNow);
        var activation = new WorkspaceRuntimeActivation(Guid.NewGuid().ToString("D"), "workspace", "user", "fingerprint", "instance", saved.Revision,
            treeId, project, new("release", null, null, 12, DateTimeOffset.UtcNow.AddDays(-1)), [], "active", ActivatedCore: launch,
            Authority: new("user", "browser", Principal: "browser:review"), CoreReserved: true);
        var registration = Path.Combine(root, "core", "development", "workspaces", treeId + ".json");
        Directory.CreateDirectory(Path.GetDirectoryName(registration)!);
        await File.WriteAllTextAsync(registration, System.Text.Json.JsonSerializer.Serialize(new { id = treeId, workspaceId = "workspace", path = tree,
            owner = new { userId = "user" }, state = "active", repository = source.RepositoryUrl, apps = new[] { new { appId = "third.party" } } }));
        CoreCommand.ValidateAdoptionBinding(root, activation, launch, source);
        Assert.Throws<InvalidOperationException>(() => CoreCommand.ValidateAdoptionBinding(root, activation, launch,
            source with { ConnectionId = "private", ConnectionOwnerId = "another-user" }));
    }

    [Fact]
    public async Task MissingOrUnverifiableLegacyOrigin_RemainsUnknownInsteadOfSelectingDefaultRepository()
    {
        var saved = new CoreSourceSettings(null, "revision");
        CoreLaunchFiles.Write(CoreLaunchFiles.SourcePath(root), saved, CoreLaunchJson.Default.CoreSourceSettings);
        await Assert.ThrowsAsync<InvalidOperationException>(() => CoreCommand.ResolveAdoptionSourceAsync(root));
        var checkout = Path.Combine(root, "core", "source"); Directory.CreateDirectory(checkout);
        await Git(checkout, "init", "-b", "main");
        await Git(checkout, "remote", "add", "origin", "https://user:credential@independent.example/team/platform");
        await Assert.ThrowsAsync<InvalidOperationException>(() => CoreCommand.ResolveAdoptionSourceAsync(root));
        Assert.Null(CoreLaunchFiles.Read(CoreLaunchFiles.SourcePath(root), CoreLaunchJson.Default.CoreSourceSettings)!.RepositoryUrl);
    }

    private static async Task Git(string directory, params string[] args)
    {
        var start = new ProcessStartInfo("git") { WorkingDirectory = directory, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var arg in args) start.ArgumentList.Add(arg);
        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        Assert.True(process.ExitCode == 0, await output + await error);
    }
    public void Dispose() => Directory.Delete(root, true);
}
