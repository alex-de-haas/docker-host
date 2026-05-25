using System.Net;
using System.Net.Http;
using System.Text;
using Haas.DockerHost.Cli;
using Haas.DockerHost.Cli.Commands;
using Haas.DockerHost.Cli.Configuration;
using Haas.DockerHost.Cli.Docker;
using Haas.DockerHost.Cli.HostApi;
using Spectre.Console;

namespace Haas.DockerHost.Cli.Tests.Commands;

public sealed class UninstallCommandTests : IDisposable
{
    private const string RootVariable = "DOCKER_HOST_HOME";
    private readonly string? previousRoot;
    private readonly string rootDirectory;

    public UninstallCommandTests()
    {
        previousRoot = Environment.GetEnvironmentVariable(RootVariable);
        rootDirectory = Path.Combine(Path.GetTempPath(), $"docker-host-uninstall-tests-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);
    }

    [Fact]
    public async Task RunAsync_UninstallWithArguments_ReturnsUsageError()
    {
        var exitCode = await CommandLine.RunAsync(["uninstall", "--delete-data"]);

        Assert.Equal(2, exitCode);
    }

    [Fact]
    public void Delete_DefaultRoot_RemovesHostFilesAndPreservesCliBin()
    {
        var environment = DockerHostEnvironment.Current();
        Directory.CreateDirectory(environment.BinDirectory);
        Directory.CreateDirectory(environment.ConfigDirectory);
        Directory.CreateDirectory(environment.ModulesDirectory);
        File.WriteAllText(Path.Combine(environment.BinDirectory, "docker-host"), "binary");
        File.WriteAllText(environment.LaunchConfigPath, "HOST_UI_PORT=3000");
        File.WriteAllText(Path.Combine(environment.RootDirectory, "modules.json"), "{}");
        File.WriteAllText(Path.Combine(environment.RootDirectory, "host-cache.txt"), "cache");

        var result = HostUninstallFileCleanup.Delete(environment, environment.RootDirectory);

        Assert.Contains(Path.Combine(environment.RootDirectory, "modules.json"), result.DeletedPaths);
        Assert.True(File.Exists(Path.Combine(environment.BinDirectory, "docker-host")));
        Assert.False(Directory.Exists(environment.ConfigDirectory));
        Assert.False(Directory.Exists(environment.ModulesDirectory));
        Assert.False(File.Exists(Path.Combine(environment.RootDirectory, "host-cache.txt")));
    }

    [Fact]
    public void Delete_ExternalDataRoot_RemovesKnownHostStateOnly()
    {
        var environment = DockerHostEnvironment.Current();
        var externalDataRoot = Path.Combine(Path.GetTempPath(), $"docker-host-data-{Guid.NewGuid():N}");
        Directory.CreateDirectory(environment.BinDirectory);
        Directory.CreateDirectory(environment.ConfigDirectory);
        Directory.CreateDirectory(environment.ModulesDirectory);
        Directory.CreateDirectory(Path.Combine(externalDataRoot, "modules"));
        File.WriteAllText(Path.Combine(environment.BinDirectory, "docker-host"), "binary");
        File.WriteAllText(environment.LaunchConfigPath, "HOST_DATA_ROOT_HOST=/custom");
        File.WriteAllText(Path.Combine(externalDataRoot, "modules.json"), "{}");
        File.WriteAllText(Path.Combine(externalDataRoot, "keep.txt"), "not owned by docker-host");

        try
        {
            HostUninstallFileCleanup.Delete(environment, externalDataRoot);

            Assert.True(File.Exists(Path.Combine(environment.BinDirectory, "docker-host")));
            Assert.False(Directory.Exists(environment.ConfigDirectory));
            Assert.False(Directory.Exists(environment.ModulesDirectory));
            Assert.False(File.Exists(Path.Combine(externalDataRoot, "modules.json")));
            Assert.False(Directory.Exists(Path.Combine(externalDataRoot, "modules")));
            Assert.True(File.Exists(Path.Combine(externalDataRoot, "keep.txt")));
        }
        finally
        {
            if (Directory.Exists(externalDataRoot))
            {
                Directory.Delete(externalDataRoot, recursive: true);
            }
        }
    }

    [Fact]
    public void LoadFromDataRoot_ModulesJsonContainsInstalledModules_ReturnsCleanupRecords()
    {
        Directory.CreateDirectory(rootDirectory);
        File.WriteAllText(
            Path.Combine(rootDirectory, "modules.json"),
            """
            {
              "modules": [
                {
                  "id": "com.acme.reports",
                  "containerName": "custom-reports",
                  "image": {
                    "reference": "ghcr.io/acme/reports:1.0.0"
                  }
                },
                {
                  "id": "com.acme.Identity",
                  "image": {
                    "repository": "ghcr.io/acme/identity",
                    "tag": "2.0.0"
                  }
                }
              ]
            }
            """);

        var result = ModuleCleanupRecord.LoadFromDataRoot(rootDirectory);

        Assert.Null(result.Error);
        Assert.Collection(
            result.Modules,
            module =>
            {
                Assert.Equal("com.acme.reports", module.Id);
                Assert.Equal("custom-reports", module.ContainerName);
                Assert.Equal("ghcr.io/acme/reports:1.0.0", module.ImageReference);
            },
            module =>
            {
                Assert.Equal("com.acme.Identity", module.Id);
                Assert.Equal("mod-com-acme-identity", module.ContainerName);
                Assert.Equal("ghcr.io/acme/identity:2.0.0", module.ImageReference);
            });
    }

    [Fact]
    public void LoadFromDataRoot_ModulesJsonContainsMultiContainerModule_ReturnsAllContainers()
    {
        Directory.CreateDirectory(rootDirectory);
        File.WriteAllText(
            Path.Combine(rootDirectory, "modules.json"),
            """
            {
              "modules": [
                {
                  "id": "com.acme.reports",
                  "containers": [
                    {
                      "key": "web",
                      "containerName": "mod-com-acme-reports-web",
                      "image": {
                        "reference": "ghcr.io/acme/reports-web:1.0.0"
                      }
                    },
                    {
                      "key": "worker",
                      "containerName": "mod-com-acme-reports-worker",
                      "image": {
                        "repository": "ghcr.io/acme/reports-worker",
                        "tag": "1.0.0"
                      }
                    }
                  ]
                }
              ]
            }
            """);

        var result = ModuleCleanupRecord.LoadFromDataRoot(rootDirectory);

        Assert.Null(result.Error);
        var module = Assert.Single(result.Modules);
        Assert.Equal("com.acme.reports", module.Id);
        Assert.Equal(
            ["mod-com-acme-reports-web", "mod-com-acme-reports-worker"],
            module.Containers.Select(container => container.ContainerName));
        Assert.Equal(
            ["ghcr.io/acme/reports-web:1.0.0", "ghcr.io/acme/reports-worker:1.0.0"],
            module.ImageReferences);
        Assert.Equal(
            ["mod-com-acme-reports-worker", "mod-com-acme-reports-web"],
            module.GetContainersInStopOrder().Select(container => container.ContainerName));
    }

    [Fact]
    public async Task ExecuteAsync_ModuleContainerRemoveFails_ContinuesRemovingHostContainer()
    {
        Directory.CreateDirectory(rootDirectory);
        File.WriteAllText(
            Path.Combine(rootDirectory, "modules.json"),
            """
            {
              "modules": [
                {
                  "id": "com.acme.reports",
                  "containers": [
                    {
                      "key": "web",
                      "containerName": "mod-com-acme-reports-web"
                    },
                    {
                      "key": "worker",
                      "containerName": "mod-com-acme-reports-worker"
                    }
                  ]
                }
              ]
            }
            """);
        var transport = new FakeDockerTransport(["/containers/mod-com-acme-reports-web?force=true&v=false"]);
        var context = CreateContext(transport);

        var exitCode = await new UninstallCommand(context).ExecuteAsync([]);

        Assert.Equal(0, exitCode);
        Assert.Contains(
            transport.Requests.Select(request => request.PathAndQuery),
            path => path == "/containers/docker-host?force=true&v=false");
        Assert.Equal(
            [
                "/version",
                "/containers/mod-com-acme-reports-web?force=true&v=false",
                "/containers/mod-com-acme-reports-worker?force=true&v=false",
                "/containers/docker-host?force=true&v=false",
            ],
            transport.Requests
                .Where(request =>
                    request.PathAndQuery == "/version" ||
                    request.PathAndQuery.StartsWith("/containers/", StringComparison.Ordinal))
                .Select(request => request.PathAndQuery));
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable(RootVariable, previousRoot);

        if (Directory.Exists(rootDirectory))
        {
            Directory.Delete(rootDirectory, recursive: true);
        }
    }

    private static CommandContext CreateContext(FakeDockerTransport transport)
    {
        var environment = DockerHostEnvironment.Current();
        return new CommandContext(
            CreateConsole(),
            environment,
            new LaunchSettingsStore(environment),
            new FakeDockerEngineClientFactory(transport),
            new HostControlClientFactory());
    }

    private static IAnsiConsole CreateConsole()
    {
        var output = new StringWriter();
        return AnsiConsole.Create(new AnsiConsoleSettings
        {
            Out = new AnsiConsoleOutput(output),
            Interactive = InteractionSupport.No,
        });
    }

    private sealed class FakeDockerEngineClientFactory(IDockerEngineTransport transport) : DockerEngineClientFactory
    {
        public override DockerEngineClient Create(string endpoint) => new(transport);
    }

    private sealed class FakeDockerTransport(IReadOnlyCollection<string>? failedRemovePaths = null) : IDockerEngineTransport
    {
        public List<(HttpMethod Method, string PathAndQuery)> Requests { get; } = [];

        public Task<DockerEngineResponse> SendAsync(
            string operation,
            HttpMethod method,
            string pathAndQuery,
            object? body = null,
            CancellationToken cancellationToken = default)
        {
            Requests.Add((method, pathAndQuery));

            if (method == HttpMethod.Get && pathAndQuery == "/version")
            {
                return Task.FromResult(Response(
                    operation,
                    HttpStatusCode.OK,
                    """
                    {
                      "OSType": "linux"
                    }
                    """));
            }

            if (method == HttpMethod.Delete)
            {
                if (failedRemovePaths?.Contains(pathAndQuery) == true)
                {
                    return Task.FromResult(Response(operation, HttpStatusCode.InternalServerError, """{"message":"remove failed"}"""));
                }

                return Task.FromResult(Response(operation, HttpStatusCode.NoContent, ""));
            }

            return Task.FromResult(Response(operation, HttpStatusCode.NotFound, """{"message":"not found"}"""));
        }

        public void Dispose()
        {
        }

        private static DockerEngineResponse Response(string operation, HttpStatusCode statusCode, string body)
        {
            var bytes = Encoding.UTF8.GetBytes(body);
            return new DockerEngineResponse(
                operation,
                statusCode,
                body,
                bytes,
                new Dictionary<string, IReadOnlyList<string>>(StringComparer.OrdinalIgnoreCase));
        }
    }
}
