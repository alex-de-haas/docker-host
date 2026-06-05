using System.Net;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed class RuntimeAppSupervisorServiceTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"hosty-supervisor-tests-{Guid.NewGuid():N}");

    [Fact]
    public async Task StartAsync_ReconcilesInstalledShellFromConfiguredManifestUrl()
    {
        const string manifestUrl = "https://raw.githubusercontent.com/alex-de-haas/docker-host/main/apps/shell/manifest.json";
        var remoteManifest = CreateShellManifest("0.2.0", "ghcr.io/alex-de-haas/hosty-shell", "latest", "always");
        var fixture = CreateFixture(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(remoteManifest, Encoding.UTF8, "application/json"),
        });
        var oldManifest = Path.Combine(root, "old-shell-manifest.json");
        await File.WriteAllTextAsync(oldManifest, CreateShellManifest("0.1.0", "hosty-shell", "local", "never"));
        await fixture.Lifecycle.InstallAsync(new AppInstallRequest(
            ManifestPath: oldManifest,
            SelectedRuntime: "docker",
            SelectedChannel: "local",
            System: true,
            Autostart: false));
        var config = CreateConfig(fixture.Paths, manifestUrl, shellAutostart: false);
        var supervisor = new RuntimeAppSupervisorService(
            config,
            fixture.Apps,
            fixture.Lifecycle,
            fixture.Sources,
            NullLogger<RuntimeAppSupervisorService>.Instance);

        await supervisor.StartAsync(CancellationToken.None);
        try
        {
            var shell = await WaitForShellVersionAsync(fixture.Apps, "0.2.0");

            Assert.Equal(manifestUrl, shell.ManifestUrl);
            Assert.Equal("docker", shell.SelectedRuntime);
            Assert.False(shell.Autostart);
        }
        finally
        {
            await supervisor.StopAsync(CancellationToken.None);
        }
    }

    public void Dispose()
    {
        if (Directory.Exists(root))
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static async Task<AppRecord> WaitForShellVersionAsync(AppRegistryStore apps, string version)
    {
        var deadline = DateTimeOffset.UtcNow.AddSeconds(5);
        while (DateTimeOffset.UtcNow < deadline)
        {
            var shell = await apps.GetAppAsync("hosty.shell");
            if (shell?.Version == version)
            {
                return shell;
            }

            await Task.Delay(50);
        }

        throw new TimeoutException($"hosty.shell did not reach version {version}.");
    }

    private TestFixture CreateFixture(Func<HttpRequestMessage, HttpResponseMessage> manifestHandler)
    {
        Directory.CreateDirectory(root);
        var paths = new CoreDataPaths(
            DataRoot: root,
            CoreRoot: Path.Combine(root, "core"),
            AppsRoot: Path.Combine(root, "apps"),
            BackupsRoot: Path.Combine(root, "backups"),
            SourcesRoot: Path.Combine(root, "sources"),
            AuthRoot: Path.Combine(root, "core", "auth"),
            AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));
        var apps = new AppRegistryStore(paths);
        var clock = new TestClock();
        var manifests = new AppManifestService(new HttpClient(new StubHttpMessageHandler(manifestHandler)));
        var backups = new AppBackupService(paths, clock);
        var sources = new AppSourceService(paths, apps, clock);
        var lifecycle = new CoreLifecycleService(paths, apps, manifests, backups, [new NoopDockerRuntimeAdapter()]);
        return new TestFixture(paths, apps, sources, lifecycle);
    }

    private static HostyCoreRuntimeConfig CreateConfig(CoreDataPaths paths, string shellManifestPath, bool shellAutostart)
        => new(
            DataRoot: paths.DataRoot,
            RunDirectory: Path.Combine(paths.CoreRoot, "run"),
            ControlDiscoveryPath: Path.Combine(paths.CoreRoot, "run", "control.json"),
            ListenUrl: "http://127.0.0.1:3001",
            CorePublicOrigin: "http://127.0.0.1:3001",
            ShellPublicOrigin: "http://127.0.0.1:3000",
            RuntimePublicHost: "localhost",
            ShellManifestPath: shellManifestPath,
            ShellBootstrapRuntime: "docker",
            ShellSourceOverridePath: null,
            ShellBootstrapEnabled: true,
            ShellAutostart: shellAutostart);

    private static string CreateShellManifest(string version, string repository, string tag, string pullPolicy)
        => $$"""
            {
              "schemaVersion": "app.0.1",
              "id": "hosty.shell",
              "name": "Hosty Shell",
              "version": "{{version}}",
              "runtimeProfiles": [
                { "key": "docker", "type": "docker", "default": true },
                { "key": "dev", "type": "localCommand" }
              ],
              "defaultRuntime": "docker",
              "services": [
                {
                  "key": "web",
                  "runtimes": {
                    "docker": {
                      "type": "docker",
                      "image": {
                        "repository": "{{repository}}",
                        "tag": "{{tag}}",
                        "pullPolicy": "{{pullPolicy}}"
                      },
                      "ports": [
                        {
                          "key": "http",
                          "containerPort": 3000,
                          "localPort": 3000,
                          "protocol": "http",
                          "public": true
                        }
                      ]
                    },
                    "dev": {
                      "type": "localCommand",
                      "workingDirectory": "apps/shell",
                      "command": "npm run dev"
                    }
                  }
                }
              ],
              "endpoints": [
                {
                  "key": "web",
                  "service": "web",
                  "port": "http",
                  "protocol": "http",
                  "public": true
                }
              ],
              "capabilities": ["open", "update", "restart", "stop", "logs"]
            }
            """;

    private sealed record TestFixture(
        CoreDataPaths Paths,
        AppRegistryStore Apps,
        AppSourceService Sources,
        CoreLifecycleService Lifecycle);

    private sealed class TestClock : IClock
    {
        public DateTimeOffset UtcNow { get; } = DateTimeOffset.Parse("2026-06-02T12:00:00Z");
    }

    private sealed class StubHttpMessageHandler(Func<HttpRequestMessage, HttpResponseMessage> handler) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(handler(request));
    }

    private sealed class NoopDockerRuntimeAdapter : IAppRuntimeAdapter
    {
        public string Type => "docker";

        public Task<AppRuntimeStartResult> StartAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
            => Task.FromResult(new AppRuntimeStartResult("running", []));

        public Task<AppRuntimeOperationResult> StopAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
            => Task.FromResult(new AppRuntimeOperationResult("stopped"));

        public Task<AppRuntimeOperationResult> RemoveAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
            => Task.FromResult(new AppRuntimeOperationResult("removed"));

        public Task<AppRuntimeLogsResult> GetLogsAsync(RuntimeLifecycleContext context, int tail, CancellationToken cancellationToken = default)
            => Task.FromResult(new AppRuntimeLogsResult(""));

        public Task<AppRuntimeHealthResult> GetHealthAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
            => Task.FromResult(new AppRuntimeHealthResult("unknown", []));
    }
}
