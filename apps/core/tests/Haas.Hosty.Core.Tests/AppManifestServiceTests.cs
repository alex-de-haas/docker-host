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

    [Theory]
    [InlineData(""", "restartPolicy": { "mode": "sometimes" }""", "app_manifest_restart_policy_mode_invalid")]
    [InlineData(""", "restartPolicy": { "mode": "on-failure", "maxRetries": -1 }""", "app_manifest_restart_policy_max_retries_invalid")]
    [InlineData(""", "restartPolicy": { "mode": "always", "backoffSeconds": -5 }""", "app_manifest_restart_policy_backoff_invalid")]
    public async Task LoadAsync_RejectsInvalidRestartPolicy(string restartPolicy, string expectedCode)
    {
        var manifestPath = await WriteManifestAsync("com.example.notes", restartPolicy: restartPolicy);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == expectedCode);
    }

    [Fact]
    public async Task LoadAsync_AcceptsCaseInsensitiveRestartPolicyMode()
    {
        var manifestPath = await WriteManifestAsync(
            "com.example.notes",
            restartPolicy: """, "restartPolicy": { "mode": "ON-FAILURE" }""");

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        Assert.Equal("on-failure", RuntimeRestartPolicy.FromManifest(selection.Manifest.RestartPolicy).Mode);
    }

    [Theory]
    [InlineData(""", "healthcheck": { "type": "carrier-pigeon" }""", "app_manifest_healthcheck_type_invalid")]
    [InlineData(""", "healthcheck": { "type": "http" }""", "app_manifest_healthcheck_type_invalid")]
    [InlineData(""", "healthcheck": { "type": "exec" }""", "app_manifest_healthcheck_command_required")]
    [InlineData(""", "healthcheck": { "type": "exec", "command": "true", "intervalSeconds": 0 }""", "app_manifest_healthcheck_interval_invalid")]
    [InlineData(""", "healthcheck": { "type": "exec", "command": "true", "retries": 0 }""", "app_manifest_healthcheck_retries_invalid")]
    public async Task LoadAsync_RejectsInvalidHealthcheck(string healthcheck, string expectedCode)
    {
        var manifestPath = await WriteManifestAsync("com.example.notes", healthcheck: healthcheck);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == expectedCode);
    }

    [Fact]
    public async Task LoadAsync_AcceptsExecHealthcheck()
    {
        var manifestPath = await WriteManifestAsync(
            "com.example.notes",
            healthcheck: """, "healthcheck": { "type": "exec", "command": "true", "intervalSeconds": 30 }""");

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        var healthcheck = selection.Manifest.Services[0].Runtimes["docker"].Healthcheck;
        Assert.NotNull(healthcheck);
        Assert.Equal("exec", healthcheck.Type);
        Assert.Equal("true", healthcheck.Command);
        Assert.Equal(30, healthcheck.IntervalSeconds);
    }

    [Theory]
    [InlineData(""", "telemetry": { "enabled": true, "sampleRatio": 1.5 }""")]
    [InlineData(""", "telemetry": { "enabled": true, "sampleRatio": -0.1 }""")]
    public async Task LoadAsync_RejectsInvalidTelemetrySampleRatio(string telemetry)
    {
        var manifestPath = await WriteManifestAsync("com.example.notes", telemetry: telemetry);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == "app_manifest_telemetry_sample_ratio_invalid");
    }

    [Fact]
    public async Task LoadAsync_AcceptsTelemetryOptIn()
    {
        var manifestPath = await WriteManifestAsync(
            "com.example.notes",
            telemetry: """, "telemetry": { "enabled": true, "sampleRatio": 0.25 }""");

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        var settings = RuntimeTelemetrySettings.FromManifest(selection.Manifest.Telemetry);
        Assert.True(settings.Enabled);
        Assert.Equal(0.25, settings.SampleRatio);
    }

    [Fact]
    public void TelemetrySettings_DefaultsToDisabledWhenAbsentOrOff()
    {
        Assert.False(RuntimeTelemetrySettings.FromManifest(null).Enabled);
        Assert.False(RuntimeTelemetrySettings.FromManifest(new RuntimeAppTelemetryManifest { Enabled = false }).Enabled);
        // Opted in but no ratio -> sane head-based default.
        Assert.Equal(0.1, RuntimeTelemetrySettings.FromManifest(new RuntimeAppTelemetryManifest { Enabled = true }).SampleRatio);
    }

    [Fact]
    public void ValidateHealthcheck_DockerRejectsHttp()
    {
        var errors = new List<AppManifestValidationError>();

        AppManifestService.ValidateHealthcheck("api", "docker", [], new RuntimeServiceHealthcheckManifest { Type = "http" }, errors);

        Assert.Contains(errors, candidate => candidate.Code == "app_manifest_healthcheck_type_invalid");
    }

    [Fact]
    public void ValidateHealthcheck_LocalCommandRejectsExec()
    {
        var errors = new List<AppManifestValidationError>();

        AppManifestService.ValidateHealthcheck("api", "localCommand", [], new RuntimeServiceHealthcheckManifest { Type = "exec", Command = "true" }, errors);

        Assert.Contains(errors, candidate => candidate.Code == "app_manifest_healthcheck_type_invalid");
    }

    [Fact]
    public void ValidateHealthcheck_HttpWithoutDeclaredPorts_RequiresPort()
    {
        var errors = new List<AppManifestValidationError>();

        AppManifestService.ValidateHealthcheck("api", "localCommand", [], new RuntimeServiceHealthcheckManifest { Type = "http" }, errors);

        Assert.Contains(errors, candidate => candidate.Code == "app_manifest_healthcheck_port_required");
    }

    [Fact]
    public void ValidateHealthcheck_HttpPortNotDeclared_IsRejected()
    {
        var errors = new List<AppManifestValidationError>();

        AppManifestService.ValidateHealthcheck(
            "api", "localCommand", [new RuntimePortManifest { ContainerPort = 3000 }],
            new RuntimeServiceHealthcheckManifest { Type = "http", Port = 9999 }, errors);

        Assert.Contains(errors, candidate => candidate.Code == "app_manifest_healthcheck_port_unknown");
    }

    [Fact]
    public void ValidateHealthcheck_NonPositiveInterval_IsRejected()
    {
        var errors = new List<AppManifestValidationError>();

        AppManifestService.ValidateHealthcheck(
            "api", "localCommand", [new RuntimePortManifest { ContainerPort = 3000 }],
            new RuntimeServiceHealthcheckManifest { Type = "tcp", Port = 3000, IntervalSeconds = 0 }, errors);

        Assert.Contains(errors, candidate => candidate.Code == "app_manifest_healthcheck_interval_invalid");
    }

    [Fact]
    public void ValidateHealthcheck_ValidLocalCommandHttp_HasNoErrors()
    {
        var errors = new List<AppManifestValidationError>();

        AppManifestService.ValidateHealthcheck(
            "api", "localCommand", [new RuntimePortManifest { ContainerPort = 3000 }],
            new RuntimeServiceHealthcheckManifest { Type = "http", Port = 3000, Path = "/healthz", IntervalSeconds = 10 }, errors);

        Assert.Empty(errors);
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
    [InlineData(""", "dependencies": [{ "id": "com.haas.torrent-engine" }, { "id": "com.haas.torrent-engine" }]""", "app_manifest_dependency_duplicate_id")]
    public async Task LoadAsync_RejectsInvalidDependencies(string dependencies, string expectedCode)
    {
        var manifestPath = await WriteManifestAsync("com.example.notes", dependencies: dependencies);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == expectedCode);
    }

    [Fact]
    public async Task LoadAsync_AcceptsCapabilitiesAndDevices()
    {
        var manifestPath = await WriteManifestAsync(
            "com.example.notes",
            runtimeNetwork: """, "capabilities": ["NET_ADMIN"], "devices": ["/dev/net/tun"] """);

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        var runtime = selection.Services.Single().Runtime;
        Assert.Equal(["NET_ADMIN"], runtime.Capabilities);
        Assert.Equal(["/dev/net/tun"], runtime.Devices);
    }

    [Theory]
    [InlineData(""", "capabilities": ["NOT_A_CAP"]""", "app_manifest_service_capability_invalid")]
    [InlineData(""", "capabilities": ["NET_ADMIN", "CAP_NET_ADMIN"]""", "app_manifest_service_capability_duplicate")]
    [InlineData(""", "devices": ["/etc/passwd"]""", "app_manifest_service_device_invalid")]
    [InlineData(""", "devices": ["/dev/net/tun:/dev/tun"]""", "app_manifest_service_device_invalid")]
    [InlineData(""", "devices": ["/dev/net/"]""", "app_manifest_service_device_invalid")]
    public async Task LoadAsync_RejectsInvalidCapabilitiesOrDevices(string fragment, string expectedCode)
    {
        var manifestPath = await WriteManifestAsync("com.example.notes", runtimeNetwork: fragment);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == expectedCode);
    }

    [Fact]
    public async Task LoadAsync_RejectsCapabilitiesUnderLocalCommand()
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
                    "capabilities": ["NET_ADMIN"]
                  }
                }
              }]
            }
            """);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == "app_manifest_service_capabilities_require_docker");
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

    [Fact]
    public async Task LoadAsync_DockerRuntime_DefaultsArtifactToImage()
    {
        var manifestPath = await WriteManifestAsync("com.example.notes");

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        Assert.Equal("image", Assert.Single(selection.Services).Artifact);
    }

    [Fact]
    public async Task LoadAsync_LocalCommandRuntime_DefaultsArtifactToSource()
    {
        var manifestPath = await WriteLocalCommandManifestAsync("com.example.notes");

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        Assert.Equal("source", Assert.Single(selection.Services).Artifact);
    }

    [Fact]
    public async Task LoadAsync_AcceptsExplicitMatchingArtifact()
    {
        var manifestPath = await WriteManifestAsync("com.example.notes", runtimeArtifact: """, "artifact": "image" """);

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        Assert.Equal("image", Assert.Single(selection.Services).Artifact);
    }

    [Theory]
    [InlineData(""", "artifact": "source" """)]   // docker cannot be a source artifact
    [InlineData(""", "artifact": "prebuilt" """)] // reserved, out of v1
    [InlineData(""", "artifact": "bundle" """)]   // unknown value
    public async Task LoadAsync_RejectsUnsupportedDockerArtifact(string runtimeArtifact)
    {
        var manifestPath = await WriteManifestAsync("com.example.notes", runtimeArtifact: runtimeArtifact);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == "app_runtime_artifact_unsupported");
    }

    [Fact]
    public async Task LoadAsync_RejectsLocalCommandImageArtifact()
    {
        var manifestPath = await WriteLocalCommandManifestAsync("com.example.notes", runtimeArtifact: """, "artifact": "image" """);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == "app_runtime_artifact_unsupported");
    }

    [Fact]
    public async Task LoadAsync_AcceptsBundledCollectorManifest()
    {
        var manifestPath = ResolveRepoFile(Path.Combine("apps", "collector", "manifest.json"));

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        Assert.Equal(CollectorBootstrap.AppId, selection.Manifest.Id);
        var ports = selection.Services.Single().Runtime.Ports;
        Assert.Contains(ports, port => port.Key == "otlp-http" && port.ContainerPort == 4318 && string.Equals(port.Expose, "host", StringComparison.OrdinalIgnoreCase));
        Assert.Contains(ports, port => port.Key == "metrics" && port.ContainerPort == 9464);
        Assert.Equal("/etc/otelcol-contrib", selection.DataTarget?.ContainerPath);
    }

    private static string ResolveRepoFile(string relativePath)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine(directory.FullName, relativePath);
            if (File.Exists(candidate))
            {
                return candidate;
            }

            directory = directory.Parent;
        }

        throw new FileNotFoundException($"Could not locate '{relativePath}' walking up from {AppContext.BaseDirectory}.");
    }

    private static async Task<string> WriteManifestAsync(string appId, string? externalMounts = null, string? ports = null, string? runtimeNetwork = null, string? dependencies = null, string? runtimeArtifact = null, string? restartPolicy = null, string? healthcheck = null, string? telemetry = null)
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
                    "image": "ghcr.io/example/notes:1.0.0"{{runtimeArtifact ?? ""}}{{runtimeNetwork ?? ""}}{{ports ?? ""}}{{healthcheck ?? ""}}
                  }
                }
              }]{{externalMounts ?? ""}}{{dependencies ?? ""}}{{restartPolicy ?? ""}}{{telemetry ?? ""}}
            }
            """);
        return path;
    }

    private static async Task<string> WriteLocalCommandManifestAsync(string appId, string? runtimeArtifact = null)
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
              "runtimeProfiles": [{ "key": "dev", "type": "localCommand", "default": true }],
              "services": [{
                "key": "app",
                "runtimes": {
                  "dev": {
                    "type": "localCommand",
                    "command": "npm run dev"{{runtimeArtifact ?? ""}}
                  }
                }
              }]
            }
            """);
        return path;
    }
}
