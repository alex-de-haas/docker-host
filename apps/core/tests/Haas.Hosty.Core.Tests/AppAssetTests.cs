using System.Net;
using System.Net.Sockets;
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
        using var origin = new HttpListener();
        var port = GetFreePort();
        origin.Prefixes.Add($"http://127.0.0.1:{port}/");
        origin.Start();

        var followed = 0;
        var serving = Task.Run(async () =>
        {
            while (origin.IsListening)
            {
                HttpListenerContext context;
                try
                {
                    context = await origin.GetContextAsync();
                }
                catch (Exception ex) when (ex is HttpListenerException or ObjectDisposedException)
                {
                    return;
                }

                if (context.Request.Url!.AbsolutePath.EndsWith("/icon.svg", StringComparison.Ordinal))
                {
                    context.Response.StatusCode = 302;
                    context.Response.RedirectLocation = $"http://127.0.0.1:{port}/internal/secret.svg";
                }
                else
                {
                    Interlocked.Increment(ref followed);
                    var payload = "<svg id='internal'/>"u8.ToArray();
                    await context.Response.OutputStream.WriteAsync(payload);
                }

                context.Response.Close();
            }
        });

        var source = NewTempDir();
        var manifestPath = await WriteManifestAsync(source, """
            "icon": "assets/icon.svg"
            """);
        var appRoot = NewTempDir();
        var service = new AppManifestService(AppManifestService.CreateDefaultHttpClient());
        var selection = await service.LoadAsync(manifestPath) with
        {
            ManifestUrl = $"http://127.0.0.1:{port}/notes/manifest.json",
        };

        await service.VendorDisplayAssetsAsync(selection, appRoot);

        origin.Stop();
        await serving;

        Assert.False(File.Exists(Path.Combine(appRoot, "assets", "icon.svg")));
        Assert.Equal(0, followed);
    }

    private static int GetFreePort()
    {
        using var probe = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
        probe.Bind(new IPEndPoint(IPAddress.Loopback, 0));
        return ((IPEndPoint)probe.LocalEndPoint!).Port;
    }

    // --- helpers --------------------------------------------------------------------------------

    private static string NewTempDir()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"hosty-core-asset-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static async Task<string> WriteManifestAsync(string dir, string? catalogMetadataFields)
    {
        var catalogMetadata = catalogMetadataFields is null
            ? ""
            : $$""", "catalogMetadata": { {{catalogMetadataFields}} }""";
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
              }]{{catalogMetadata}}
            }
            """);
        return path;
    }
}
