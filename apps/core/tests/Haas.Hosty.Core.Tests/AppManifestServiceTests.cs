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

    [Fact]
    public async Task LoadAsync_AcceptsHostExposedRawPort()
    {
        var manifestPath = await WriteManifestAsync(
            "com.example.notes",
            ports: """, "ports": [{ "key": "torrent", "containerPort": 6881, "hostPort": 6881, "expose": "host", "transport": ["tcp", "udp"] }]""");

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        var port = selection.Services.Single().Runtime.Ports.Single();
        Assert.Equal("host", port.Expose);
        Assert.Equal(["tcp", "udp"], port.Transport);
    }

    [Theory]
    [InlineData(""", "ports": [{ "containerPort": 6881, "expose": "everywhere" }]""", "app_manifest_port_expose_invalid")]
    [InlineData(""", "ports": [{ "containerPort": 6881, "transport": ["sctp"] }]""", "app_manifest_port_transport_invalid")]
    [InlineData(""", "ports": [{ "containerPort": 6881, "transport": [] }]""", "app_manifest_port_transport_invalid")]
    [InlineData(""", "ports": [{ "containerPort": 6881, "transport": ["tcp", "tcp"] }]""", "app_manifest_port_transport_duplicate")]
    [InlineData(""", "ports": [{ "containerPort": 6881, "expose": "host" }]""", "app_manifest_port_host_requires_pinned_port")]
    public async Task LoadAsync_RejectsInvalidRawPorts(string ports, string expectedCode)
    {
        var manifestPath = await WriteManifestAsync("com.example.notes", ports: ports);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == expectedCode);
    }

    [Fact]
    public async Task LoadAsync_AcceptsHostNetworkAndRelaxesPortPinRequirement()
    {
        // network "host" emits no `-p`, so a host-exposed port no longer needs a pinned hostPort —
        // the same manifest would be rejected under bridge networking.
        var manifestPath = await WriteManifestAsync(
            "com.example.notes",
            ports: """, "ports": [{ "key": "torrent", "containerPort": 6881, "expose": "host" }]""",
            runtimeNetwork: """, "network": "host" """);

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        var service = selection.Services.Single();
        Assert.Equal("host", service.Runtime.Network);
        Assert.True(service.Runtime.IsHostNetwork);
    }

    [Fact]
    public async Task LoadAsync_RejectsInvalidNetwork()
    {
        var manifestPath = await WriteManifestAsync("com.example.notes", runtimeNetwork: """, "network": "lan" """);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == "app_manifest_service_network_invalid");
    }

    [Fact]
    public async Task LoadAsync_RejectsHostNetworkUnderLocalCommand()
    {
        var root = Path.Combine(Path.GetTempPath(), $"hosty-core-manifest-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        var manifestPath = Path.Combine(root, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, """
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.notes",
              "name": "Notes",
              "version": "1.0.0",
              "runtimeProfiles": [{ "key": "dev", "type": "localCommand", "default": true }],
              "services": [{
                "key": "app",
                "runtimes": {
                  "dev": {
                    "type": "localCommand",
                    "command": "dotnet run",
                    "network": "host"
                  }
                }
              }]
            }
            """);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == "app_manifest_service_network_host_requires_docker");
    }

    [Fact]
    public async Task LoadAsync_AcceptsCrossAppDependencyWithEndpoints()
    {
        var manifestPath = await WriteManifestAsync(
            "com.example.notes",
            dependencies: """, "dependencies": [{ "id": "com.haas.torrent-engine", "endpoints": [{ "key": "control", "as": "torrent" }] }]""");

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        var dependency = Assert.Single(selection.Manifest.Dependencies);
        Assert.Equal("com.haas.torrent-engine", dependency.Id);
        Assert.True(dependency.RequiredOrDefault); // absent defaults to true
        var endpoint = Assert.Single(dependency.Endpoints);
        Assert.Equal("control", endpoint.Key);
        Assert.Equal("torrent", endpoint.Alias);
    }

    [Theory]
    [InlineData(""", "dependencies": [{ "id": "" }]""", "app_manifest_dependency_id_required")]
    [InlineData(""", "dependencies": [{ "id": "com.haas.torrent-engine", "endpoints": [{ "key": "" }] }]""", "app_manifest_dependency_endpoint_key_required")]
    [InlineData(""", "dependencies": [{ "id": "com.haas.torrent-engine", "endpoints": [{ "key": "control" }, { "key": "metrics", "as": "control" }] }]""", "app_manifest_dependency_alias_collision")]
    public async Task LoadAsync_RejectsInvalidDependencies(string dependencies, string expectedCode)
    {
        var manifestPath = await WriteManifestAsync("com.example.notes", dependencies: dependencies);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == expectedCode);
    }

    [Fact]
    public async Task LoadAsync_AcceptsDependsOnStringAndObjectForms()
    {
        var manifestPath = await WriteTwoServiceManifestAsync("""[ "api", { "service": "api", "port": "internal" } ]""");

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        var web = selection.Services.Single(service => service.Key == "web");
        Assert.Collection(
            web.DependsOn,
            first =>
            {
                Assert.Equal("api", first.Service);
                Assert.Null(first.Port);
            },
            second =>
            {
                Assert.Equal("api", second.Service);
                Assert.Equal("internal", second.Port);
            });
    }

    [Fact]
    public async Task LoadAsync_AcceptsDependsOnPortByContainerNumber()
    {
        // "internal" port has containerPort 3000; targeting it numerically must resolve.
        var manifestPath = await WriteTwoServiceManifestAsync("""[ { "service": "api", "port": 3000 } ]""");

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        var dependency = Assert.Single(selection.Services.Single(service => service.Key == "web").DependsOn);
        Assert.Equal("3000", dependency.Port);
    }

    [Theory]
    [InlineData("""[ "web" ]""", "app_manifest_service_depends_on_self")]
    [InlineData("""[ "missing" ]""", "app_manifest_service_depends_on_unknown")]
    [InlineData("""[ { "service": "api", "port": "nope" } ]""", "app_manifest_service_depends_on_port_unknown")]
    // A wrong-typed `service` value is skipped by the converter, leaving no service named.
    [InlineData("""[ { "service": ["api"] } ]""", "app_manifest_service_depends_on_required")]
    public async Task LoadAsync_RejectsInvalidDependsOn(string dependsOn, string expectedCode)
    {
        var manifestPath = await WriteTwoServiceManifestAsync(dependsOn);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == expectedCode);
    }

    private static async Task<string> WriteTwoServiceManifestAsync(string dependsOn)
    {
        var root = Path.Combine(Path.GetTempPath(), $"hosty-core-manifest-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, "manifest.json");
        await File.WriteAllTextAsync(path, $$"""
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.app",
              "name": "App",
              "version": "1.0.0",
              "runtimeProfiles": [{ "key": "docker", "type": "docker", "default": true }],
              "services": [
                {
                  "key": "api",
                  "runtimes": {
                    "docker": {
                      "type": "docker",
                      "image": "ghcr.io/example/api:1.0.0",
                      "ports": [{ "key": "internal", "containerPort": 3000 }]
                    }
                  }
                },
                {
                  "key": "web",
                  "dependsOn": {{dependsOn}},
                  "runtimes": {
                    "docker": {
                      "type": "docker",
                      "image": "ghcr.io/example/web:1.0.0",
                      "ports": [{ "key": "http", "containerPort": 3000, "public": true }]
                    }
                  }
                }
              ]
            }
            """);
        return path;
    }

    private static async Task<string> WriteManifestAsync(string appId, string? externalMounts = null, string? ports = null, string? runtimeNetwork = null, string? dependencies = null)
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
                    "image": "ghcr.io/example/notes:1.0.0"{{runtimeNetwork ?? ""}}{{ports ?? ""}}
                  }
                }
              }]{{externalMounts ?? ""}}{{dependencies ?? ""}}
            }
            """);
        return path;
    }
}
