using Haas.DockerHost.Cli.Commands;

namespace Haas.DockerHost.Cli.Tests.Commands;

public sealed class DevManifestTests
{
    [Fact]
    public void Load_MetadataFileManifest_ResolvesRelativePathsAndDefaults()
    {
        var root = Directory.CreateTempSubdirectory("docker-host-dev-manifest-").FullName;
        var manifestDirectory = Path.Combine(root, ".docker-host");
        Directory.CreateDirectory(manifestDirectory);
        File.WriteAllText(Path.Combine(root, "metadata.json"), "{}");
        var manifestPath = Path.Combine(manifestDirectory, "dev.json");
        File.WriteAllText(manifestPath, """
            {
              "metadataFile": "../metadata.json",
              "moduleCommand": "npm run dev",
              "workingDirectory": "..",
              "target": {
                "hostname": "demo.localhost",
                "portKey": "http",
                "targetBaseUrl": "http://host.docker.internal:3100"
              },
              "users": [
                { "email": "user@docker-host.local", "role": "host.user", "assigned": true }
              ],
              "environment": {
                "PORT": "3100"
              }
            }
            """);

        var manifest = DevManifest.Load(manifestPath);

        Assert.Equal(Path.Combine(root, "metadata.json"), manifest.ResolveMetadataFile());
        Assert.Equal(root, manifest.ResolveWorkingDirectory());
        Assert.Equal("mdev_demo_localhost", manifest.GetTargetId());
        Assert.Equal("docker-host-dev-user", manifest.GetPassword(manifest.Users[0]));
        Assert.Equal(DevHostMode.DockerContainer, manifest.GetHostMode());
        Assert.Null(manifest.GetHostOrigin());
        Assert.Equal("http://host.docker.internal:3100", manifest.GetTargetBaseUrl(DevHostMode.DockerContainer));
        Assert.Equal("3100", manifest.Environment["PORT"]);
    }

    [Fact]
    public void Load_LocalProcessHost_ResolvesOriginAndLocalPortTarget()
    {
        var root = Directory.CreateTempSubdirectory("docker-host-dev-manifest-").FullName;
        var manifestPath = Path.Combine(root, "dev.json");
        File.WriteAllText(manifestPath, """
            {
              "metadataUrl": "http://localhost:3000/metadata.json",
              "host": {
                "mode": "local-process",
                "port": 3005,
                "command": "npm run host:dev"
              },
              "target": {
                "hostname": "demo.localhost",
                "portKey": "http",
                "localPort": 3100
              }
            }
            """);

        var manifest = DevManifest.Load(manifestPath);

        Assert.Equal(DevHostMode.LocalProcess, manifest.GetHostMode());
        Assert.Equal("http://localhost:3005/", manifest.GetHostOrigin()?.ToString());
        Assert.Equal("http://127.0.0.1:3100", manifest.GetTargetBaseUrl(DevHostMode.LocalProcess));
        Assert.Equal("http://host.docker.internal:3100", manifest.GetTargetBaseUrl(DevHostMode.DockerContainer));
    }

    [Fact]
    public void Load_ExternalHostWithoutOrigin_ThrowsUsageError()
    {
        var root = Directory.CreateTempSubdirectory("docker-host-dev-manifest-").FullName;
        var manifestPath = Path.Combine(root, "dev.json");
        File.WriteAllText(manifestPath, """
            {
              "metadataUrl": "http://localhost:3000/metadata.json",
              "host": {
                "mode": "external"
              },
              "target": {
                "hostname": "demo.localhost",
                "portKey": "http",
                "localPort": 3100
              }
            }
            """);

        Assert.Throws<CommandUsageException>(() => DevManifest.Load(manifestPath));
    }

    [Fact]
    public void Load_DuplicateUserEmails_ThrowsUsageError()
    {
        var root = Directory.CreateTempSubdirectory("docker-host-dev-manifest-").FullName;
        var manifestPath = Path.Combine(root, "dev.json");
        File.WriteAllText(manifestPath, """
            {
              "metadataUrl": "http://localhost:3000/metadata.json",
              "target": {
                "hostname": "demo.localhost",
                "portKey": "http",
                "targetBaseUrl": "http://127.0.0.1:3100"
              },
              "users": [
                { "email": "user@docker-host.local", "role": "host.user" },
                { "email": "USER@docker-host.local", "role": "host.user" }
              ]
            }
            """);

        Assert.Throws<CommandUsageException>(() => DevManifest.Load(manifestPath));
    }
}
