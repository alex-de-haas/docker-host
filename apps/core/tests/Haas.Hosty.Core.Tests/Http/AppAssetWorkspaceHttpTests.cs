using System.Net;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class AppAssetWorkspaceHttpTests
{
    [Fact]
    public async Task ActiveWorkspaceIcon_UsesManifestFolderAndContentValidationWithoutChangingPackage()
    {
        await using var fixture = await Fixture.CreateAsync();
        using var client = fixture.Harness.CreateClient();
        using var first = await fixture.GetAsync(client, "assets/icon.svg?v=1.0.0");
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Equal("<svg>new</svg>", await first.Content.ReadAsStringAsync());
        AssertPrivateNoCache(first);
        Assert.False(first.Headers.ETag!.IsWeak);
        Assert.Null(first.Content.Headers.LastModified);
        Assert.Equal("nosniff", first.Headers.GetValues("X-Content-Type-Options").Single());
        Assert.Equal("default-src 'none'; sandbox", first.Headers.GetValues("Content-Security-Policy").Single());

        using var unchanged = await fixture.GetAsync(client, "assets/icon.svg?v=1.0.0", first.Headers.ETag.ToString());
        Assert.Equal(HttpStatusCode.NotModified, unchanged.StatusCode);
        var stamp = File.GetLastWriteTimeUtc(fixture.SourceIcon);
        await File.WriteAllTextAsync(fixture.SourceIcon, "<svg>two</svg>");
        File.SetLastWriteTimeUtc(fixture.SourceIcon, stamp);
        using var edited = await fixture.GetAsync(client, "assets/icon.svg?v=1.0.0", first.Headers.ETag.ToString(), DateTimeOffset.UtcNow.AddDays(1));
        Assert.Equal(HttpStatusCode.OK, edited.StatusCode);
        Assert.Equal("<svg>two</svg>", await edited.Content.ReadAsStringAsync());
        Assert.NotEqual(first.Headers.ETag, edited.Headers.ETag);
        Assert.Equal("<svg>old</svg>", await File.ReadAllTextAsync(fixture.PackagedIcon));

        // Neither another file in this app nor a sibling app becomes public through its worktree.
        await File.WriteAllTextAsync(Path.Combine(fixture.AppRoot, "private.svg"), "private");
        await File.WriteAllTextAsync(Path.Combine(fixture.Tree.Path, "private.svg"), "repository private");
        Assert.Equal(HttpStatusCode.NotFound, (await fixture.GetAsync(client, "private.svg")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await fixture.GetAsync(client, "apps/notes/private.svg")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await fixture.GetAsync(client, "assets/icon.svg", session: "unassigned")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(fixture.Url("assets/icon.svg"))).StatusCode);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("oversized")]
    [InlineData("linked-file")]
    [InlineData("linked-directory")]
    [InlineData("linked-app-folder")]
    [InlineData("fifo")]
    public async Task UnavailableWorkspaceIcon_FallsBackToInstalledPackage(string kind)
    {
        if (OperatingSystem.IsWindows() && kind is "linked-file" or "linked-directory" or "linked-app-folder" or "fifo") return;
        await using var fixture = await Fixture.CreateAsync();
        var privateDirectory = Path.Combine(fixture.Paths.DataRoot, "private-assets");
        Directory.CreateDirectory(privateDirectory);
        var privateIcon = Path.Combine(privateDirectory, "icon.svg");
        await File.WriteAllTextAsync(privateIcon, "<svg>secret</svg>");
        switch (kind)
        {
            case "missing": File.Delete(fixture.SourceIcon); break;
            case "oversized": await File.WriteAllBytesAsync(fixture.SourceIcon, new byte[512 * 1024 + 1]); break;
            case "linked-file":
                File.Delete(fixture.SourceIcon);
                File.CreateSymbolicLink(fixture.SourceIcon, privateIcon);
                break;
            case "linked-directory":
                Directory.Delete(Path.GetDirectoryName(fixture.SourceIcon)!, true);
                Directory.CreateSymbolicLink(Path.GetDirectoryName(fixture.SourceIcon)!, privateDirectory);
                break;
            case "linked-app-folder":
                Directory.Move(fixture.AppRoot, fixture.AppRoot + "-moved");
                Directory.CreateSymbolicLink(fixture.AppRoot, fixture.AppRoot + "-moved");
                break;
            case "fifo":
                File.Delete(fixture.SourceIcon);
                var start = new System.Diagnostics.ProcessStartInfo("mkfifo");
                start.ArgumentList.Add(fixture.SourceIcon);
                Assert.Equal(0, (await ProcessRunner.RunAsync(start, TimeSpan.FromSeconds(5), default)).ExitCode);
                break;
        }
        using var client = fixture.Harness.CreateClient();
        using var result = await fixture.GetAsync(client, "assets/icon.svg?v=1.0.0");
        Assert.Equal(HttpStatusCode.OK, result.StatusCode);
        Assert.Equal("<svg>old</svg>", await result.Content.ReadAsStringAsync());
        AssertPrivateNoCache(result);
        Assert.Equal("<svg>old</svg>", await File.ReadAllTextAsync(fixture.PackagedIcon));
        if (kind == "missing")
        {
            await File.WriteAllTextAsync(fixture.SourceIcon, "<svg>back</svg>");
            using var restored = await fixture.GetAsync(client, "assets/icon.svg?v=1.0.0", result.Headers.ETag!.ToString());
            Assert.Equal(HttpStatusCode.OK, restored.StatusCode);
            Assert.Equal("<svg>back</svg>", await restored.Content.ReadAsStringAsync());
        }
    }

    [Theory]
    [InlineData("returned")]
    [InlineData("starting")]
    [InlineData("wrong-installation")]
    [InlineData("wrong-source")]
    [InlineData("wrong-runtime")]
    [InlineData("missing-tree")]
    [InlineData("wrong-app-binding")]
    [InlineData("wrong-subpath")]
    [InlineData("invalid-subpath")]
    [InlineData("duplicate-binding")]
    [InlineData("wrong-branch")]
    public async Task InactiveOrMismatchedWorkspace_NeverSuppliesSourceBytes(string kind)
    {
        await using var fixture = await Fixture.CreateAsync();
        var app = fixture.App;
        var operation = fixture.Operation;
        var tree = fixture.Tree;
        switch (kind)
        {
            case "returned": operation = operation with { Phase = "returned" }; break;
            case "starting": operation = operation with { Phase = "starting" }; break;
            case "wrong-installation": operation = operation with { Installation = app.InstalledAt.AddSeconds(1) }; break;
            case "wrong-source": operation = operation with { SourcePath = Path.GetDirectoryName(tree.Path)! }; break;
            case "wrong-runtime": app = app with { SelectedRuntime = "docker" }; break;
            case "missing-tree": operation = operation with { WorktreeId = new string('a', 64) }; break;
            case "wrong-app-binding": tree = tree with { Apps = [] }; break;
            case "wrong-subpath": tree = tree with { Apps = [new(app.Id, app.InstalledAt, "apps/other")] }; break;
            case "invalid-subpath":
                app = app with { SourceState = app.SourceState! with { ManifestSubpath = "../notes" } };
                tree = tree with { Apps = [new(app.Id, app.InstalledAt, "../notes")] };
                break;
            case "duplicate-binding": tree = tree with { Apps = [.. tree.Apps, tree.Apps[0]] }; break;
            case "wrong-branch": await Fixture.GitAsync(tree.Path, ["checkout", "-b", "unregistered"]); break;
        }
        await fixture.Apps.UpsertAppAsync(app);
        await AppDevStore.SaveAsync(fixture.Paths, operation, default);
        await JsonStorage.WriteAsync(Path.Combine(fixture.Paths.CoreRoot, "development", "workspaces", tree.Id + ".json"), tree);
        using var client = fixture.Harness.CreateClient();
        using var result = await fixture.GetAsync(client, "assets/icon.svg");
        Assert.Equal(HttpStatusCode.OK, result.StatusCode);
        Assert.Equal("<svg>old</svg>", await result.Content.ReadAsStringAsync());
    }

    private static void AssertPrivateNoCache(HttpResponseMessage response)
    {
        Assert.True(response.Headers.CacheControl!.Private);
        Assert.True(response.Headers.CacheControl.NoCache);
        Assert.Null(response.Headers.CacheControl.MaxAge);
    }

    private sealed record Fixture(CoreHttpHarness Harness, CoreDataPaths Paths, AppRegistryStore Apps,
        AppRecord App, DevelopmentWorkspace Tree, AppDevOperation Operation) : IAsyncDisposable
    {
        internal string AppRoot => Path.Combine(Tree.Path, "apps", "notes");
        internal string SourceIcon => Path.Combine(AppRoot, "assets", "icon.svg");
        internal string PackagedIcon => Path.Combine(Paths.AppsRoot, App.Id, "assets", "icon.svg");
        internal string Url(string path) => $"/api/apps/{App.Id}/assets/{path}";
        internal async Task<HttpResponseMessage> GetAsync(HttpClient client, string path, string? etag = null,
            DateTimeOffset? modifiedSince = null, string session = "assigned")
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, Url(path));
            request.Headers.Add("Cookie", $"{CoreSessionAuthorization.SessionCookieName}=sess_{session}");
            if (etag is not null) request.Headers.TryAddWithoutValidation("If-None-Match", etag);
            request.Headers.IfModifiedSince = modifiedSince;
            return await client.SendAsync(request);
        }

        internal static async Task<Fixture> CreateAsync()
        {
            var harness = await CoreHttpHarness.StartAsync();
            var paths = harness.Services.GetRequiredService<CoreDataPaths>();
            var apps = harness.Services.GetRequiredService<AppRegistryStore>();
            var now = harness.Services.GetRequiredService<IClock>().UtcNow;
            var repository = Path.Combine(paths.DataRoot, "origin");
            var appRoot = Path.Combine(repository, "apps", "notes");
            Directory.CreateDirectory(Path.Combine(appRoot, "assets"));
            await File.WriteAllTextAsync(Path.Combine(appRoot, "assets", "icon.svg"), "<svg>new</svg>");
            await GitAsync(repository, ["init", "-b", "main"]);
            await GitAsync(repository, ["add", "."]);
            await GitAsync(repository, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Icon fixture"]);
            var app = new AppRecord(
                Id: "com.example.notes", DisplayName: "Notes", Description: "Notes", Version: "1.0.0", Kind: "runtime", System: false,
                Source: "installed", ManifestPath: "manifest.json", ManifestUrl: null, SelectedRuntime: "dev",
                OperationStatus: "installed", RuntimeState: "running", LastOperation: null, LastError: null,
                Capabilities: ["open"], Settings: new Dictionary<string, AppSettingValue>(), StorageMappings: [], Dependencies: [], Endpoints: [],
                InstalledAt: now, UpdatedAt: now, RuntimeProfiles: [new("dev", "localCommand", false, true)],
                SourceState: new("git", repository, "main", null, null, repository, now, "apps/notes"),
                CatalogMetadata: new(null, null, [], "assets/icon.svg", [], null, null, null, null, null, null));
            await apps.UpsertAppAsync(app);
            var owner = new WorkspaceOwner("hosty.harness", now, "admin", "asset-preview");
            var tree = await harness.Services.GetRequiredService<DevelopmentWorkspaceService>().PrepareAsync(owner,
                new(Guid.NewGuid().ToString(), owner.SessionId, app.Id, "/assistant", "main", Guid.NewGuid().ToString()), default);
            var operation = new AppDevOperation(Guid.NewGuid().ToString(), app.Id, now, new("admin", "test", owner),
                "dev", tree.Path, tree.Id, "digest", "previous-manifest.json", "docker", app.SourceState, null, true, "configuration", "active");
            app = app with { DevModeId = operation.Id, SourceState = app.SourceState! with { LocalOverridePath = tree.Path } };
            await apps.UpsertAppAsync(app);
            await AppDevStore.SaveAsync(paths, operation, default);
            var fixture = new Fixture(harness, paths, apps, app, tree, operation);
            Directory.CreateDirectory(Path.GetDirectoryName(fixture.PackagedIcon)!);
            await File.WriteAllTextAsync(fixture.PackagedIcon, "<svg>old</svg>");
            var users = harness.Services.GetRequiredService<UserDirectoryStore>();
            var assigned = new HostUserRecord("assigned", "assigned@example.test", "Assigned", "host.user", false, now, now);
            var unassigned = assigned with { Id = "unassigned", Email = "unassigned@example.test" };
            await users.WriteAsync(new UserDirectoryState(1, [assigned, unassigned], [], [new(app.Id, assigned.Id, now)],
                [new("sess_assigned", assigned.Id, now, now.AddHours(1), null, now), new("sess_unassigned", unassigned.Id, now, now.AddHours(1), null, now)]));
            return fixture;
        }

        internal static async Task GitAsync(string path, string[] arguments)
            => await DevelopmentWorkspaceService.Git(path, arguments, default);
        public ValueTask DisposeAsync() => Harness.DisposeAsync();
    }
}
