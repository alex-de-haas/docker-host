using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class AppManifestServiceTests
{
    [Theory]
    [InlineData("..")]
    [InlineData(".")]
    [InlineData("../escape")]
    [InlineData("nested/segment")]
    [InlineData("Upper.Case")]
    public async Task LoadAsync_RejectsUnsafeAppIds(string appId)
    {
        var manifestPath = await WriteManifestAsync(appId);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == "app_manifest_id_invalid");
    }

    [Fact]
    public async Task LoadAsync_AcceptsReverseDnsAppIds()
    {
        var manifestPath = await WriteManifestAsync("com.example.notes");

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        Assert.Equal("com.example.notes", selection.Manifest.Id);
    }

    [Fact]
    public async Task LoadAsync_AcceptsExternalMountsAndDefaultsKindAndMode()
    {
        var manifestPath = await WriteManifestAsync(
            "com.example.notes",
            externalMounts: """, "externalMounts": { "catalogRoots": { "multiple": true, "required": true, "service": "app" } }""");

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        var slot = selection.Manifest.ExternalMounts["catalogRoots"];
        Assert.Equal("host-path", slot.Kind);
        Assert.Equal("rw", slot.Mode);
        Assert.True(slot.Multiple);
        Assert.True(slot.Required);
        Assert.Equal("app", slot.Service);
    }

    [Theory]
    [InlineData(""", "externalMounts": { "catalogRoots": { "mode": "rx" } }""", "app_manifest_external_mount_mode_invalid")]
    [InlineData(""", "externalMounts": { "catalogRoots": { "kind": "named-volume" } }""", "app_manifest_external_mount_kind_unsupported")]
    [InlineData(""", "externalMounts": { "catalogRoots": { "service": "nope" } }""", "app_manifest_external_mount_service_unknown")]
    [InlineData(""", "externalMounts": { "bad.key": {} }""", "app_manifest_external_mount_key_invalid")]
    [InlineData(""", "externalMounts": { "catalog-roots": {}, "catalog_roots": {} }""", "app_manifest_external_mount_key_collision")]
    public async Task LoadAsync_RejectsInvalidExternalMounts(string externalMounts, string expectedCode)
    {
        var manifestPath = await WriteManifestAsync("com.example.notes", externalMounts);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == expectedCode);
    }

    private static async Task<string> WriteManifestAsync(string appId, string? externalMounts = null)
    {
        var root = Path.Combine(Path.GetTempPath(), $"hosty-core-manifest-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, "manifest.json");
        await File.WriteAllTextAsync(path, $$"""
            {
              "schemaVersion": "app.0.1",
              "id": "{{appId}}",
              "name": "Notes",
              "version": "1.0.0",
              "runtimeProfiles": [{ "key": "docker", "type": "docker", "default": true }],
              "services": [{
                "key": "app",
                "runtimes": {
                  "docker": {
                    "type": "docker",
                    "image": "ghcr.io/example/notes:1.0.0"
                  }
                }
              }]{{externalMounts ?? ""}}
            }
            """);
        return path;
    }
}
