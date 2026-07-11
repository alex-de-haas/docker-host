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
        var dockerService = Assert.Single(docker.Services);
        Assert.Equal("ghcr.io/alex-de-haas/hosty-shell", dockerService.Image?.Repository);
        Assert.Equal("latest", dockerService.Image?.Tag);
        // The manifest carries intent only (no digest), so the reference is the mutable tag.
        Assert.Equal("ghcr.io/alex-de-haas/hosty-shell:latest", dockerService.Image?.Reference);
        Assert.Equal("dev", dev.RuntimeProfile.Key);
        Assert.Equal("localCommand", dev.RuntimeProfile.Type);
        Assert.True(dev.RuntimeProfile.Development);
        Assert.Equal("apps/shell", Assert.Single(dev.Services).Runtime.WorkingDirectory);
    }

    [Theory]
    [InlineData("docker", "docker", "exec")]
    [InlineData("dev", "localCommand", "http")]
    public async Task MarketplaceManifest_RuntimeProfile_ValidatesRepositoryContract(
        string runtime,
        string expectedRuntimeType,
        string expectedHealthcheckType)
    {
        var manifestPath = Path.Combine(FindRepositoryRoot(), "apps", "marketplace", "manifest.json");
        var service = new AppManifestService();

        var selection = await service.LoadAsync(manifestPath, runtime);

        var manifest = selection.Manifest;
        Assert.Equal("hosty.marketplace", manifest.Id);
        Assert.Equal("system", manifest.Role);
        Assert.Equal("docker", manifest.DefaultRuntime);
        Assert.Equal(runtime, selection.RuntimeProfile.Key);
        Assert.Equal(expectedRuntimeType, selection.RuntimeProfile.Type);
        Assert.Equal(runtime == "docker", selection.RuntimeProfile.Default);
        Assert.Equal(runtime == "dev", selection.RuntimeProfile.Development);

        Assert.NotNull(manifest.Source);
        Assert.Equal("git", manifest.Source.Type);
        Assert.Equal("https://github.com/alex-de-haas/docker-host.git", manifest.Source.Repository);
        Assert.Equal("main", manifest.Source.Branch);

        var endpoint = Assert.Single(manifest.Endpoints);
        Assert.Equal("http", endpoint.Key);
        Assert.Equal("api", endpoint.Service);
        Assert.Equal("http", endpoint.Port);
        Assert.Equal("http", endpoint.Protocol);
        Assert.True(endpoint.Public);

        Assert.NotNull(manifest.Ui);
        var (entryEndpoint, entryPath) = AppUiContract.ReadDeclaredEntrypoint(manifest.Ui);
        Assert.Equal("http", entryEndpoint);
        Assert.Equal("/", entryPath);
        var navigation = Assert.Single(manifest.Ui.Navigation);
        Assert.Equal("Marketplace", navigation.Label);
        Assert.Equal("http", navigation.Endpoint);
        Assert.Equal("/", navigation.Path);

        var sourceSetting = Assert.Single(manifest.Settings);
        Assert.Equal("HOSTY_MARKETPLACE_SOURCE_URL", sourceSetting.Key);
        Assert.Equal("url", sourceSetting.Type);
        Assert.True(sourceSetting.Required);
        Assert.Equal("https://alex-de-haas.github.io/hosty-catalog/catalog.json", sourceSetting.Default);

        var selectedService = Assert.Single(selection.Services);
        Assert.Equal("api", selectedService.Key);
        Assert.Equal(expectedRuntimeType, selectedService.Runtime.Type);
        var port = Assert.Single(selectedService.Runtime.Ports);
        Assert.Equal("http", port.Key);
        Assert.Equal("http", port.Protocol);
        Assert.True(port.Public);
        Assert.Equal(expectedHealthcheckType, selectedService.Runtime.Healthcheck?.Type);

        Assert.NotNull(selection.DataTarget);
        if (runtime == "docker")
        {
            Assert.Equal("ghcr.io/alex-de-haas/hosty-marketplace", selectedService.Image?.Repository);
            Assert.Equal(manifest.Version, selectedService.Image?.Tag);
            Assert.False(string.IsNullOrWhiteSpace(selectedService.Runtime.Healthcheck?.Command));
            Assert.Equal("/var/lib/hosty-marketplace", selection.DataTarget.ContainerPath);
        }
        else
        {
            Assert.Null(selectedService.Image);
            Assert.Equal("apps/marketplace", selectedService.Runtime.WorkingDirectory);
            Assert.Equal("npm install", selectedService.Runtime.Setup);
            Assert.Equal("npm run dev", selectedService.Runtime.Command);
            Assert.Equal(3200, selectedService.Runtime.Healthcheck?.Port);
            Assert.Equal("/healthz", selectedService.Runtime.Healthcheck?.Path);
            Assert.Equal("HOSTY_APP_DATA_DIR", selection.DataTarget.Environment);
        }
    }

    [Fact]
    public async Task LoadAsync_UsesManifestJsonFromLocalDirectory()
    {
        var appDirectory = Path.Combine(Path.GetTempPath(), $"hosty-manifest-directory-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(appDirectory);
        var manifestPath = Path.Combine(appDirectory, "manifest.json");
        var manifestJson = CreateManifestJson("1.0.0");
        await File.WriteAllTextAsync(manifestPath, manifestJson);
        var service = new AppManifestService();

        try
        {
            var selection = await service.LoadAsync(appDirectory);

            Assert.Equal("com.example.notes", selection.Manifest.Id);
            Assert.Equal(manifestPath, selection.ManifestPath);
            Assert.Null(selection.ManifestUrl);
            Assert.Equal(manifestJson, selection.ManifestJson);
        }
        finally
        {
            if (Directory.Exists(appDirectory))
            {
                Directory.Delete(appDirectory, recursive: true);
            }
        }
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
