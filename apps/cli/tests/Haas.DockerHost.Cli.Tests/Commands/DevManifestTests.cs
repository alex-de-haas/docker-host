using Haas.DockerHost.Cli.Commands;

namespace Haas.DockerHost.Cli.Tests.Commands;

public sealed class DevManifestTests
{
    [Fact]
    public void Load_MetadataDevJson_MapsProcessServiceToDevManifest()
    {
        var root = Directory.CreateTempSubdirectory("docker-host-dev-metadata-").FullName;
        var manifestPath = Path.Combine(root, "metadata.dev.json");
        File.WriteAllText(manifestPath, """
            {
              "schemaVersion": "0.3",
              "id": "com.example.reports",
              "name": "Reports",
              "version": "1.0.0",
              "services": [
                {
                  "key": "app",
                  "source": {
                    "type": "process",
                    "command": "npm run dev",
                    "workingDirectory": ".",
                    "environment": { "EXAMPLE": "true" }
                  },
                  "runtime": {
                    "ports": [
                      { "key": "http", "containerPort": 3000, "localPort": 3100, "protocol": "http" }
                    ]
                  }
                }
              ],
              "endpoints": [
                { "key": "http", "service": "app", "port": "http", "public": true }
              ],
              "ui": {
                "entrypoint": { "portKey": "http", "path": "/" },
                "navigation": []
              }
            }
            """);

        var manifest = DevManifest.Load(root);

        Assert.Equal(manifestPath, manifest.ResolveMetadataFile());
        Assert.Equal("npm run dev", manifest.ModuleCommand);
        Assert.Equal(root, manifest.ResolveWorkingDirectory());
        Assert.Equal("com-example-reports.localhost", manifest.Target.Hostname);
        Assert.Equal("mdev_com_example_reports_localhost", manifest.GetTargetId());
        Assert.Equal("http", manifest.Target.PortKey);
        Assert.Equal("http://127.0.0.1:3100", manifest.GetTargetBaseUrl());
        Assert.Equal("3100", manifest.Environment["PORT"]);
        Assert.Equal("true", manifest.Environment["EXAMPLE"]);
        Assert.Equal(2, manifest.Users.Count);
        Assert.Contains(manifest.Users, user => user.Email == "admin@docker-host.local" && user.Role == "host.admin" && user.Assigned);
        Assert.Contains(manifest.Users, user => user.Email == "user@docker-host.local" && user.Role == "host.user" && user.Assigned);
        Assert.True(manifest.DirectoryPolicy?.IncludeEmail);
    }

    [Fact]
    public void Load_MetadataDevJson_FallsBackToContainerPortWhenLocalPortIsMissing()
    {
        var root = Directory.CreateTempSubdirectory("docker-host-dev-metadata-").FullName;
        var manifestPath = Path.Combine(root, "metadata.dev.json");
        File.WriteAllText(manifestPath, """
            {
              "schemaVersion": "0.3",
              "id": "com.example.worker-ui",
              "name": "Worker UI",
              "version": "1.0.0",
              "services": [
                {
                  "key": "app",
                  "source": {
                    "type": "process",
                    "command": "npm run dev"
                  },
                  "runtime": {
                    "ports": [
                      { "key": "http", "containerPort": 3100, "protocol": "http" }
                    ]
                  }
                }
              ],
              "endpoints": [
                { "key": "http", "service": "app", "port": "http", "public": true }
              ]
            }
            """);

        var manifest = DevManifest.Load(manifestPath);

        Assert.Equal("3100", manifest.Environment["PORT"]);
        Assert.Equal("http://127.0.0.1:3100", manifest.GetTargetBaseUrl());
    }

    [Fact]
    public void Load_CustomJsonManifest_ThrowsUsageError()
    {
        var root = Directory.CreateTempSubdirectory("docker-host-dev-metadata-").FullName;
        var manifestPath = Path.Combine(root, "custom-manifest.json");
        File.WriteAllText(manifestPath, """
            {
              "metadataUrl": "http://localhost:3000/metadata.json",
              "target": {
                "hostname": "reports.localhost",
                "portKey": "http",
                "targetBaseUrl": "http://127.0.0.1:3100"
              }
            }
            """);

        Assert.Throws<CommandUsageException>(() => DevManifest.Load(manifestPath));
    }

    [Fact]
    public void Load_MetadataWithoutProcessService_ThrowsUsageError()
    {
        var root = Directory.CreateTempSubdirectory("docker-host-dev-metadata-").FullName;
        var manifestPath = Path.Combine(root, "metadata.dev.json");
        File.WriteAllText(manifestPath, """
            {
              "schemaVersion": "0.3",
              "id": "com.example.reports",
              "name": "Reports",
              "version": "1.0.0",
              "services": [
                {
                  "key": "app",
                  "source": {
                    "type": "image",
                    "image": { "repository": "reports", "tag": "latest" }
                  },
                  "runtime": {
                    "ports": [
                      { "key": "http", "containerPort": 3000, "protocol": "http" }
                    ]
                  }
                }
              ],
              "endpoints": [
                { "key": "http", "service": "app", "port": "http", "public": true }
              ]
            }
            """);

        Assert.Throws<CommandUsageException>(() => DevManifest.Load(manifestPath));
    }
}
