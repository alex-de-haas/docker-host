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
