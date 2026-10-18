using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static AppCreationRequest NewApp(string id = "test.created") =>
        new(Guid.NewGuid().ToString(), id, "Local notes", "A local app", true, "Test Author", "author@example.test");

    [Fact]
    public async Task AppCreation_PersistsIconAndAuthorInBootstrapAndWorktreeAndRejectsChangedReplay()
    {
        var f = await LifecycleFixture.CreateAsync();
        var owner = WorkspaceTestOwner(f);
        var input = NewApp() with { IconPng = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGPQmXgBiBggFAAo6gY1Dm5YbwAAAABJRU5ErkJggg==" };
        var result = await f.Service.CreateLocalAppAsync(owner, input, new("Profile Author", "profile@example.test"), default);
        var source = result.Operation.SourcePath;
        Assert.Equal(Convert.FromBase64String(input.IconPng), await File.ReadAllBytesAsync(Path.Combine(source, "icon.png")));
        var manifest = System.Text.Json.Nodes.JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(source, "manifest.json")))!;
        Assert.Equal("icon.png", manifest["catalogMetadata"]!["icon"]!.GetValue<string>());
        Assert.Equal("Test Author <author@example.test>", (await DevelopmentWorkspaceService.Git(source, ["log", "-1", "--format=%an <%ae>"], default)).StandardOutput.Trim());
        var tree = await new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock).PrepareAsync(owner,
            new(input.RequestId, owner.SessionId, input.AppId, "/assistant", "main"), default);
        Assert.Equal(Convert.FromBase64String(input.IconPng), await File.ReadAllBytesAsync(Path.Combine(tree.Path, "icon.png")));
        Assert.Equal(result.Operation, (await f.Service.CreateLocalAppAsync(owner, input, null, default)).Operation);
        Assert.Equal("creation_request_conflict", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.CreateLocalAppAsync(owner, input with { IconPng = null }, null, default))).Code);
        var journal = Path.Combine(f.Paths.CoreRoot, "authoring", result.Operation.Id + ".json");
        await JsonStorage.WriteAsync(journal, result.Operation with { Stage = "written" });
        await File.WriteAllBytesAsync(Path.Combine(source, "icon.png"), [1, 2, 3]);
        Assert.Equal("creation_source_changed", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.CreateLocalAppAsync(owner, input, null, default))).Code);
        Assert.Equal(new byte[] { 1, 2, 3 }, await File.ReadAllBytesAsync(Path.Combine(source, "icon.png")));
    }

    [Theory]
    [InlineData("")]
    [InlineData("not base64!")]
    [InlineData("PHN2Zz48L3N2Zz4=")]
    public async Task AppCreation_RejectsInvalidIconBeforeAllocating(string icon)
    {
        var f = await LifecycleFixture.CreateAsync();
        var input = NewApp() with { IconPng = icon };
        Assert.Equal("creation_icon_invalid", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.CreateLocalAppAsync(WorkspaceTestOwner(f), input, null, default))).Code);
        Assert.False(Directory.Exists(f.Paths.ResolveManagedCheckoutPath(input.AppId)));
        Assert.False(Directory.Exists(Path.Combine(f.Paths.CoreRoot, "authoring")));
    }

    [Fact]
    public void AppCreationIcon_RejectsOversizedTruncatedOrCorruptChunks()
    {
        Assert.Throws<AppLifecycleException>(() => AppCreationIcon.Read(Convert.ToBase64String(new byte[128 * 1024 + 1])));
        var bytes = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGPQmXgBiBggFAAo6gY1Dm5YbwAAAABJRU5ErkJggg==");
        Assert.Throws<AppLifecycleException>(() => AppCreationIcon.Read(Convert.ToBase64String(bytes[..^1])));
        bytes[20] ^= 1;
        Assert.Throws<AppLifecycleException>(() => AppCreationIcon.Read(Convert.ToBase64String(bytes)));
        // Adding an optional icon must not change fingerprints for existing icon-free operations.
        Assert.DoesNotContain("iconPng", CoreJson.Text(NewApp()));
    }

    [Fact]
    public async Task AppCreation_CreatesDurableLocalGitAndSeparateWorktreeWithoutStartingRuntime()
    {
        var f = await LifecycleFixture.CreateAsync();
        var owner = WorkspaceTestOwner(f);
        var input = NewApp();
        var result = await f.Service.CreateLocalAppAsync(owner, input, null, default);
        Assert.Equal("installed", result.Operation.Stage);
        var app = (await f.Apps.GetAppAsync(input.AppId))!;
        Assert.False(app.Autostart);
        Assert.Equal("stopped", app.RuntimeState);
        Assert.Equal("local-git", app.SourceState!.Type);
        Assert.Equal(result.Operation.SourcePath, app.SourceState.LocalOverridePath);
        Assert.True(File.Exists(Path.Combine(result.Operation.SourcePath, "manifest.json")));
        Assert.Equal("", (await DevelopmentWorkspaceService.Git(result.Operation.SourcePath, ["remote"], default)).StandardOutput);
        Assert.Equal("1", (await DevelopmentWorkspaceService.Git(result.Operation.SourcePath, ["rev-list", "--count", "HEAD"], default)).StandardOutput.Trim());
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var tree = await service.PrepareAsync(owner, new(input.RequestId, owner.SessionId, input.AppId, "/assistant", "main"), default);
        Assert.NotEqual(tree.Path, result.Operation.SourcePath);
        Assert.Equal(result.Operation.Commit, tree.OriginalBase);
        Assert.Equal("ok", tree.Observation!.State);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "index.html"), "workspace changes");
        Assert.DoesNotContain("workspace changes", await File.ReadAllTextAsync(Path.Combine(result.Operation.SourcePath, "index.html")));
        var replay = await f.Service.CreateLocalAppAsync(owner, input, null, default);
        Assert.Equal(result.Operation, replay.Operation);
        Assert.Equal("workspace changes", await File.ReadAllTextAsync(Path.Combine(tree.Path, "index.html")));
    }

    [Fact]
    public async Task AppCreation_RejectsConsentIdentityCollisionAndForeignReplay()
    {
        var f = await LifecycleFixture.CreateAsync();
        var owner = WorkspaceTestOwner(f);
        var input = NewApp();
        Assert.Equal("creation_commit_consent_required", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.CreateLocalAppAsync(owner, input with { BootstrapCommit = false }, null, default))).Code);
        Assert.Equal("creation_author_required", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.CreateLocalAppAsync(owner, input with { AuthorName = null, AuthorEmail = null }, null, default))).Code);
        var result = await f.Service.CreateLocalAppAsync(owner, input, null, default);
        await Assert.ThrowsAsync<AppIdentityException>(() => f.Service.CreateLocalAppAsync(owner with { SessionId = "other" }, input, null, default));
        Assert.Equal("creation_request_conflict", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.CreateLocalAppAsync(owner, input with { Name = "Changed" }, null, default))).Code);
        Assert.Equal("creation_source_exists", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.CreateLocalAppAsync(owner, input with { RequestId = Guid.NewGuid().ToString() }, null, default))).Code);
        Assert.Equal(result.Operation.Commit, (await DevelopmentWorkspaceService.Git(result.Operation.SourcePath, ["rev-parse", "HEAD"], default)).StandardOutput.Trim());
    }

    [Fact]
    public async Task AppCreation_RejectsExistingFilesAndSymlinksWithoutOverwriting()
    {
        var f = await LifecycleFixture.CreateAsync();
        var input = NewApp();
        var source = f.Paths.ResolveManagedCheckoutPath(input.AppId);
        Directory.CreateDirectory(source);
        await File.WriteAllTextAsync(Path.Combine(source, "mine.txt"), "keep");
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.CreateLocalAppAsync(WorkspaceTestOwner(f), input, null, default));
        Assert.Equal("keep", await File.ReadAllTextAsync(Path.Combine(source, "mine.txt")));
        Assert.False(Directory.Exists(Path.Combine(source, ".git")));
        Assert.Null(await f.Apps.GetAppAsync(input.AppId));
    }

    [Fact]
    public async Task AppCreation_RecoversInstalledOperationBeforeJournalCompletion()
    {
        var f = await LifecycleFixture.CreateAsync();
        var owner = WorkspaceTestOwner(f);
        var input = NewApp();
        var created = await f.Service.CreateLocalAppAsync(owner, input, null, default);
        var path = Path.Combine(f.Paths.CoreRoot, "authoring", created.Operation.Id + ".json");
        await JsonStorage.WriteAsync(path, created.Operation with { Stage = "committed", Installation = null });
        var recovered = await f.Service.CreateLocalAppAsync(owner, input, null, default);
        Assert.Equal(created.Operation.Installation, recovered.Operation.Installation);
        Assert.Equal(created.Operation.Commit, recovered.Operation.Commit);
        Assert.Equal("installed", recovered.Operation.Stage);
    }

    [Fact]
    public async Task AppCreation_ReplaysWithPersistedAuthorAndSerializesRequestAcrossAppIds()
    {
        var f = await LifecycleFixture.CreateAsync();
        var owner = WorkspaceTestOwner(f);
        var input = NewApp() with { AuthorName = null, AuthorEmail = null };
        var created = await f.Service.CreateLocalAppAsync(owner, input, new("Original Author", "original@example.test"), default);
        var replay = await f.Service.CreateLocalAppAsync(owner, input, null, default);
        Assert.Equal(created.Operation, replay.Operation);
        Assert.Equal("Original Author", replay.Operation.Request.AuthorName);
        Assert.Equal("creation_request_conflict", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.CreateLocalAppAsync(owner, input with { AppId = "test.another" }, null, default))).Code);
        Assert.False(Directory.Exists(f.Paths.ResolveManagedCheckoutPath("test.another")));
    }

    [Theory]
    [InlineData("written")]
    [InlineData("committed")]
    public async Task AppCreation_PreservesEditedPartialBootstrap(string stage)
    {
        var f = await LifecycleFixture.CreateAsync();
        var owner = WorkspaceTestOwner(f);
        var input = NewApp();
        var created = await f.Service.CreateLocalAppAsync(owner, input, null, default);
        var path = Path.Combine(f.Paths.CoreRoot, "authoring", created.Operation.Id + ".json");
        await JsonStorage.WriteAsync(path, created.Operation with { Stage = stage });
        var sourceFile = Path.Combine(created.Operation.SourcePath, "server.ts");
        await File.WriteAllTextAsync(sourceFile, "operator changes");
        Assert.Equal("creation_source_changed", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.CreateLocalAppAsync(owner, input, null, default))).Code);
        Assert.Equal("operator changes", await File.ReadAllTextAsync(sourceFile));
    }

    [Fact]
    public async Task AppCreation_PreservesPendingSourceWhenThePackagedBootstrapChanges()
    {
        var f = await LifecycleFixture.CreateAsync();
        var owner = WorkspaceTestOwner(f);
        var input = NewApp();
        var created = await f.Service.CreateLocalAppAsync(owner, input, null, default);
        var journal = Path.Combine(f.Paths.CoreRoot, "authoring", created.Operation.Id + ".json");
        await JsonStorage.WriteAsync(journal, created.Operation with { Stage = "written", BootstrapFingerprint = "older-package" });
        var file = Path.Combine(created.Operation.SourcePath, "server.ts");
        var original = await File.ReadAllTextAsync(file);
        Assert.Equal("creation_bootstrap_changed", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.CreateLocalAppAsync(owner, input, null, default))).Code);
        Assert.Equal(original, await File.ReadAllTextAsync(file));
    }

    [Fact]
    public async Task AppCreation_DoesNotWriteThroughSourceSymlink()
    {
        if (OperatingSystem.IsWindows()) return;
        var f = await LifecycleFixture.CreateAsync();
        var input = NewApp();
        var outside = Path.Combine(f.Root, "operator-source");
        Directory.CreateDirectory(outside);
        var source = f.Paths.ResolveManagedCheckoutPath(input.AppId);
        Directory.CreateDirectory(Path.GetDirectoryName(source)!);
        Directory.CreateSymbolicLink(source, outside);
        Assert.Equal("creation_source_changed", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.CreateLocalAppAsync(WorkspaceTestOwner(f), input, null, default))).Code);
        Assert.Empty(Directory.EnumerateFileSystemEntries(outside));
    }
    [Fact]
    public async Task AppCreation_LocalSourceCannotBeReplacedByManagedCloneAndSurvivesDataRemoval()
    {
        var f = await LifecycleFixture.CreateAsync();
        var owner = WorkspaceTestOwner(f);
        var input = NewApp();
        var created = await f.Service.CreateLocalAppAsync(owner, input, null, default);
        Assert.Equal("creation_app_invalid", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.CreateLocalAppAsync(owner, input with { AppId = "../outside" }, null, default))).Code);
        Assert.Equal("source_locally_owned", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Sources.ResolveManagedAsync(input.AppId, new(Fetch: true)))).Code);
        Assert.Equal("source_locally_owned", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Sources.EnsurePinnedCommitAsync(input.AppId))).Code);
        await f.Service.RemoveAsync(input.AppId, new(DeleteData: true));
        Assert.True(Directory.Exists(created.Operation.SourcePath));
        Assert.Equal(created.Operation.Commit, (await DevelopmentWorkspaceService.Git(created.Operation.SourcePath,
            ["rev-parse", "HEAD"], default)).StandardOutput.Trim());
        Assert.Equal("creation_app_changed", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.CreateLocalAppAsync(owner, input, null, default))).Code);
    }

    [Fact]
    public async Task AppCreation_ReservedReplayRefusesDanglingBootstrapLink()
    {
        if (OperatingSystem.IsWindows()) return;
        var f = await LifecycleFixture.CreateAsync();
        var owner = WorkspaceTestOwner(f);
        var input = NewApp();
        var created = await f.Service.CreateLocalAppAsync(owner, input, null, default);
        await f.Service.RemoveAsync(input.AppId, new(DeleteData: true));
        Directory.Delete(Path.Combine(created.Operation.SourcePath, ".git"), true);
        var file = Path.Combine(created.Operation.SourcePath, "server.ts");
        File.Delete(file);
        var outside = Path.Combine(f.Root, "must-not-be-created.ts");
        File.CreateSymbolicLink(file, outside);
        await JsonStorage.WriteAsync(Path.Combine(f.Paths.CoreRoot, "authoring", created.Operation.Id + ".json"),
            created.Operation with { Stage = "reserved", Commit = null, Installation = null });

        Assert.Equal("creation_source_changed", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.CreateLocalAppAsync(owner, input, null, default))).Code);
        Assert.False(File.Exists(outside));
        Assert.NotNull(new FileInfo(file).LinkTarget);
        Assert.Null(await f.Apps.GetAppAsync(input.AppId));
    }

    [Theory]
    [InlineData("reserved")]
    [InlineData("written")]
    [InlineData("git-initialized")]
    [InlineData("committed")]
    [InlineData("ref-updated")]
    public async Task AppCreation_RestartRecoversEachBootstrapBoundaryWithoutDuplicates(string boundary)
    {
        var f = await LifecycleFixture.CreateAsync();
        var owner = WorkspaceTestOwner(f);
        var input = NewApp();
        var created = await f.Service.CreateLocalAppAsync(owner, input, null, default);
        await f.Service.RemoveAsync(input.AppId, new(DeleteData: true));
        var root = created.Operation.SourcePath;
        var files = AppCreationBootstrap.Files(input.AppId, input.Name, input.Description);
        var stage = boundary is "git-initialized" ? "written" : boundary is "ref-updated" ? "committed" : boundary;
        if (stage is "reserved" or "written") Directory.Delete(Path.Combine(root, ".git"), true);
        if (boundary == "reserved") File.Delete(Path.Combine(root, "index.html"));
        if (boundary == "git-initialized") await DevelopmentWorkspaceService.Git(root, ["init", "--initial-branch=main"], default);
        if (boundary == "committed") await DevelopmentWorkspaceService.Git(root, ["update-ref", "-d", "refs/heads/main"], default);
        await JsonStorage.WriteAsync(Path.Combine(f.Paths.CoreRoot, "authoring", created.Operation.Id + ".json"),
            created.Operation with { Stage = stage, Installation = null, Commit = stage == "committed" ? created.Operation.Commit : null });

        var restarted = f.RecreateService();
        var recovered = await restarted.CreateLocalAppAsync(owner, input, null, default);
        Assert.Equal("installed", recovered.Operation.Stage);
        Assert.Equal(root, recovered.Operation.SourcePath);
        foreach (var (name, contents) in files) Assert.Equal(contents, await File.ReadAllTextAsync(Path.Combine(root, name)));
        Assert.Equal("1", (await DevelopmentWorkspaceService.Git(root, ["rev-list", "--count", "HEAD"], default)).StandardOutput.Trim());
        Assert.Equal("", (await DevelopmentWorkspaceService.Git(root, ["remote"], default)).StandardOutput);
        Assert.Equal(recovered.Operation, (await f.RecreateService().CreateLocalAppAsync(owner, input, null, default)).Operation);
        Assert.Equal(0, f.Adapter.StartCount);
    }

    [Fact]
    public async Task AppCreation_ConcurrentConflictingRequestAllocatesOnlyOneApp()
    {
        var f = await LifecycleFixture.CreateAsync();
        var owner = WorkspaceTestOwner(f);
        var input = NewApp();
        async Task<bool> Create(AppCreationRequest request)
        {
            try { await f.Service.CreateLocalAppAsync(owner, request, null, default); return true; }
            catch (AppLifecycleException ex) { Assert.Equal("creation_request_conflict", ex.Code); return false; }
        }
        var results = await Task.WhenAll(Create(input), Create(input with { AppId = "test.competing" }));
        Assert.Single(results, v => v);
        Assert.Single(await f.Apps.ListAppRecordsAsync(), a => a.Id is "test.created" or "test.competing");
        Assert.Single(new[] { "test.created", "test.competing" }, id => Directory.Exists(f.Paths.ResolveManagedCheckoutPath(id)));
    }

}
