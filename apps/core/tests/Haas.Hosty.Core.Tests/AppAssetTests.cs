using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class AppAssetTests
{
    // --- Vendoring (AppManifestService.VendorDisplayAssetsAsync) ---------------------------------

    [Fact]
    public async Task VendorDisplayAssets_CopiesLocalIconDescriptionAndReferencedImages()
    {
        var source = NewTempDir();
        Directory.CreateDirectory(Path.Combine(source, "assets"));
        Directory.CreateDirectory(Path.Combine(source, "docs"));
        await File.WriteAllTextAsync(Path.Combine(source, "assets", "icon.svg"), "<svg/>");
        await File.WriteAllBytesAsync(Path.Combine(source, "assets", "pic.png"), [1, 2, 3]);
        // A description in docs/ referencing a sibling image via ../assets — contained under the manifest folder.
        await File.WriteAllTextAsync(Path.Combine(source, "docs", "store.md"), "# Demo\n\n![pic](../assets/pic.png)\n");
        var manifestPath = await WriteManifestAsync(source, """
            "icon": "assets/icon.svg", "descriptionFile": "docs/store.md"
            """);

        var appRoot = NewTempDir();
        var selection = await new AppManifestService().LoadAsync(manifestPath);
        await new AppManifestService().VendorDisplayAssetsAsync(selection, appRoot);

        Assert.Equal("<svg/>", await File.ReadAllTextAsync(Path.Combine(appRoot, "assets", "icon.svg")));
        Assert.Equal("# Demo\n\n![pic](../assets/pic.png)\n", await File.ReadAllTextAsync(Path.Combine(appRoot, "docs", "store.md")));
        // The ../assets/pic.png reference resolved against docs/ and vendored at its manifest-folder path.
        Assert.Equal([1, 2, 3], await File.ReadAllBytesAsync(Path.Combine(appRoot, "assets", "pic.png")));
    }

    [Fact]
    public async Task VendorDisplayAssets_CopiesNavigationIconAssets()
    {
        var source = NewTempDir();
        Directory.CreateDirectory(Path.Combine(source, "assets", "nav"));
        await File.WriteAllTextAsync(Path.Combine(source, "assets", "nav", "people.svg"), "<svg id='people'/>");
        var path = Path.Combine(source, "manifest.json");
        await File.WriteAllTextAsync(path, """
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.notes",
              "name": "Notes",
              "version": "1.0.0",
              "runtimeProfiles": [{ "key": "docker", "type": "docker", "default": true }],
              "services": [{ "key": "app", "runtimes": { "docker": { "type": "docker", "image": "ghcr.io/example/notes:1.0.0" } } }],
              "ui": { "entrypoint": { "path": "/" }, "navigation": [{ "label": "People", "path": "/people", "iconAsset": "assets/nav/people.svg" }] }
            }
            """);

        var appRoot = NewTempDir();
        var selection = await new AppManifestService().LoadAsync(path);
        await new AppManifestService().VendorDisplayAssetsAsync(selection, appRoot);

        // A nav icon is vendored even when the app declares no catalogMetadata.
        Assert.Equal("<svg id='people'/>", await File.ReadAllTextAsync(Path.Combine(appRoot, "assets", "nav", "people.svg")));
    }

    [Fact]
    public async Task VendorDisplayAssets_SkipsMissingDeclaredAssetsWithoutThrowing()
    {
        var source = NewTempDir();
        // Declares an icon and description that do not exist on disk.
        var manifestPath = await WriteManifestAsync(source, """
            "icon": "assets/icon.svg", "descriptionFile": "docs/store.md"
            """);

        var appRoot = NewTempDir();
        var selection = await new AppManifestService().LoadAsync(manifestPath);

        // Display-only: a missing asset never blocks an install.
        await new AppManifestService().VendorDisplayAssetsAsync(selection, appRoot);

        Assert.False(File.Exists(Path.Combine(appRoot, "assets", "icon.svg")));
        Assert.False(File.Exists(Path.Combine(appRoot, "docs", "store.md")));
    }

    [Fact]
    public async Task VendorDisplayAssets_DoesNothingWhenNoCatalogMetadata()
    {
        var source = NewTempDir();
        var manifestPath = await WriteManifestAsync(source, catalogMetadataFields: null);

        var appRoot = NewTempDir();
        var selection = await new AppManifestService().LoadAsync(manifestPath);
        await new AppManifestService().VendorDisplayAssetsAsync(selection, appRoot);

        Assert.Empty(Directory.EnumerateFileSystemEntries(appRoot));
    }

    // --- Endpoint asset resolution (AppAssetEndpoints.TryResolveAsset) ---------------------------

    [Fact]
    public void TryResolveAsset_ServesAllowlistedContainedFile()
    {
        var appsRoot = NewTempDir();
        var appDir = Path.Combine(appsRoot, "com.example.notes", "assets");
        Directory.CreateDirectory(appDir);
        File.WriteAllText(Path.Combine(appDir, "icon.svg"), "<svg/>");

        var ok = AppAssetEndpoints.TryResolveAsset(appsRoot, "com.example.notes", "assets/icon.svg", out var fullPath, out var contentType);

        Assert.True(ok);
        Assert.Equal("image/svg+xml", contentType);
        Assert.EndsWith(Path.Combine("com.example.notes", "assets", "icon.svg"), fullPath);
    }

    [Theory]
    [InlineData("assets/icon.exe")] // disallowed extension
    [InlineData("assets/secret")] // no extension
    [InlineData("../../secret.png")] // traversal
    [InlineData("assets/missing.png")] // not present
    public void TryResolveAsset_RejectsDisallowedTraversalOrMissing(string assetPath)
    {
        var appsRoot = NewTempDir();
        var appDir = Path.Combine(appsRoot, "com.example.notes", "assets");
        Directory.CreateDirectory(appDir);
        File.WriteAllText(Path.Combine(appDir, "icon.svg"), "<svg/>");
        // A real file the traversal case would try to escape to.
        File.WriteAllText(Path.Combine(appsRoot, "secret.png"), "x");

        Assert.False(AppAssetEndpoints.TryResolveAsset(appsRoot, "com.example.notes", assetPath, out _, out _));
    }

    // --- Endpoint asset resolution boundaries (C-H4) ---------------------------------------------

    [Theory]
    [InlineData("data/uploads/private.png")]
    [InlineData("logs/web.png")]
    [InlineData("run/state.png")]
    [InlineData("runtimes/docker/img.png")]
    [InlineData("Data/uploads/private.png")]
    [InlineData("manifest.json")]
    [InlineData("state.json")]
    public void TryResolveAsset_RefusesReservedNamespacesEvenWhenTheFileExists(string assetPath)
    {
        // App runtime data lives under data/ — the path the IDOR was read through. Extension and
        // containment alone would happily serve it.
        var appsRoot = NewTempDir();
        var appRoot = Path.Combine(appsRoot, "com.example.notes");
        var relativeDirectory = Path.GetDirectoryName(assetPath);
        Directory.CreateDirectory(string.IsNullOrEmpty(relativeDirectory)
            ? appRoot
            : Path.Combine(appRoot, relativeDirectory));
        File.WriteAllText(Path.Combine(appRoot, assetPath), "private");

        Assert.False(AppAssetEndpoints.TryResolveAsset(appsRoot, "com.example.notes", assetPath, out _, out _));
    }

    [Fact]
    public void TryResolveAsset_FailsClosedWhenTheAppRootItselfIsASymlink()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        // Every path below a linked app root resolves outside the apps tree while still looking
        // contained, so the root has to be checked too, not only what sits under it.
        var outside = NewTempDir();
        Directory.CreateDirectory(Path.Combine(outside, "assets"));
        File.WriteAllText(Path.Combine(outside, "assets", "icon.svg"), "<svg id='stolen'/>");

        var appsRoot = NewTempDir();
        Directory.CreateSymbolicLink(Path.Combine(appsRoot, "com.example.notes"), outside);

        Assert.False(AppAssetEndpoints.TryResolveAsset(appsRoot, "com.example.notes", "assets/icon.svg", out _, out _));
    }

    [Fact]
    public void TryResolveAsset_FailsClosedOnASymlinkedAncestorDirectory()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        // The leaf is a real file, so resolving only the final component would serve it.
        var outside = NewTempDir();
        File.WriteAllText(Path.Combine(outside, "icon.svg"), "<svg id='stolen'/>");

        var appsRoot = NewTempDir();
        var appRoot = Path.Combine(appsRoot, "com.example.notes");
        Directory.CreateDirectory(appRoot);
        Directory.CreateSymbolicLink(Path.Combine(appRoot, "assets"), outside);

        Assert.False(AppAssetEndpoints.TryResolveAsset(appsRoot, "com.example.notes", "assets/icon.svg", out _, out _));
    }

    // --- Vendoring boundaries (C-M1) ------------------------------------------------------------

    [Fact]
    public async Task VendorDisplayAssets_SkipsAnAssetThatIsItselfASymlink()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        // The manifest folder is operator-supplied but its contents are not: a source tree can ship
        // the icon as a link to something Core can read but must never republish.
        var outside = NewTempDir();
        var secretPath = Path.Combine(outside, "auth-state.json");
        await File.WriteAllTextAsync(secretPath, "password-hash");

        var source = NewTempDir();
        Directory.CreateDirectory(Path.Combine(source, "assets"));
        File.CreateSymbolicLink(Path.Combine(source, "assets", "icon.svg"), secretPath);
        var manifestPath = await WriteManifestAsync(source, """
            "icon": "assets/icon.svg"
            """);

        var appRoot = NewTempDir();
        var selection = await new AppManifestService().LoadAsync(manifestPath);
        await new AppManifestService().VendorDisplayAssetsAsync(selection, appRoot);

        Assert.False(File.Exists(Path.Combine(appRoot, "assets", "icon.svg")));
    }

    [Fact]
    public async Task VendorDisplayAssets_SkipsAnAssetBehindASymlinkedDirectory()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        // The final component is a real file, so a check that only resolves the leaf would pass it.
        var outside = NewTempDir();
        await File.WriteAllTextAsync(Path.Combine(outside, "icon.svg"), "<svg id='stolen'/>");

        var source = NewTempDir();
        Directory.CreateSymbolicLink(Path.Combine(source, "assets"), outside);
        var manifestPath = await WriteManifestAsync(source, """
            "icon": "assets/icon.svg"
            """);

        var appRoot = NewTempDir();
        var selection = await new AppManifestService().LoadAsync(manifestPath);
        await new AppManifestService().VendorDisplayAssetsAsync(selection, appRoot);

        Assert.False(File.Exists(Path.Combine(appRoot, "assets", "icon.svg")));
    }

    [Theory]
    [InlineData("data/icon.png", "data")]
    [InlineData("logs/icon.png", "logs")]
    [InlineData("run/icon.png", "run")]
    [InlineData("runtimes/icon.png", "runtimes")]
    // Case-insensitive: on a case-insensitive filesystem this reaches the same directory.
    [InlineData("Data/icon.png", "Data")]
    public async Task VendorDisplayAssets_RefusesToWriteIntoAReservedNamespace(string reference, string headDirectory)
    {
        var source = NewTempDir();
        Directory.CreateDirectory(Path.Combine(source, headDirectory));
        await File.WriteAllBytesAsync(Path.Combine(source, headDirectory, "icon.png"), [1, 2, 3]);
        var manifestPath = await WriteManifestAsync(source, $$"""
            "icon": "{{reference}}"
            """);

        var appRoot = NewTempDir();
        // A pre-existing runtime file in that namespace must survive untouched.
        Directory.CreateDirectory(Path.Combine(appRoot, headDirectory));
        var occupied = Path.Combine(appRoot, headDirectory, "icon.png");
        await File.WriteAllTextAsync(occupied, "runtime-owned");

        var selection = await new AppManifestService().LoadAsync(manifestPath);
        await new AppManifestService().VendorDisplayAssetsAsync(selection, appRoot);

        Assert.Equal("runtime-owned", await File.ReadAllTextAsync(occupied));
    }

    [Fact]
    public async Task VendorDisplayAssets_DoesNotFollowARedirectOffTheManifestHost()
    {
        // Exercises the real client the composition root uses, over a real socket: a custom
        // HttpMessageHandler never auto-redirects, so stubbing one would prove nothing.
        // The asset URI must sit under the manifest folder, but a 302 would carry the fetch
        // anywhere; with redirects refused it is just a non-success status and the asset is skipped.
        var followed = 0;
        await using var origin = LoopbackHttpServer.Start(async context =>
        {
            if (context.Request.Url!.AbsolutePath.EndsWith("/icon.svg", StringComparison.Ordinal))
            {
                // Same host, outside the manifest folder. Refusing the redirect is what stops the
                // fetch, so where it points does not matter — build it from the request itself.
                context.Response.StatusCode = 302;
                context.Response.RedirectLocation = new Uri(context.Request.Url, "/internal/secret.svg").ToString();
                return;
            }

            Interlocked.Increment(ref followed);
            var payload = "<svg id='internal'/>"u8.ToArray();
            await context.Response.OutputStream.WriteAsync(payload);
        });

        var source = NewTempDir();
        var manifestPath = await WriteManifestAsync(source, """
            "icon": "assets/icon.svg"
            """);
        var appRoot = NewTempDir();
        var service = new AppManifestService(AppManifestService.CreateDefaultHttpClient());
        var selection = await service.LoadAsync(manifestPath) with
        {
            ManifestUrl = $"http://127.0.0.1:{origin.Port}/notes/manifest.json",
        };

        await service.VendorDisplayAssetsAsync(selection, appRoot);

        await origin.StopAsync();

        Assert.False(File.Exists(Path.Combine(appRoot, "assets", "icon.svg")));
        Assert.Equal(0, followed);
    }

    // --- The agent skill under the shared asset budget ------------------------------------------

    [Fact]
    public async Task VendorDisplayAssets_VendorsADeclaredSkillBesideTheDisplayAssets()
    {
        // The accepted half the refusals below are measured against: a path that vendored no skill at
        // all would satisfy every negative on its own while being completely broken.
        var source = NewTempDir();
        Directory.CreateDirectory(Path.Combine(source, "assets"));
        Directory.CreateDirectory(Path.Combine(source, "docs"));
        await File.WriteAllTextAsync(Path.Combine(source, "assets", "icon.svg"), "<svg/>");
        await File.WriteAllTextAsync(Path.Combine(source, "docs", "agent.md"), "# How this app is worked\n");
        var manifestPath = await WriteManifestAsync(
            source,
            """
            "icon": "assets/icon.svg"
            """,
            agentSkillFile: "docs/agent.md");

        var appRoot = NewTempDir();
        var selection = await new AppManifestService().LoadAsync(manifestPath);
        await new AppManifestService().VendorDisplayAssetsAsync(selection, appRoot);

        Assert.Equal("<svg/>", await File.ReadAllTextAsync(Path.Combine(appRoot, "assets", "icon.svg")));
        Assert.Equal("# How this app is worked\n", await File.ReadAllTextAsync(Path.Combine(appRoot, "docs", "agent.md")));
    }

    [Theory]
    // The skill reuses the markdown description's own 256 KiB per-file cap rather than carrying a
    // second one, so the boundary is where that cap sits: exactly at it the file is carried, one byte
    // past it the skill never reaches disk. Asserted as a pair because the size is the only thing that
    // differs — a vendoring path broken for skills entirely would pass the refusal alone.
    [InlineData(256 * 1024, true)]
    [InlineData((256 * 1024) + 1, false)]
    public async Task VendorDisplayAssets_RefusesASkillPastTheSharedPerFileByteCap(int size, bool vendored)
    {
        var source = NewTempDir();
        Directory.CreateDirectory(Path.Combine(source, "docs"));
        // One byte per character, so the file is exactly `size` bytes and the boundary is the one the
        // cap names rather than one an encoding chose.
        await File.WriteAllTextAsync(Path.Combine(source, "docs", "agent.md"), new string('a', size));
        var manifestPath = await WriteManifestAsync(source, catalogMetadataFields: null, agentSkillFile: "docs/agent.md");

        var appRoot = NewTempDir();
        var selection = await new AppManifestService().LoadAsync(manifestPath);
        await new AppManifestService().VendorDisplayAssetsAsync(selection, appRoot);

        Assert.Equal(vendored, File.Exists(Path.Combine(appRoot, "docs", "agent.md")));
    }

    [Theory]
    // The per-app budget is the display assets' budget, not a second one of the skill's own: the
    // screenshots spend it first and the skill gets what is left. 32 is the per-app file ceiling, so
    // one short of it the skill still fits, and at it the skill is the file that does not.
    [InlineData(31, true)]
    [InlineData(32, false)]
    public async Task VendorDisplayAssets_RefusesASkillTheDisplayAssetsLeftNoBudgetFor(int screenshots, bool vendored)
    {
        var source = NewTempDir();
        Directory.CreateDirectory(Path.Combine(source, "assets"));
        Directory.CreateDirectory(Path.Combine(source, "docs"));
        var references = new List<string>();
        for (var index = 0; index < screenshots; index++)
        {
            var name = $"shot-{index:00}.png";
            await File.WriteAllBytesAsync(Path.Combine(source, "assets", name), [1, 2, 3]);
            references.Add($"\"assets/{name}\"");
        }

        await File.WriteAllTextAsync(Path.Combine(source, "docs", "agent.md"), "# How this app is worked\n");
        var manifestPath = await WriteManifestAsync(
            source,
            $$"""
            "screenshots": [{{string.Join(", ", references)}}]
            """,
            agentSkillFile: "docs/agent.md");

        var appRoot = NewTempDir();
        var selection = await new AppManifestService().LoadAsync(manifestPath);
        await new AppManifestService().VendorDisplayAssetsAsync(selection, appRoot);

        // The screenshots must all have landed, or the skill's absence would be measuring a broken
        // fixture rather than the ceiling.
        Assert.Equal(screenshots, Directory.EnumerateFiles(Path.Combine(appRoot, "assets")).Count());
        Assert.Equal(vendored, File.Exists(Path.Combine(appRoot, "docs", "agent.md")));
    }

    [Fact]
    public async Task VendorDisplayAssets_RemovesAPreviouslyVendoredSkillTheBudgetNowRefuses()
    {
        // An update that keeps the declaration but oversizes the file must not leave the old copy in
        // place: both delivery routes read whatever is on disk, so a survivor is instructions the
        // installed app no longer contains — delivered under an approval given for different words.
        var source = NewTempDir();
        Directory.CreateDirectory(Path.Combine(source, "docs"));
        await File.WriteAllTextAsync(Path.Combine(source, "docs", "agent.md"), new string('a', (256 * 1024) + 1));
        var manifestPath = await WriteManifestAsync(source, catalogMetadataFields: null, agentSkillFile: "docs/agent.md");

        var appRoot = NewTempDir();
        Directory.CreateDirectory(Path.Combine(appRoot, "docs"));
        var previous = Path.Combine(appRoot, "docs", "agent.md");
        await File.WriteAllTextAsync(previous, "# The skill the previous version shipped\n");

        var selection = await new AppManifestService().LoadAsync(manifestPath);
        await new AppManifestService().VendorDisplayAssetsAsync(selection, appRoot);

        Assert.False(File.Exists(previous));
    }

    // --- helpers --------------------------------------------------------------------------------

    private static string NewTempDir()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"hosty-core-asset-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static async Task<string> WriteManifestAsync(string dir, string? catalogMetadataFields, string? agentSkillFile = null)
    {
        var catalogMetadata = catalogMetadataFields is null
            ? ""
            : $$""", "catalogMetadata": { {{catalogMetadataFields}} }""";
        var agent = agentSkillFile is null
            ? ""
            : $$""", "agent": { "skillFile": "{{agentSkillFile}}" }""";
        var path = Path.Combine(dir, "manifest.json");
        await File.WriteAllTextAsync(path, $$"""
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.notes",
              "name": "Notes",
              "version": "1.0.0",
              "runtimeProfiles": [{ "key": "docker", "type": "docker", "default": true }],
              "services": [{
                "key": "app",
                "runtimes": { "docker": { "type": "docker", "image": "ghcr.io/example/notes:1.0.0" } }
              }]{{catalogMetadata}}{{agent}}
            }
            """);
        return path;
    }
}
