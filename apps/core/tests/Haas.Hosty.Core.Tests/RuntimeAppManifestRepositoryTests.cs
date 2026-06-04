using System.Net;
using System.Text;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class RuntimeAppManifestRepositoryTests
{
    [Fact]
    public async Task ShellManifest_DeclaresDockerAndLocalCommandRuntimeProfiles()
    {
        var manifestPath = Path.Combine(FindRepositoryRoot(), "apps", "shell", "manifest.json");
        var service = new AppManifestService();

        var docker = await service.LoadAsync(manifestPath, "docker");
        var dev = await service.LoadAsync(manifestPath, "dev");

        Assert.Equal("hosty.shell", docker.Manifest.Id);
        Assert.Equal("docker", docker.RuntimeProfile.Type);
        Assert.Equal("dev", dev.RuntimeProfile.Key);
        Assert.Equal("localCommand", dev.RuntimeProfile.Type);
        Assert.Equal("apps/shell", Assert.Single(dev.Services).Runtime.WorkingDirectory);
    }

    [Fact]
    public async Task LoadAsync_DownloadsHttpManifestAndSavesLocalCopy()
    {
        const string manifestUrl = "https://apps.example.test/notes/manifest.json";
        var manifestJson = CreateManifestJson("1.0.0");
        using var httpClient = new HttpClient(new StubHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(manifestJson, Encoding.UTF8, "application/json"),
        }));
        var service = new AppManifestService(httpClient);
        var appRoot = Path.Combine(Path.GetTempPath(), $"hosty-manifest-url-test-{Guid.NewGuid():N}");

        try
        {
            var selection = await service.LoadAsync(manifestUrl);
            await service.SaveManifestCopyAsync(selection, appRoot);

            Assert.Equal("com.example.notes", selection.Manifest.Id);
            Assert.Equal(manifestUrl, selection.ManifestPath);
            Assert.Equal(manifestUrl, selection.ManifestUrl);
            Assert.Equal(manifestJson, selection.ManifestJson);
            Assert.Equal(manifestJson, await File.ReadAllTextAsync(Path.Combine(appRoot, "manifest.json")));
        }
        finally
        {
            if (Directory.Exists(appRoot))
            {
                Directory.Delete(appRoot, recursive: true);
            }
        }
    }

    private static string FindRepositoryRoot()
    {
        var directory = new DirectoryInfo(Directory.GetCurrentDirectory());
        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "apps", "shell", "manifest.json")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        throw new InvalidOperationException("Unable to locate repository root.");
    }

    private static string CreateManifestJson(string version)
        => $$"""
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.notes",
              "name": "Notes",
              "version": "{{version}}",
              "runtimeProfiles": [{ "key": "docker", "type": "docker", "default": true }],
              "defaultRuntime": "docker",
              "services": [{
                "key": "app",
                "runtimes": {
                  "docker": {
                    "type": "docker",
                    "image": "ghcr.io/example/notes:{{version}}"
                  }
                }
              }]
            }
            """;

    private sealed class StubHttpMessageHandler(Func<HttpRequestMessage, HttpResponseMessage> handler) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(handler(request));
    }
}
