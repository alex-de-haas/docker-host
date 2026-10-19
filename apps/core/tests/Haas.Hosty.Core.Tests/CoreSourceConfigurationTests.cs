using Haas.Hosty.Core;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Core.Tests;

public sealed class CoreSourceConfigurationTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "hosty-core-source-" + Guid.NewGuid().ToString("N"));
    private CoreDevelopmentService Service => new(new(root, Path.Combine(root, "core/run"),
        Path.Combine(root, "core/run/control.json"), 7070, "http://localhost:7070", null, "localhost", null, false),
        new("release", null, null, 123, DateTimeOffset.UnixEpoch));

    [Theory]
    [InlineData("https://github.com/Owner/Fork", "https://github.com/owner/fork.git")]
    [InlineData("https://github.com/owner/fork.git/", "https://github.com/owner/fork.git")]
    [InlineData("https://git.example.test:8443/team/repo.git", "https://git.example.test:8443/team/repo.git")]
    public async Task SaveNormalizesCompleteUrlAndPreservesUpdateOrigin(string url, string expected)
    {
        var saved = await Service.SaveAsync(new(null, "initial", new(url, "feature/source", "src/Core.csproj")), default);
        Assert.Equal(expected, saved.RepositoryUrl);
        Assert.Equal("feature/source", saved.Ref);
        Assert.Equal("src/Core.csproj", saved.ProjectPath);
        var state = await Service.GetAsync();
        Assert.Equal(CoreSourceDefaults.UpdateRepository, state.UpdateRepository);
        Assert.False(state.RestartRequired);
        Assert.Equal("release", state.Launch.Mode);
        Assert.False(Directory.Exists(state.SourcePath));
        Assert.Equal(saved, await Service.SourceSettingsAsync(default));
        Assert.NotEqual(saved.Revision, (await Service.SaveAsync(new(null, saved.Revision,
            new("https://github.com/another/fork.git")), default)).Revision);
        await Assert.ThrowsAsync<InvalidOperationException>(() => Service.SaveAsync(new(null, saved.Revision), default));
    }

    [Theory]
    [InlineData("owner/repo")]
    [InlineData("git@github.com:owner/repo.git")]
    [InlineData("file:///tmp/source")]
    [InlineData("https://user:secret@github.com/owner/repo.git")]
    [InlineData("https://github.com/owner/repo?token=secret")]
    [InlineData("https://github.com/owner/repo#main")]
    [InlineData("https://github.com/owner/repo/tree/main")]
    public async Task SaveRejectsUnsupportedOrSecretBearingRepository(string url)
    {
        await Assert.ThrowsAsync<ArgumentException>(() => Service.SaveAsync(new(null, "initial", new(url)), default));
        Assert.False(File.Exists(CoreLaunchFiles.SourcePath(root)));
    }

    [Theory]
    [InlineData("../Core.csproj")]
    [InlineData("/tmp/Core.csproj")]
    [InlineData("src/../../Core.csproj")]
    [InlineData("src\\Core.csproj")]
    [InlineData("src/Core.txt")]
    public async Task ProjectMustStayWithinRepository(string project)
    {
        await Assert.ThrowsAsync<ArgumentException>(() => Service.SaveAsync(new(null, "initial",
            new("https://github.com/owner/repo", ProjectPath: project)), default));
    }

    [Fact]
    public async Task RepoAndRefChangesRetainDirtyLegacySourceAndUseDistinctManagedDirectories()
    {
        var legacy = Path.Combine(root, "core/source");
        var project = CoreDevelopmentService.Project(legacy);
        Directory.CreateDirectory(Path.GetDirectoryName(project)!);
        await File.WriteAllTextAsync(project, "<Project />");
        await DevelopmentWorkspaceService.Git(legacy, ["init", "-b", "main"], default);
        await DevelopmentWorkspaceService.Git(legacy, ["remote", "add", "origin", "https://github.com/owner/old.git"], default);
        CoreLaunchFiles.Write(CoreLaunchFiles.SourcePath(root), new(null, "legacy"), CoreLaunchJson.Default.CoreSourceSettings);
        var previous = await Service.GetAsync();
        Assert.Equal("https://github.com/owner/old.git", previous.Source.RepositoryUrl);
        Assert.Equal(legacy, previous.SourcePath);
        var changed = await Service.SaveAsync(new(null, "legacy", new("https://github.com/owner/new.git")), default);
        var selected = await Service.GetAsync();
        Assert.NotEqual(legacy, selected.SourcePath);
        Assert.True(File.Exists(project));
        Assert.False(Directory.Exists(selected.SourcePath));
        var branch = await Service.SaveAsync(new(null, changed.Revision, new(changed.RepositoryUrl!, "next")), default);
        Assert.NotEqual(selected.SourcePath, (await Service.GetAsync()).SourcePath);
        Assert.Equal("next", branch.Ref);
        Assert.Equal("<Project />", await File.ReadAllTextAsync(project));
    }

    [Fact]
    public async Task SavingUnchangedLegacyDefaultPinsItsMigrationAndRevision()
    {
        CoreLaunchFiles.Write(CoreLaunchFiles.SourcePath(root), new(null, "legacy"), CoreLaunchJson.Default.CoreSourceSettings);
        var projected = await Service.SourceSettingsAsync(default);
        var saved = await Service.SaveAsync(new(null, projected.Revision), default);
        Assert.NotEqual(projected.Revision, saved.Revision);
        Assert.Equal(CoreSourceDefaults.UpdateRepository + ".git", saved.RepositoryUrl);
        Assert.Equal(saved, CoreLaunchFiles.Read(CoreLaunchFiles.SourcePath(root), CoreLaunchJson.Default.CoreSourceSettings));
        Assert.Equal(saved, await Service.SaveAsync(new(null, saved.Revision), default));
        Assert.False(Directory.Exists(Service.SelectedRoot(saved)));
    }

    [Fact]
    public async Task LegacyOverrideWithoutRemoteRemainsUnidentifiedAndUnchanged()
    {
        var folder = Path.Combine(root, "legacy-fork");
        var project = CoreDevelopmentService.Project(folder);
        Directory.CreateDirectory(Path.GetDirectoryName(project)!);
        await File.WriteAllTextAsync(project, "original source");
        CoreLaunchFiles.Write(CoreLaunchFiles.SourcePath(root), new(folder, "legacy"), CoreLaunchJson.Default.CoreSourceSettings);
        var state = await Service.GetAsync();
        Assert.Equal(folder, state.SourcePath);
        Assert.Null(state.Source.RepositoryUrl);
        Assert.Equal(project, await Service.PrepareSourceAsync(state.Source, default));
        Assert.Equal("original source", await File.ReadAllTextAsync(project));
        Assert.Equal(0, CoreLaunchFiles.Read(CoreLaunchFiles.SourcePath(root), CoreLaunchJson.Default.CoreSourceSettings)!.SchemaVersion);
    }

    [Fact]
    public async Task NamedRefAndCustomProjectArePreparedOnceWithoutResettingDirtySource()
    {
        var remote = Path.Combine(root, "remote");
        Directory.CreateDirectory(remote);
        await File.WriteAllTextAsync(Path.Combine(remote, "Engine.csproj"), "<Project />");
        await DevelopmentWorkspaceService.Git(remote, ["init", "-b", "custom"], default);
        await DevelopmentWorkspaceService.Git(remote, ["add", "."], default);
        await DevelopmentWorkspaceService.Git(remote, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "fixture"], default);
        var source = await Service.SaveAsync(new(null, "initial", new("https://git.example.test/core.git", "custom", "Engine.csproj")), default);
        var project = await Service.PrepareSourceAsync(source, default, remote);
        await File.AppendAllTextAsync(project, "<!-- live edit -->");
        Directory.Move(remote, remote + "-offline");
        Assert.Equal(project, await Service.PrepareSourceAsync(source, default, remote));
        Assert.Contains("live edit", await File.ReadAllTextAsync(project));
    }

    [Theory]
    [InlineData("../branch")]
    [InlineData("refs/heads/invalid..name")]
    [InlineData("--option")]
    public async Task InvalidRefDoesNotPersistOrPrepare(string reference)
    {
        await Assert.ThrowsAsync<ArgumentException>(() => Service.SaveAsync(new(null, "initial",
            new("https://git.example.test/core", reference)), default));
        Assert.False(File.Exists(CoreLaunchFiles.SourcePath(root)));
    }

    [Fact]
    public async Task MissingProjectPreparationCleansOnlyItsTemporaryClone()
    {
        var remote = Path.Combine(root, "remote");
        Directory.CreateDirectory(remote);
        await File.WriteAllTextAsync(Path.Combine(remote, "keep.txt"), "retained");
        await DevelopmentWorkspaceService.Git(remote, ["init", "-b", "main"], default);
        await DevelopmentWorkspaceService.Git(remote, ["add", "."], default);
        await DevelopmentWorkspaceService.Git(remote, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "fixture"], default);
        var source = await Service.SaveAsync(new(null, "initial", new("https://git.example.test/core")), default);
        await Assert.ThrowsAsync<InvalidOperationException>(() => Service.PrepareSourceAsync(source, default, remote));
        Assert.Empty(Directory.GetDirectories(Path.Combine(root, "core", "sources")));
        Assert.Equal("retained", await File.ReadAllTextAsync(Path.Combine(remote, "keep.txt")));
        Assert.Equal(source.Revision, (await Service.GetAsync()).Source.Revision);
    }

    [Fact]
    public void BuildIdentityDoesNotFollowLaterCheckoutChanges()
    {
        var snapshot = CoreBuildProvenance.Current;
        Assert.NotNull(snapshot.Commit);
        Assert.NotNull(snapshot.Dirty);
        Assert.EndsWith("Haas.Hosty.Core.csproj", snapshot.Project);
        Assert.Same(snapshot, CoreBuildProvenance.Current);
        Assert.Null(CoreBuildProvenance.FromAssembly(typeof(CoreSourceConfigurationTests).Assembly).Commit);
        Assert.Null(CoreBuildProvenance.SafeRepository("https://secret@github.com/owner/repo"));
    }

    public void Dispose()
    {
        if (!Directory.Exists(root)) return;
        foreach (var file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
            File.SetAttributes(file, File.GetAttributes(file) & ~FileAttributes.ReadOnly);
        Directory.Delete(root, true);
    }
}
