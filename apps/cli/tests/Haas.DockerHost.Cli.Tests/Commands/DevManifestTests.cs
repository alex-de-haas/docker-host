using System.Text.Json;
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
    public void Load_MetadataDevJson_SelectsPublicUiServiceFromMultiServiceMetadata()
    {
        var root = Directory.CreateTempSubdirectory("docker-host-dev-metadata-").FullName;
        var manifestPath = Path.Combine(root, "metadata.dev.json");
        File.WriteAllText(manifestPath, """
            {
              "schemaVersion": "0.3",
              "id": "com.example.fullstack",
              "name": "Fullstack App",
              "version": "1.0.0",
              "services": [
                {
                  "key": "backend",
                  "source": {
                    "type": "process",
                    "command": "npm run dev:backend",
                    "environment": {
                      "PORT": "3101"
                    }
                  },
                  "runtime": {
                    "ports": [
                      { "key": "http", "containerPort": 3000, "localPort": 3101, "protocol": "http" }
                    ]
                  }
                },
                {
                  "key": "frontend",
                  "dependsOn": ["backend"],
                  "source": {
                    "type": "process",
                    "command": "npm run dev:frontend",
                    "environment": {
                      "DEMO_BACKEND_BASE_URL": "http://localhost:3101"
                    }
                  },
                  "runtime": {
                    "ports": [
                      { "key": "http", "containerPort": 3000, "localPort": 3100, "protocol": "http" }
                    ]
                  }
                }
              ],
              "endpoints": [
                { "key": "api", "service": "backend", "port": "http", "public": false },
                { "key": "http", "service": "frontend", "port": "http", "public": true }
              ],
              "ui": {
                "entrypoint": { "portKey": "http", "path": "/" }
              }
            }
            """);

        var manifest = DevManifest.Load(manifestPath);

        Assert.Equal("npm run dev:frontend", manifest.ModuleCommand);
        Assert.Equal("http", manifest.Target.PortKey);
        Assert.Equal("http://127.0.0.1:3100", manifest.GetTargetBaseUrl());
        Assert.Equal("3100", manifest.Environment["PORT"]);
        Assert.Equal("http://localhost:3101", manifest.Environment["DEMO_BACKEND_BASE_URL"]);

        using var hostMetadata = JsonDocument.Parse(manifest.HostMetadataBytes);
        Assert.Equal(2, hostMetadata.RootElement.GetProperty("services").GetArrayLength());
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
    public void Load_MetadataDevJson_ReadsDevelopmentUsersAndStripsThemFromServedMetadata()
    {
        var root = Directory.CreateTempSubdirectory("docker-host-dev-metadata-").FullName;
        var manifestPath = Path.Combine(root, "metadata.dev.json");
        File.WriteAllText(manifestPath, """
            {
              "schemaVersion": "0.3",
              "id": "com.example.reports",
              "name": "Reports",
              "version": "1.0.0",
              "development": {
                "users": [
                  {
                    "email": "reviewer@example.test",
                    "displayName": "Review User",
                    "role": "user"
                  },
                  {
                    "email": "operator@example.test",
                    "name": "Operator Admin",
                    "role": "host-admin",
                    "assigned": false
                  }
                ]
              },
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

        Assert.Equal(4, manifest.Users.Count);
        Assert.Contains(manifest.Users, user =>
            user.Email == "reviewer@example.test" &&
            user.DisplayName == "Review User" &&
            user.Role == "host.user" &&
            user.Assigned);
        Assert.Contains(manifest.Users, user =>
            user.Email == "operator@example.test" &&
            user.DisplayName == "Operator Admin" &&
            user.Role == "host.admin" &&
            !user.Assigned);

        using var hostMetadata = JsonDocument.Parse(manifest.HostMetadataBytes);
        Assert.False(hostMetadata.RootElement.TryGetProperty("development", out _));
        Assert.Equal("com.example.reports", hostMetadata.RootElement.GetProperty("id").GetString());
    }

    [Fact]
    public void Load_InvalidJson_ThrowsSyntaxUsageError()
    {
        var root = Directory.CreateTempSubdirectory("docker-host-dev-metadata-").FullName;
        var manifestPath = Path.Combine(root, "metadata.dev.json");
        File.WriteAllText(manifestPath, """
            {
              "schemaVersion": "0.3",
              "services": [
            }
            """);

        var exception = Assert.Throws<CommandUsageException>(() => DevManifest.Load(manifestPath));

        Assert.Contains("Dev metadata is not valid JSON:", exception.Message);
    }

    [Fact]
    public void Load_MetadataDevJson_UsesDevelopmentUserEnvironmentOverrides()
    {
        var originalEnvironment = SetEnvironment(
            ("HOST_DEV_ADMIN_EMAIL", "local-admin@example.test"),
            ("HOST_DEV_ADMIN_NAME", "Local Admin"),
            ("HOST_DEV_ADMIN_PASSWORD", "local-admin-password"),
            ("HOST_DEV_USER_EMAIL", "local-user@example.test"),
            ("HOST_DEV_USER_NAME", "Local User"),
            ("HOST_DEV_USER_PASSWORD", "local-user-password"));
        try
        {
            var root = Directory.CreateTempSubdirectory("docker-host-dev-metadata-").FullName;
            var manifestPath = Path.Combine(root, "metadata.dev.json");
            File.WriteAllText(manifestPath, """
                {
                  "schemaVersion": "0.3",
                  "id": "com.example.reports",
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

            var admin = Assert.Single(manifest.Users, user => user.Role == "host.admin");
            Assert.Equal("local-admin@example.test", admin.Email);
            Assert.Equal("Local Admin", admin.DisplayName);
            Assert.Equal("local-admin-password", manifest.GetPassword(admin));

            var user = Assert.Single(manifest.Users, user => user.Role == "host.user");
            Assert.Equal("local-user@example.test", user.Email);
            Assert.Equal("Local User", user.DisplayName);
            Assert.Equal("local-user-password", manifest.GetPassword(user));
        }
        finally
        {
            RestoreEnvironment(originalEnvironment);
        }
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

    private static Dictionary<string, string?> SetEnvironment(params (string Key, string Value)[] values)
    {
        var originalEnvironment = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (var (key, value) in values)
        {
            originalEnvironment[key] = Environment.GetEnvironmentVariable(key);
            Environment.SetEnvironmentVariable(key, value);
        }

        return originalEnvironment;
    }

    private static void RestoreEnvironment(IReadOnlyDictionary<string, string?> originalEnvironment)
    {
        foreach (var (key, value) in originalEnvironment)
        {
            Environment.SetEnvironmentVariable(key, value);
        }
    }
}
