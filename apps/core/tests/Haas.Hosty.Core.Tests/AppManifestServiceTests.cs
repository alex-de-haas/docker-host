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

    private static async Task<string> WriteManifestAsync(string appId)
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
              }]
            }
            """);
        return path;
    }
}
