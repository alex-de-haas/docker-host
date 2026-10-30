using System.Text;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class AgentSkillLibraryTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "hosty-skill-test-" + Guid.NewGuid().ToString("N"));
    private readonly FakeGit git = new();
    private readonly AgentSkillLibrary library;

    public AgentSkillLibraryTests()
    {
        Directory.CreateDirectory(root);
        library = new(new(root, Path.Combine(root, "core"), Path.Combine(root, "apps"), Path.Combine(root, "backups"),
            Path.Combine(root, "sources"), Path.Combine(root, "auth"), Path.Combine(root, "audit")), git, new NoCredentials(), new Clock());
    }

    public void Dispose() => AgentSkillCheckoutCleanup.Delete(root);

    private static AgentSkillPackage Package(string name, string value = "first") =>
        AgentSkillPackages.Validate([
            new("SKILL.md", Encoding.UTF8.GetBytes($"---\nname: {name}\ndescription: >-\n  A reusable skill\n  for tests.\nmetadata:\n  category: testing\n---\nRead references/result.txt.\n")),
            new("references/result.txt", Encoding.UTF8.GetBytes(value)),
            new("scripts/check.sh", Encoding.UTF8.GetBytes("#!/bin/sh\nprintf ok\n"), true)
        ], name);

    [Fact]
    public async Task CorePackagesWorkWithoutAppsOrGitAndKeepTheDevelopmentSkillOptional()
    {
        git.Fail = true;
        var catalog = await library.CatalogAsync(default);
        Assert.Equal(new[] { "hosty-app-skill", "hosty-platform" }, catalog.Skills.Select(s => s.Name).ToArray());
        Assert.All(catalog.Skills, skill =>
        {
            Assert.Equal("core", skill.SourceKind);
            Assert.Equal(CoreStatusResponse.PlatformVersionString, skill.CoreVersion);
            Assert.Null(skill.AppId);
        });
        var empty = await library.ExportAsync("app:unrelated.consumer", new("empty", []), default);
        Assert.Empty(empty.Skills);
        Assert.Null(empty.PlatformIntroduction);
        var context = await library.ExportAsync("app:unrelated.consumer", new("context", [], IncludePlatform: true), default);
        Assert.Equal(CoreAgentSkills.PlatformId, Assert.Single(context.Skills).Id);
        var intro = Assert.IsType<AgentPlatformIntroduction>(context.PlatformIntroduction);
        var file = await library.ContentAsync(intro.SkillId, intro.Path, default);
        Assert.Equal(intro.Text, Encoding.UTF8.GetString(file.Content));
        Assert.Equal(intro.Text, await File.ReadAllTextAsync(Path.Combine(context.Path, "hosty-platform", intro.Path)));
        var dev = catalog.Skills.Single(s => s.Name == "hosty-app-skill");
        var selected = await library.ExportAsync("app:unrelated.consumer", new("developer", [dev.Id, CoreAgentSkills.PlatformId], true), default);
        Assert.Equal(2, selected.Skills.Length);
        Assert.True(File.Exists(Path.Combine(selected.Path, "hosty-app-skill/references/sdk-and-app-creation.md")));
        Assert.Equal(0, git.Checkouts);
    }

    [Fact]
    public async Task CorePackagesDoNotConsumeTheManagedLibraryCapacity()
    {
        var packages = Enumerable.Range(0, 200).ToDictionary(i => "skill-" + i, i => Package("skill-" + i));
        await library.ReplaceAppAsync("example.full", "1", packages, default);
        var catalog = await library.CatalogAsync(default);
        Assert.Equal(202, catalog.Skills.Length);
        var export = await library.ExportAsync("control", new("all", catalog.Skills.Select(s => s.Id).ToArray(), true), default);
        Assert.Equal(202, export.Skills.Length);
        Assert.Equal(202, Directory.GetDirectories(export.Path).Length);
    }

    [Theory]
    [InlineData("hosty-platform")]
    [InlineData("hosty-app-skill")]
    public async Task CorePackagesCannotBeRemovedUpdatedOrShadowed(string name)
    {
        var id = AgentSkillLibrary.Id("core", name);
        var remove = await Assert.ThrowsAsync<AppLifecycleException>(() => library.RemoveAsync(id, default));
        Assert.Equal("skill_core_managed", remove.Code);
        var update = await Assert.ThrowsAsync<AppLifecycleException>(() => library.UpdateAsync("admin", new([id]), true, default));
        Assert.Equal("skill_core_managed", update.Code);
        var app = await Assert.ThrowsAsync<AppLifecycleException>(() => library.ReplaceAppAsync("unrelated.producer", "1",
            new Dictionary<string, AgentSkillPackage> { ["default"] = Package(name) }, default));
        Assert.Equal("skill_name_conflict", app.Code);
        git.Packages = new() { ["skills/" + name] = Package(name) };
        var source = new AgentSkillGitRequest("https://example.test/skills.git");
        var discovery = await library.DiscoverAsync("admin", source, default);
        var install = await Assert.ThrowsAsync<AppLifecycleException>(() => library.InstallAsync("admin",
            new(source, discovery.Commit, ["skills/" + name]), default));
        Assert.Equal("skill_name_conflict", install.Code);
        Assert.Equal(2, (await library.CatalogAsync(default)).Skills.Length);
    }

    [Fact]
    public async Task RecoveryUsesPackagedBytesAndPreservesLegacySameNameSelections()
    {
        var core = CoreAgentSkills.Entries.Single(e => e.Info.Id == CoreAgentSkills.PlatformId);
        var legacy = new AgentSkillEntry(core.Info with { Id = AgentSkillLibrary.Id("git", "legacy"), SourceKind = "git",
            CoreVersion = null, IntroductionPath = null }, Package("hosty-platform", "legacy").Files);
        await JsonStorage.WriteAsync(Path.Combine(root, "core/skills/library.json"), new AgentSkillLibraryState([legacy], []), false, default);
        var old = await library.ExportAsync("control", new("legacy", [legacy.Info.Id]), default);
        var conflict = await Assert.ThrowsAsync<AppLifecycleException>(() => library.ExportAsync("control", new("legacy", [legacy.Info.Id], true), default));
        Assert.Equal("skill_name_conflict", conflict.Code);
        Assert.Equal("legacy", await File.ReadAllTextAsync(Path.Combine(old.Path, "hosty-platform/references/result.txt")));
        var current = await library.ExportAsync("control", new("current", [], true), default);
        var path = Path.Combine(current.Path, "hosty-platform", CoreAgentSkills.IntroductionPath);
        await File.WriteAllTextAsync(path, "old version");
        await library.RecoverExportsAsync(default);
        Assert.Equal(CoreAgentSkills.Introduction().Text, await File.ReadAllTextAsync(path));
        Assert.Equal("legacy", await File.ReadAllTextAsync(Path.Combine(old.Path, "hosty-platform/references/result.txt")));
        Assert.Equal(3, (await library.CatalogAsync(default)).Skills.Length);
    }

    [Fact]
    public async Task SelectedExportsAreIndependentAndFollowCurrentFilesWithoutPinning()
    {
        await library.ReplaceAppAsync("example", "1", new Dictionary<string, AgentSkillPackage>
            { ["first"] = Package("first"), ["second"] = Package("second") }, default);
        var first = AgentSkillLibrary.Id("app", "example", "first");
        var second = AgentSkillLibrary.Id("app", "example", "second");
        var a = await library.ExportAsync("app:consumer", new("session-a", [first, "deleted-id"]), default);
        var b = await library.ExportAsync("app:consumer", new("session-b", [second]), default);
        Assert.NotEqual(a.Path, b.Path);
        Assert.Single(Directory.GetDirectories(a.Path));
        Assert.False(Directory.Exists(Path.Combine(a.Path, "second")));
        await library.ReplaceAppAsync("example", "2", new Dictionary<string, AgentSkillPackage>
            { ["first"] = Package("first", "updated") }, default);
        Assert.Equal("updated", await File.ReadAllTextAsync(Path.Combine(a.Path, "first/references/result.txt")));
        Assert.Empty(Directory.GetDirectories(b.Path));
        await library.ReplaceAppAsync("example", "3", new Dictionary<string, AgentSkillPackage>(), default);
        Assert.Empty(Directory.GetDirectories(a.Path));
        Assert.Empty((await library.ExportAsync("app:consumer", new("session-a", [first]), default)).Skills);
    }

    [Fact]
    public async Task NameCollisionDoesNotChangeExistingLibraryOrExports()
    {
        await library.ReplaceAppAsync("one", "1", new Dictionary<string, AgentSkillPackage> { ["guide"] = Package("guide") }, default);
        var export = await library.ExportAsync("control", new("one", [AgentSkillLibrary.Id("app", "one", "guide")]), default);
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => library.ReplaceAppAsync("two", "1",
            new Dictionary<string, AgentSkillPackage> { ["guide"] = Package("guide", "wrong") }, default));
        Assert.Equal("skill_name_conflict", error.Code);
        Assert.Single((await library.CatalogAsync(default)).Skills.Where(s => s.SourceKind != "core").ToArray());
        Assert.Equal("first", await File.ReadAllTextAsync(Path.Combine(export.Path, "guide/references/result.txt")));
    }

    [Fact]
    public async Task GitSelectionAndUpdatesShareCheckoutAndDoNotApplyChecks()
    {
        git.Packages = new() { ["skills/first"] = Package("first"), ["skills/second"] = Package("second") };
        var source = new AgentSkillGitRequest("https://example.test/skills.git");
        var discovery = await library.DiscoverAsync("admin", source, default);
        Assert.Equal(2, discovery.Skills.Length);
        await library.InstallAsync("admin", new(source, discovery.Commit, ["skills/first", "skills/second"]), default);
        var ids = (await library.CatalogAsync(default)).Skills.Where(s => s.SourceKind != "core").ToArray().Select(s => s.Id).ToArray();
        git.Commit = "second";
        git.Packages = new() { ["skills/first"] = Package("first", "new") };
        var before = git.Checkouts;
        var check = await library.UpdateAsync("admin", new(ids), false, default);
        Assert.Equal(before + 1, git.Checkouts);
        Assert.Contains(check.Skills, s => s.Removed);
        Assert.Equal(2, (await library.CatalogAsync(default)).Skills.Where(s => s.SourceKind != "core").ToArray().Length);
        await library.UpdateAsync("admin", new(ids), true, default);
        Assert.Single((await library.CatalogAsync(default)).Skills.Where(s => s.SourceKind != "core").ToArray());
        git.Fail = true;
        var failed = await library.UpdateAsync("admin", new(ids), false, default);
        Assert.NotNull(Assert.Single(failed.Skills).Error);
        await Assert.ThrowsAsync<AppLifecycleException>(() => library.UpdateAsync("admin", new(ids), true, default));
        Assert.Single((await library.CatalogAsync(default)).Skills.Where(s => s.SourceKind != "core").ToArray());
    }

    [Fact]
    public async Task RepositoryRootPackageUsesCurrentSourceGrantAndSurvivesRevocation()
    {
        var sourcePath = Path.Combine(root, "remote");
        foreach (var file in Package("root-guide").Files)
        {
            var target = Path.Combine(sourcePath, file.Path);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            await File.WriteAllBytesAsync(target, file.Content);
        }
        await DevelopmentWorkspaceService.Git(sourcePath, ["init"], default);
        await DevelopmentWorkspaceService.Git(sourcePath, ["add", "."], default);
        await DevelopmentWorkspaceService.Git(sourcePath, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Fixture"], default);
        var paths = new CoreDataPaths(root, Path.Combine(root, "core"), Path.Combine(root, "apps"), Path.Combine(root, "backups"),
            Path.Combine(root, "sources"), Path.Combine(root, "auth"), Path.Combine(root, "audit"));
        var access = new CoreLifecycleServiceTests.RemoteGitFixture(sourcePath);
        var current = new AgentSkillLibrary(paths, new AgentSkillGit(paths, access), access, new Clock());
        var source = new AgentSkillGitRequest(CoreLifecycleServiceTests.RemoteGitFixture.Url, ConnectionId: "source-account");
        var discovered = await current.DiscoverAsync("admin", source, default);
        Assert.Equal("", Assert.Single(discovered.Skills).Path);
        await current.InstallAsync("admin", new(source, discovered.Commit, [""]), default);
        var skill = Assert.Single((await current.CatalogAsync(default)).Skills.Where(s => s.SourceKind != "core").ToArray());
        var export = await current.ExportAsync("control", new("current", [skill.Id]), default);
        Assert.Equal(3, Directory.GetFiles(Path.Combine(export.Path, "root-guide"), "*", SearchOption.AllDirectories).Length);
        access.Revoked = true;
        Assert.NotNull(Assert.Single((await current.UpdateAsync("admin", new([skill.Id]), false, default)).Skills).Error);
        await Assert.ThrowsAsync<AppLifecycleException>(() => current.UpdateAsync("admin", new([skill.Id]), true, default));
        Assert.Equal(skill, Assert.Single((await current.CatalogAsync(default)).Skills.Where(s => s.SourceKind != "core").ToArray()));
        Assert.Equal("first", await File.ReadAllTextAsync(Path.Combine(export.Path, "root-guide/references/result.txt")));
        access.Revoked = false;
        await Assert.ThrowsAsync<AppLifecycleException>(() => current.UpdateAsync("another-admin", new([skill.Id]), true, default));
        Assert.Empty(Directory.GetDirectories(Path.Combine(root, "core/skills/fetch")));
    }

    [Fact]
    public async Task ChangedDiscoveryCannotSilentlyInstallAnotherCommit()
    {
        git.Packages = new() { ["first"] = Package("first") };
        var source = new AgentSkillGitRequest("https://example.test/skills.git");
        var discovery = await library.DiscoverAsync("admin", source, default);
        git.Commit = "moved";
        await Assert.ThrowsAsync<AppLifecycleException>(() => library.InstallAsync("admin", new(source, discovery.Commit, ["first"]), default));
        Assert.Empty((await library.CatalogAsync(default)).Skills.Where(s => s.SourceKind != "core").ToArray());
    }

    [Theory]
    [InlineData("../escape")]
    [InlineData("NUL.txt")]
    [InlineData("references/COM1")]
    [InlineData("/absolute")]
    [InlineData("a/../b")]
    [InlineData("a\\b")]
    [InlineData("C:/file")]
    [InlineData("a//b")]
    public void InvalidPathsAreRefused(string path) => Assert.Throws<AppLifecycleException>(() => AgentSkillPackages.RelativePath(path));

    [Fact]
    public void PortableMetadataAndFilesAreValidated()
    {
        Assert.Equal("A reusable skill for tests.", Package("valid").Description);
        var valid = Package("valid").Files;
        Assert.Throws<AppLifecycleException>(() => AgentSkillPackages.Validate(valid, "other"));
        Assert.Throws<AppLifecycleException>(() => AgentSkillPackages.Validate([.. valid, new("skill.md", [])]));
        Assert.Throws<AppLifecycleException>(() => AgentSkillPackages.Validate([.. valid, new("references", [])]));
        Assert.Throws<AppLifecycleException>(() => AgentSkillPackages.Validate([
            new("SKILL.md", Encoding.UTF8.GetBytes("---\nname: valid\nname: other\ndescription: duplicate\n---\n"))]));
    }

    [Fact]
    public async Task PackageLinksCannotEscapeSource()
    {
        if (OperatingSystem.IsWindows()) return;
        var path = Path.Combine(root, "linked");
        Directory.CreateDirectory(path);
        await File.WriteAllBytesAsync(Path.Combine(path, "SKILL.md"), Package("linked").Files[0].Content);
        File.CreateSymbolicLink(Path.Combine(path, "outside"), Path.Combine(root, "secret"));
        await Assert.ThrowsAsync<AppLifecycleException>(() => AgentSkillPackages.ReadAsync(path, default));
    }

    [Fact]
    public async Task ExportOwnerCannotRemoveAnotherConsumersExport()
    {
        var a = await library.ExportAsync("app:a", new("same-context", []), default);
        var b = await library.ExportAsync("app:b", new("same-context", []), default);
        Assert.NotEqual(a.Id, b.Id);
        await library.ReleaseExportAsync("app:b", a.Id, default);
        Assert.True(Directory.Exists(a.Path));
        await library.ReleaseExportAsync("app:a", a.Id, default);
        Assert.False(Directory.Exists(a.Path));
    }

    [Fact]
    public async Task FailedAppCommitAndConcurrentNameCollisionPreserveCurrentPackages()
    {
        await library.ReplaceAppAsync("one", "1", new Dictionary<string, AgentSkillPackage> { ["guide"] = Package("guide") }, default);
        var export = await library.ExportAsync("control", new("current", [AgentSkillLibrary.Id("app", "one", "guide")]), default);
        await Assert.ThrowsAsync<InvalidOperationException>(() => library.ReplaceAppAsync("one", "2",
            new Dictionary<string, AgentSkillPackage> { ["guide"] = Package("guide", "uncommitted") }, default,
            () => throw new InvalidOperationException("App validation refused")));
        Assert.Equal("1", Assert.Single((await library.CatalogAsync(default)).Skills.Where(s => s.SourceKind != "core").ToArray()).AppVersion);
        Assert.Equal("first", await File.ReadAllTextAsync(Path.Combine(export.Path, "guide/references/result.txt")));
        var committed = false;
        await Assert.ThrowsAsync<AppLifecycleException>(() => library.ReplaceAppAsync("two", "1",
            new Dictionary<string, AgentSkillPackage> { ["guide"] = Package("guide") }, default,
            () => { committed = true; return Task.CompletedTask; }));
        Assert.False(committed);
    }

    [Fact]
    public async Task ExportPreparationFailureDoesNotCommitAppOrReplaceCurrentState()
    {
        await library.ReplaceAppAsync("one", "1", new Dictionary<string, AgentSkillPackage> { ["guide"] = Package("guide") }, default);
        var export = await library.ExportAsync("control", new("current", [AgentSkillLibrary.Id("app", "one", "guide")]), default);
        var staging = Path.Combine(root, "core/skills/staging");
        Directory.Delete(staging, true);
        await File.WriteAllTextAsync(staging, "Prevent staging to simulate an unavailable filesystem.");
        var committed = false;
        await Assert.ThrowsAnyAsync<IOException>(() => library.ReplaceAppAsync("one", "2",
            new Dictionary<string, AgentSkillPackage> { ["guide"] = Package("guide", "unpublished") }, default,
            () => { committed = true; return Task.CompletedTask; }));
        Assert.False(committed);
        Assert.Equal("1", Assert.Single((await library.CatalogAsync(default)).Skills.Where(s => s.SourceKind != "core").ToArray()).AppVersion);
        Assert.Equal("first", await File.ReadAllTextAsync(Path.Combine(export.Path, "guide/references/result.txt")));
    }

    [Fact]
    public async Task PublicationFinishesIfCallerCancelsAfterAppCommit()
    {
        await library.ReplaceAppAsync("one", "1", new Dictionary<string, AgentSkillPackage> { ["guide"] = Package("guide") }, default);
        var export = await library.ExportAsync("control", new("current", [AgentSkillLibrary.Id("app", "one", "guide")]), default);
        using var cancellation = new CancellationTokenSource();
        await library.ReplaceAppAsync("one", "2", new Dictionary<string, AgentSkillPackage> { ["guide"] = Package("guide", "committed") },
            cancellation.Token, () => { cancellation.Cancel(); return Task.CompletedTask; });
        Assert.Equal("2", Assert.Single((await library.CatalogAsync(default)).Skills.Where(s => s.SourceKind != "core").ToArray()).AppVersion);
        Assert.Equal("committed", await File.ReadAllTextAsync(Path.Combine(export.Path, "guide/references/result.txt")));
    }

    [Fact]
    public async Task RecoveryReconstructsOnlyCurrentSelectedPackages()
    {
        await library.ReplaceAppAsync("one", "1", new Dictionary<string, AgentSkillPackage> { ["guide"] = Package("guide") }, default);
        var export = await library.ExportAsync("control", new("current", [AgentSkillLibrary.Id("app", "one", "guide")]), default);
        await library.ReplaceAppAsync("one", "2", new Dictionary<string, AgentSkillPackage> { ["guide"] = Package("guide", "current") }, default);
        Directory.Delete(export.Path, true);
        await library.RecoverExportsAsync(default);
        Assert.Equal("current", await File.ReadAllTextAsync(Path.Combine(export.Path, "guide/references/result.txt")));
        var contents = await File.ReadAllTextAsync(Path.Combine(root, "core/skills/library.json"));
        Assert.DoesNotContain(Convert.ToBase64String(Encoding.UTF8.GetBytes("first")), contents);
        Assert.Single(Directory.GetDirectories(export.Path));
    }

    [Fact]
    public async Task RecoveryRemovesReadOnlyGitPacksWithoutChangingInstalledSkills()
    {
        await library.ReplaceAppAsync("one", "1", new Dictionary<string, AgentSkillPackage> { ["guide"] = Package("guide") }, default);
        var export = await library.ExportAsync("control", new("current", [AgentSkillLibrary.Id("app", "one", "guide")]), default);
        var statePath = Path.Combine(root, "core/skills/library.json");
        var before = await File.ReadAllBytesAsync(statePath);
        var fetch = Path.Combine(root, "core/skills/fetch");
        var pack = Path.Combine(fetch, "interrupted/.git/objects/pack/pack-test.idx");
        Directory.CreateDirectory(Path.GetDirectoryName(pack)!);
        await File.WriteAllTextAsync(pack, "read-only Git pack index");
        File.SetAttributes(pack, File.GetAttributes(pack) | FileAttributes.ReadOnly);
        try
        {
            await library.RecoverExportsAsync(default);
            Assert.False(Directory.Exists(fetch));
            Assert.Equal(before, await File.ReadAllBytesAsync(statePath));
            Assert.Equal("first", await File.ReadAllTextAsync(Path.Combine(export.Path, "guide/references/result.txt")));
            Assert.Single((await library.CatalogAsync(default)).Skills.Where(s => s.SourceKind != "core").ToArray());
        }
        finally { if (File.Exists(pack)) File.SetAttributes(pack, FileAttributes.Normal); }
    }

    [Fact]
    public async Task RecoveryRetainsLockedFetchFilesAndRetriesAfterReleaseOnWindows()
    {
        if (!OperatingSystem.IsWindows()) return;
        await library.ReplaceAppAsync("one", "1", new Dictionary<string, AgentSkillPackage> { ["guide"] = Package("guide") }, default);
        var fetch = Path.Combine(root, "core/skills/fetch");
        Directory.CreateDirectory(fetch);
        var file = Path.Combine(fetch, "locked");
        await File.WriteAllTextAsync(file, "pending cleanup");
        using (new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            await library.RecoverExportsAsync(default);
            Assert.True(File.Exists(file));
            Assert.Single((await library.CatalogAsync(default)).Skills.Where(s => s.SourceKind != "core").ToArray());
        }
        await library.RecoverExportsAsync(default);
        Assert.False(Directory.Exists(fetch));
    }

    [Fact]
    public void CheckoutDisposalRemovesReadOnlyFiles()
    {
        var checkout = Path.Combine(root, "checkout");
        Directory.CreateDirectory(Path.Combine(checkout, ".git/objects/pack"));
        var file = Path.Combine(checkout, ".git/objects/pack/pack-test.pack");
        File.WriteAllText(file, "temporary pack");
        File.SetAttributes(file, File.GetAttributes(file) | FileAttributes.ReadOnly);
        try
        {
            new AgentSkillCheckout(checkout, "test").Dispose();
            Assert.False(Directory.Exists(checkout));
        }
        finally { if (File.Exists(file)) File.SetAttributes(file, FileAttributes.Normal); }
    }

    [Fact]
    public async Task CheckoutCleanupDoesNotFollowLinksOrChangeTheirTargets()
    {
        var outside = Path.Combine(root, "outside");
        var checkout = Path.Combine(root, "checkout");
        Directory.CreateDirectory(outside);
        Directory.CreateDirectory(checkout);
        var file = Path.Combine(outside, "keep");
        File.WriteAllText(file, "preserved");
        File.SetAttributes(file, File.GetAttributes(file) | FileAttributes.ReadOnly);
        var attributes = File.GetAttributes(file);
        try
        {
            if (OperatingSystem.IsWindows())
            {
                // Junctions exercise the reparse boundary without requiring symlink privileges.
                var start = new System.Diagnostics.ProcessStartInfo("cmd.exe") { UseShellExecute = false };
                foreach (var argument in new[] { "/c", "mklink", "/J", Path.Combine(checkout, "directory-link"), outside })
                    start.ArgumentList.Add(argument);
                var result = await ProcessRunner.RunAsync(start, TimeSpan.FromSeconds(10), default);
                Assert.Equal(0, result.ExitCode);
            }
            else
            {
                Directory.CreateSymbolicLink(Path.Combine(checkout, "directory-link"), outside);
                File.CreateSymbolicLink(Path.Combine(checkout, "file-link"), file);
            }
            new AgentSkillCheckout(checkout, "test").Dispose();
            Assert.False(Directory.Exists(checkout));
            Assert.Equal("preserved", File.ReadAllText(file));
            Assert.Equal(attributes, File.GetAttributes(file));
        }
        finally { File.SetAttributes(file, FileAttributes.Normal); }
    }

    [Fact]
    public async Task NullCollectionsAndPathsAreValidationErrors()
    {
        Assert.Throws<AppLifecycleException>(() => AgentSkillPackages.RelativePath(null!));
        await Assert.ThrowsAsync<AppLifecycleException>(() => library.ExportAsync("control", new("context", null!), default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => library.UpdateAsync("admin", new(null!), true, default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => library.InstallAsync("admin", new(new("https://example.test/repo"), "head", null!), default));
    }

    private sealed class Clock : IClock { public DateTimeOffset UtcNow => DateTimeOffset.UtcNow; }

    [Fact]
    public async Task SelectedImportSupportsLargeCatalogAndIgnoresUnselectedAncillaryFiles()
    {
        git.Packages = Enumerable.Range(0, 240).ToDictionary(i => "skills/guide-" + i, i => Package("guide-" + i));
        git.Packages["skills/guide-100"] = Package("guide-100") with
            { Files = [.. Package("guide-100").Files, new(".git/config", [])] };
        var source = new AgentSkillGitRequest("https://example.test/catalog");
        var selection = await library.DiscoverSelectedAsync(new(source, ["guide-0", "guide-239"]), default);
        Assert.Equal(new[] { "guide-0", "guide-239" }, selection.Skills.Select(s => s.Name));
        var installed = await library.InstallSelectedAsync(new(source, selection.Commit, ["guide-0", "guide-239"]), default);
        Assert.Equal(2, git.Checkouts);
        Assert.Equal(2, installed.Skills.Length);
        Assert.Equal(4, (await library.CatalogAsync(default)).Skills.Length);
        var export = await library.ExportAsync("app:independent.consumer", new("selected", installed.Skills.Select(s => s.Id).ToArray()), default);
        Assert.Equal("first", File.ReadAllText(Path.Combine(export.Path, "guide-239/references/result.txt")));
        var invalid = await Assert.ThrowsAsync<AppLifecycleException>(() => library.InstallSelectedAsync(
            new(source, selection.Commit, ["guide-0", "guide-100"]), default));
        Assert.Equal("skill_package_invalid", invalid.Code);
        Assert.Equal(4, (await library.CatalogAsync(default)).Skills.Length);
    }

    [Fact]
    public async Task SelectedDiscoveryIgnoresOversizedInstructionBodiesUntilInstallation()
    {
        var oversized = Package("oversized");
        oversized = oversized with { Files = [new("SKILL.md", [.. oversized.Files[0].Content, .. new byte[AgentSkillPackages.MaxInstructionsBytes]])] };
        git.Packages = new() { ["guide"] = Package("guide"), ["oversized"] = oversized };
        var source = new AgentSkillGitRequest("https://example.test/catalog");
        var selection = await library.DiscoverSelectedAsync(new(source, ["guide", "oversized"]), default);
        Assert.Equal(new[] { "guide", "oversized" }, selection.Skills.Select(s => s.Name));
        Assert.Single((await library.InstallSelectedAsync(new(source, selection.Commit, ["guide"]), default)).Skills);
        var invalid = await Assert.ThrowsAsync<AppLifecycleException>(() => library.InstallSelectedAsync(new(source, selection.Commit, ["oversized"]), default));
        Assert.Equal("skill_package_invalid", invalid.Code);
        Assert.Equal("guide", Assert.Single((await library.CatalogAsync(default)).Skills, s => s.SourceKind != "core").Name);
    }

    [Theory]
    [InlineData("\n", false)]
    [InlineData("\r\n", true)]
    public async Task SelectedMetadataSupportsBoundedMultilineHeadersAndEndOfFile(string newline, bool bom)
    {
        var path = Path.Combine(root, "metadata");
        Directory.CreateDirectory(path);
        var text = (bom ? "\uFEFF" : "") + "---\nname: guide\ndescription: >-\n  Reusable résumé\n  for tests.\nmetadata:\n  note: " + new string('x', 5000) + "\n---";
        await File.WriteAllTextAsync(Path.Combine(path, "SKILL.md"), text.Replace("\n", newline));
        var metadata = await AgentSkillPackages.ReadMetadataAsync(path, default);
        Assert.Equal("guide", metadata.Name);
        Assert.Equal("Reusable résumé for tests.", metadata.Description);
        await File.WriteAllTextAsync(Path.Combine(path, "SKILL.md"), text.Replace(new string('x', 5000), new string('x', AgentSkillPackages.MaxInstructionsBytes)));
        await Assert.ThrowsAsync<AppLifecycleException>(() => AgentSkillPackages.ReadMetadataAsync(path, default));
    }

    [Fact]
    public async Task SelectedImportResolvesMetadataNamesAndRejectsAmbiguityWithoutPublishing()
    {
        git.Packages = new() { ["a/guide"] = Package("guide"), ["b/guide"] = Package("guide") };
        var source = new AgentSkillGitRequest("https://example.test/catalog");
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => library.DiscoverSelectedAsync(new(source, ["guide"]), default));
        Assert.Equal("skill_name_ambiguous", error.Code);
        Assert.Contains("a/guide", error.Message);
        Assert.Contains("b/guide", error.Message);
        Assert.Equal(2, (await library.CatalogAsync(default)).Skills.Length);
        var narrowed = source with { Path = "a" };
        var selection = await library.DiscoverSelectedAsync(new(narrowed, ["guide"]), default);
        Assert.Equal("a/guide", Assert.Single(selection.Skills).Path);
        await library.InstallSelectedAsync(new(narrowed, selection.Commit, ["guide"]), default);
        git.Packages = new() { ["aliases/unrelated-directory"] = Package("named-guide") };
        selection = await library.DiscoverSelectedAsync(new(source, ["named-guide"]), default);
        Assert.Equal("aliases/unrelated-directory", Assert.Single(selection.Skills).Path);
        // Metadata selects the candidate; full installation still enforces the portable package contract.
        error = await Assert.ThrowsAsync<AppLifecycleException>(() => library.InstallSelectedAsync(new(source, selection.Commit, ["named-guide"]), default));
        Assert.Equal("skill_package_invalid", error.Code);
    }

    [Fact]
    public async Task SelectedImportMissingNamesOrMovedSourcePreserveLibraryAndExports()
    {
        git.Packages = new() { ["guide"] = Package("guide"), ["other"] = Package("other") };
        var source = new AgentSkillGitRequest("https://example.test/catalog");
        var selection = await library.DiscoverSelectedAsync(new(source, ["guide", "other"]), default);
        var installed = await library.InstallSelectedAsync(new(source, selection.Commit, ["guide", "other"]), default);
        var export = await library.ExportAsync("control", new("ongoing", installed.Skills.Select(s => s.Id).ToArray()), default);
        var missing = await Assert.ThrowsAsync<AppLifecycleException>(() => library.InstallSelectedAsync(new(source, selection.Commit, ["guide", "missing"]), default));
        Assert.Equal("skill_not_found", missing.Code);
        git.Commit = "changed";
        git.Packages["guide"] = Package("guide", "second");
        var moved = await Assert.ThrowsAsync<AppLifecycleException>(() => library.InstallSelectedAsync(new(source, selection.Commit, ["guide"]), default));
        Assert.Equal("skill_source_changed", moved.Code);
        Assert.Equal("first", File.ReadAllText(Path.Combine(export.Path, "guide/references/result.txt")));
        selection = await library.DiscoverSelectedAsync(new(source, ["guide"]), default);
        var replacement = Assert.Single((await library.InstallSelectedAsync(new(source, selection.Commit, ["guide"]), default)).Skills);
        Assert.Equal(installed.Skills[0].Id, replacement.Id);
        Assert.Equal("changed", replacement.Commit);
        Assert.Equal("second", File.ReadAllText(Path.Combine(export.Path, "guide/references/result.txt")));
        Assert.Equal("first", File.ReadAllText(Path.Combine(export.Path, "other/references/result.txt")));
        Assert.Equal(4, (await library.CatalogAsync(default)).Skills.Length);
    }

    [Fact]
    public async Task SelectedImportRefusesPrivateConnectionsBeforeFetching()
    {
        var source = new AgentSkillGitRequest("https://example.test/private", ConnectionId: "someone-elses-connection");
        var discovery = await Assert.ThrowsAsync<AppLifecycleException>(() => library.DiscoverSelectedAsync(new(source, ["guide"]), default));
        var install = await Assert.ThrowsAsync<AppLifecycleException>(() => library.InstallSelectedAsync(new(source, "commit", ["guide"]), default));
        Assert.Equal("source_access_required", discovery.Code);
        Assert.Equal(discovery.Code, install.Code);
        Assert.Equal(0, git.Checkouts);
    }

    [Fact]
    public async Task SelectedImportEnforcesNamesReservedPackagesAndLibraryCapacity()
    {
        var source = new AgentSkillGitRequest("https://example.test/catalog");
        foreach (var names in new string[][] { null!, [], ["INVALID"], Enumerable.Range(0, 201).Select(i => "guide-" + i).ToArray() })
            await Assert.ThrowsAsync<AppLifecycleException>(() => library.DiscoverSelectedAsync(new(source, names), default));
        Assert.Equal(0, git.Checkouts);
        git.Packages = new() { ["hosty-platform"] = Package("hosty-platform") };
        var reserved = await Assert.ThrowsAsync<AppLifecycleException>(() => library.InstallSelectedAsync(new(source, git.Commit, ["hosty-platform"]), default));
        Assert.Equal("skill_name_conflict", reserved.Code);
        await library.ReplaceAppAsync("independent.producer", "1", Enumerable.Range(0, 200).ToDictionary(i => "guide-" + i, i => Package("guide-" + i)), default);
        git.Packages = new() { ["additional"] = Package("additional") };
        await Assert.ThrowsAsync<AppLifecycleException>(() => library.InstallSelectedAsync(new(source, git.Commit, ["additional"]), default));
        Assert.Equal(202, (await library.CatalogAsync(default)).Skills.Length);
        await library.ReplaceAppAsync("independent.producer", "2", new Dictionary<string, AgentSkillPackage> { ["guide-0"] = Package("guide-0") }, default);
        git.Packages = new() { ["guide-0"] = Package("guide-0") };
        var collision = await Assert.ThrowsAsync<AppLifecycleException>(() => library.InstallSelectedAsync(new(source, git.Commit, ["guide-0"]), default));
        Assert.Equal("skill_name_conflict", collision.Code);
    }

    [Fact]
    public async Task SelectedDiscoveryRejectsInvalidMetadataAndIncompleteScans()
    {
        var source = new AgentSkillGitRequest("https://example.test/catalog");
        git.Packages = new() { ["guide"] = Package("guide"), ["invalid"] = new("invalid", "Invalid", [new("SKILL.md", Encoding.UTF8.GetBytes("not frontmatter"))]) };
        var invalid = await Assert.ThrowsAsync<AppLifecycleException>(() => library.DiscoverSelectedAsync(new(source, ["guide"]), default));
        Assert.Contains("invalid/SKILL.md", invalid.Message);
        git.Packages = new() { ["guide"] = Package("guide"), [string.Join('/', Enumerable.Repeat("nested", 21)) + "/deep"] = Package("deep") };
        var limit = await Assert.ThrowsAsync<AppLifecycleException>(() => library.DiscoverSelectedAsync(new(source, ["guide"]), default));
        Assert.Contains("directory limit", limit.Message);
        Assert.Equal(2, (await library.CatalogAsync(default)).Skills.Length);
    }

    [Fact]
    public async Task SelectedDiscoveryRefusesLinkedMetadataAndSelectedOversizedPackages()
    {
        var source = new AgentSkillGitRequest("https://example.test/catalog");
        git.Packages = new() { ["guide"] = Package("guide") with
            { Files = [new("SKILL.md", new byte[AgentSkillPackages.MaxInstructionsBytes + 1])] } };
        await Assert.ThrowsAsync<AppLifecycleException>(() => library.DiscoverSelectedAsync(new(source, ["guide"]), default));
        git.Packages = new() { ["guide"] = Package("guide") with
            { Files = [.. Package("guide").Files, .. Enumerable.Range(0, 512).Select(i => new AgentSkillFile("extra-" + i, []))] } };
        var selection = await library.DiscoverSelectedAsync(new(source, ["guide"]), default);
        await Assert.ThrowsAsync<AppLifecycleException>(() => library.InstallSelectedAsync(new(source, selection.Commit, ["guide"]), default));
        if (OperatingSystem.IsWindows()) return;
        git.Packages = new() { ["guide"] = Package("guide") };
        git.MutateCheckout = checkout =>
        {
            var instructions = Path.Combine(checkout, "guide", "SKILL.md");
            File.Move(instructions, Path.Combine(checkout, "outside.md"));
            File.CreateSymbolicLink(instructions, "../outside.md");
        };
        var linked = await Assert.ThrowsAsync<AppLifecycleException>(() => library.DiscoverSelectedAsync(new(source, ["guide"]), default));
        Assert.Contains("symbolic link", linked.Message);
    }

    private sealed class FakeGit : IAgentSkillGit
    {
        public Dictionary<string, AgentSkillPackage> Packages { get; set; } = [];
        public string Commit { get; set; } = "first";
        public int Checkouts { get; private set; }
        public bool Fail { get; set; }
        public Action<string>? MutateCheckout { get; set; }
        public async Task<AgentSkillCheckout> CheckoutAsync(AgentSkillGitRequest source, SourceReadGrant? grant, CancellationToken ct)
        {
            if (Fail) throw new AppLifecycleException("skill_source_unavailable", "Source unavailable.");
            Checkouts++;
            var path = Path.Combine(Path.GetTempPath(), "hosty-skill-git-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(path);
            foreach (var (relative, package) in Packages)
                foreach (var file in package.Files)
                {
                    var target = Path.Combine(path, relative, file.Path);
                    Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                    await File.WriteAllBytesAsync(target, file.Content, ct);
                }
            MutateCheckout?.Invoke(path);
            return new(path, Commit);
        }
    }
    private sealed class NoCredentials : ISourceGitAccess
    {
        public string NormalizeRepository(string value) => value;
        public Task<T> WithConnectionAsync<T>(SourceReadGrant grant, Func<UserProviderConnection, Task<T>> action, CancellationToken ct) => throw new NotSupportedException();
        public Task<SourceReadGrant> BindAsync(string owner, string id, string url, bool manifest, CancellationToken ct) => throw new NotSupportedException();
        public Task ValidateAsync(PrivateSourceAccess? access, CancellationToken ct) => throw new NotSupportedException();
        public Task<string> GitAsync(SourceReadGrant grant, string repository, string? directory, IReadOnlyList<string> args, CancellationToken ct) => throw new NotSupportedException();
        public Task<string> GitWithConnectionAsync(SourceReadGrant grant, string repository, string? directory, IReadOnlyList<string> args, UserProviderConnection connection, CancellationToken ct) => throw new NotSupportedException();
    }
}
