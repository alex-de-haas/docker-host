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
    public async Task LoadAsync_AcceptsSystemRole()
    {
        var manifestPath = await WriteManifestAsync("hosty.sysapp", role: """, "role": "system" """);

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        Assert.Equal("system", selection.Manifest.Role);
    }

    [Theory]
    [InlineData("runtime")]
    [InlineData("System")]
    [InlineData(" system")]
    [InlineData("")]
    public async Task LoadAsync_RejectsUnsupportedRoles(string role)
    {
        // Fail closed: an unknown role must never install as an ordinary runtime app.
        var manifestPath = await WriteManifestAsync("com.example.notes", role: $$""", "role": "{{role}}" """);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == "app_manifest_role_unsupported");
    }

    [Fact]
    public async Task LoadAsync_AcceptsProvidesSlots()
    {
        var manifestPath = await WriteManifestAsync("com.example.collector", role: $$""", "provides": ["otlp-collector", "some-future-slot"] """);

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        Assert.Equal(["otlp-collector", "some-future-slot"], selection.Manifest.Provides);
    }

    [Theory]
    [InlineData("""["Otlp-Collector"]""", "app_manifest_provides_invalid")]
    [InlineData("""["otlp collector"]""", "app_manifest_provides_invalid")]
    [InlineData("""[""]""", "app_manifest_provides_invalid")]
    [InlineData("""["otlp-collector", "otlp-collector"]""", "app_manifest_provides_duplicate")]
    public async Task LoadAsync_RejectsInvalidProvides(string providesJson, string expectedCode)
    {
        var manifestPath = await WriteManifestAsync("com.example.collector", role: $$""", "provides": {{providesJson}} """);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == expectedCode);
    }

    [Fact]
    public async Task LoadAsync_AcceptsInterfaces()
    {
        var manifestPath = await WriteManifestAsync("com.example.gateway", role: """, "interfaces": { "ai-gateway": [{ "key": "default", "endpoint": "web", "path": "/api/ai" }], "some-future-interface": [{ "path": "/api/x" }] } """);

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        var declaration = Assert.Single(selection.Manifest.Interfaces["ai-gateway"]);
        Assert.Equal("default", declaration.Key);
        Assert.Equal("web", declaration.Endpoint);
        Assert.Equal("/api/ai", declaration.Path);
        // Unknown interface names are inert and forward-compatible, like provides slots.
        Assert.True(selection.Manifest.Interfaces.ContainsKey("some-future-interface"));
    }

    [Theory]
    [InlineData("""{ "Ai-Gateway": [{ "path": "/api/ai" }] }""", "app_manifest_interface_name_invalid")]
    [InlineData("""{ "ai gateway": [{ "path": "/api/ai" }] }""", "app_manifest_interface_name_invalid")]
    [InlineData("""{ "ai-gateway": [] }""", "app_manifest_interface_empty")]
    [InlineData("""{ "ai-gateway": [{ "key": "Bad Key", "path": "/api/ai" }] }""", "app_manifest_interface_key_invalid")]
    [InlineData("""{ "ai-gateway": [{ "path": "/api/ai" }, { "path": "/api/other" }] }""", "app_manifest_interface_key_duplicate")]
    [InlineData("""{ "ai-gateway": [{ "path": "api/ai" }] }""", "app_manifest_interface_path_invalid")]
    public async Task LoadAsync_RejectsInvalidInterfaces(string interfacesJson, string expectedCode)
    {
        var manifestPath = await WriteManifestAsync("com.example.gateway", role: $$""", "interfaces": {{interfacesJson}} """);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == expectedCode);
    }

    [Fact]
    public async Task LoadAsync_SystemUi_AcceptsExplicitResolvableDeclaration()
    {
        var manifestPath = await WriteSystemUiManifestAsync(
            role: "system",
            ui: """
                , "ui": {
                    "entrypoint": { "endpoint": "web", "path": "/" },
                    "navigation": [
                      { "label": "Storefront", "path": "/" },
                      { "label": "Sources", "path": "/sources" }
                    ]
                  }
                """);

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        Assert.Equal("system", selection.Manifest.Role);
    }

    [Fact]
    public async Task LoadAsync_SystemUi_RequiresExplicitEntrypointEndpoint()
    {
        var manifestPath = await WriteSystemUiManifestAsync(
            role: "system",
            ui: """
                , "ui": { "entrypoint": { "path": "/" } }
                """);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == "app_manifest_system_ui_endpoint_required");
    }

    [Fact]
    public async Task LoadAsync_SystemUi_RejectsUnknownEndpointReferences()
    {
        var manifestPath = await WriteSystemUiManifestAsync(
            role: "system",
            ui: """
                , "ui": { "entrypoint": { "endpoint": "missing", "path": "/" } }
                """);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == "app_manifest_system_ui_endpoint_unknown");
    }

    [Fact]
    public async Task LoadAsync_SystemUi_AcceptsDeclaredSurfaces()
    {
        // The acceptance the refusals below are measured against: a system app may declare both
        // surfaces, and a validator that rejected everything would pass each negative on its own.
        var manifestPath = await WriteSystemUiManifestAsync(
            role: "system",
            ui: """
                , "ui": {
                    "entrypoint": { "endpoint": "web", "path": "/" },
                    "settings": { "endpoint": "web", "path": "/settings" },
                    "panels": [{ "endpoint": "web", "path": "/panel", "label": "Assistant" }]
                  }
                """);

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        Assert.Equal("/settings", selection.Manifest.Ui!.Settings!.Path);
        Assert.Equal("Assistant", selection.Manifest.Ui.Panels[0].Label);
    }

    [Fact]
    public async Task LoadAsync_SystemUi_RejectsSurfaceEndpointThatDoesNotExist()
    {
        var manifestPath = await WriteSystemUiManifestAsync(
            role: "system",
            ui: """
                , "ui": {
                    "entrypoint": { "endpoint": "web", "path": "/" },
                    "settings": { "endpoint": "missing", "path": "/settings" }
                  }
                """);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == "app_manifest_system_ui_endpoint_unknown");
    }

    [Fact]
    public async Task LoadAsync_SystemUi_RejectsASurfaceWithNoEndpointAtAll()
    {
        // A system app's pages are administrator surfaces, so the runtime's endpoint fallback is not
        // allowed here — the same rule the entrypoint already follows.
        var manifestPath = await WriteSystemUiManifestAsync(
            role: "system",
            ui: """
                , "ui": {
                    "entrypoint": { "endpoint": "web", "path": "/" },
                    "panels": [{ "path": "/panel", "label": "Tool" }]
                  }
                """);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == "app_manifest_system_ui_endpoint_required");
    }

    [Fact]
    public async Task LoadAsync_SystemUi_RequiresAPanelLabelButNotASettingsOne()
    {
        // A panel tab sits beside other apps' tabs, so it names itself; a settings tab is named for
        // its app and needs nothing. The pair is the test — one manifest, two surfaces, one error.
        var manifestPath = await WriteSystemUiManifestAsync(
            role: "system",
            ui: """
                , "ui": {
                    "entrypoint": { "endpoint": "web", "path": "/" },
                    "settings": { "endpoint": "web", "path": "/settings" },
                    "panels": [{ "endpoint": "web", "path": "/panel" }]
                  }
                """);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == "app_manifest_system_ui_label_required");
        Assert.DoesNotContain(error.Errors, candidate => candidate.Path == "$.ui.settings.label");
    }

    [Fact]
    public async Task LoadAsync_SystemUi_RejectsUnknownNavigationPortKeyWhenEndpointIsBlank()
    {
        var manifestPath = await WriteSystemUiManifestAsync(
            role: "system",
            ui: """
                , "ui": {
                    "entrypoint": { "endpoint": "web", "path": "/" },
                    "navigation": [
                      { "label": "Page", "path": "/page", "endpoint": "   ", "portKey": "missing" }
                    ]
                  }
                """);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == "app_manifest_system_ui_endpoint_unknown");
    }

    [Fact]
    public async Task LoadAsync_SystemUi_RejectsNonHttpEndpoint()
    {
        var manifestPath = await WriteSystemUiManifestAsync(
            role: "system",
            endpointProtocol: "ws",
            ui: """
                , "ui": { "entrypoint": { "endpoint": "web", "path": "/" } }
                """);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == "app_manifest_system_ui_endpoint_not_http");
    }

    [Fact]
    public async Task LoadAsync_SystemUi_AcceptsMixedCaseHttpEndpointProtocol()
    {
        var manifestPath = await WriteSystemUiManifestAsync(
            role: "system",
            endpointProtocol: "Https",
            ui: """
                , "ui": { "entrypoint": { "endpoint": "web", "path": "/" } }
                """);

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        Assert.Equal("Https", Assert.Single(selection.Manifest.Endpoints).Protocol);
    }

    [Theory]
    [InlineData("sources")]
    [InlineData("/a?x=1")]
    [InlineData("/a#frag")]
    [InlineData("https://evil.example/x")]
    [InlineData("//evil.example/x")]
    [InlineData("/\\\\evil.example/x")]
    public async Task LoadAsync_SystemUi_RejectsUnsafePagePaths(string pagePath)
    {
        var manifestPath = await WriteSystemUiManifestAsync(
            role: "system",
            ui: $$"""
                , "ui": {
                    "entrypoint": { "endpoint": "web", "path": "/" },
                    "navigation": [{ "label": "Page", "path": "{{pagePath}}" }]
                  }
                """);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == "app_manifest_system_ui_path_invalid");
    }

    [Fact]
    public async Task LoadAsync_SystemUi_RejectsDuplicatePagePaths()
    {
        var manifestPath = await WriteSystemUiManifestAsync(
            role: "system",
            ui: """
                , "ui": {
                    "entrypoint": { "endpoint": "web", "path": "/" },
                    "navigation": [
                      { "label": "One", "path": "/x" },
                      { "label": "Two", "path": "/x" }
                    ]
                  }
                """);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == "app_manifest_system_ui_path_duplicate");
    }

    [Fact]
    public async Task LoadAsync_OrdinaryAppUi_KeepsPermissiveBehavior()
    {
        // The same loose declarations that fail closed for role: system stay valid for ordinary
        // apps: runtime fallback and path prefixing remain their compatibility behavior.
        var manifestPath = await WriteSystemUiManifestAsync(
            role: null,
            ui: """
                , "ui": {
                    "entrypoint": { "path": "/" },
                    "navigation": [
                      { "label": "One", "path": "x" },
                      { "label": "Two", "path": "x" }
                    ]
                  }
                """);

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        Assert.Null(selection.Manifest.Role);
    }

    [Fact]
    public async Task LoadAsync_WithoutCatalogMetadata_LeavesBlockNull()
    {
        var manifestPath = await WriteManifestAsync("com.example.notes");

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        // Back-compat: a manifest that declares no catalogMetadata is fully valid and carries none.
        Assert.Null(selection.Manifest.CatalogMetadata);
        Assert.Null(AppCatalogMetadataContract.FromManifest(selection.Manifest.CatalogMetadata));
    }

    [Fact]
    public async Task LoadAsync_ParsesAndNormalizesCatalogMetadata()
    {
        var manifestPath = await WriteManifestAsync(
            "com.example.notes",
            catalogMetadata: """
                , "catalogMetadata": {
                    "publisher": { "name": "Example Co", "url": "https://example.com", "email": "  " },
                    "category": " Productivity ",
                    "tags": ["notes", " sync ", "", "notes"],
                    "icon": "assets/icon.png",
                    "screenshots": ["assets/1.png", "assets/2.png"],
                    "license": "AGPL-3.0-only",
                    "links": { "website": "https://example.com", "docs": "  ", "support": "https://example.com/help" },
                    "summary": "Take notes.",
                    "description": "A longer description.",
                    "changelog": "0.1.0 initial"
                  }
                """);

        var selection = await new AppManifestService().LoadAsync(manifestPath);
        var metadata = AppCatalogMetadataContract.FromManifest(selection.Manifest.CatalogMetadata);

        Assert.NotNull(metadata);
        Assert.Equal("Example Co", metadata!.Publisher!.Name);
        Assert.Equal("https://example.com", metadata.Publisher.Url);
        Assert.Null(metadata.Publisher.Email); // blank collapses to null
        Assert.Equal("Productivity", metadata.Category); // trimmed
        Assert.Equal(new[] { "notes", "sync" }, metadata.Tags); // trimmed, blanks dropped, de-duplicated
        Assert.Equal("assets/icon.png", metadata.Icon);
        Assert.Equal(new[] { "assets/1.png", "assets/2.png" }, metadata.Screenshots);
        Assert.Equal("AGPL-3.0-only", metadata.License);
        Assert.Equal("https://example.com", metadata.Links!.Website);
        Assert.Null(metadata.Links.Docs); // blank collapses to null
        Assert.Equal("https://example.com/help", metadata.Links.Support);
        Assert.Equal("Take notes.", metadata.Summary);
        Assert.Equal("A longer description.", metadata.Description);
        Assert.Equal("0.1.0 initial", metadata.Changelog);
    }

    [Fact]
    public async Task LoadAsync_EmptyCatalogMetadata_CollapsesToNull()
    {
        // An all-blank block carries no information and must never surface as empty noise, nor block install.
        var manifestPath = await WriteManifestAsync(
            "com.example.notes",
            catalogMetadata: """
                , "catalogMetadata": { "category": "   ", "tags": [" "], "publisher": { "name": "" }, "links": {} }
                """);

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        Assert.Null(AppCatalogMetadataContract.FromManifest(selection.Manifest.CatalogMetadata));
    }

    [Fact]
    public void CatalogMetadata_FromManifest_PartialPublisherAndLinksKeepOnlyNonBlank()
    {
        var metadata = AppCatalogMetadataContract.FromManifest(new RuntimeAppCatalogMetadataManifest
        {
            Publisher = new RuntimeAppPublisherManifest { Email = "team@example.com" },
            Links = new RuntimeAppCatalogLinksManifest { Docs = "https://docs.example.com" },
        });

        Assert.NotNull(metadata);
        Assert.NotNull(metadata!.Publisher);
        Assert.Null(metadata.Publisher!.Name);
        Assert.Null(metadata.Publisher.Url);
        Assert.Equal("team@example.com", metadata.Publisher.Email);
        Assert.NotNull(metadata.Links);
        Assert.Equal("https://docs.example.com", metadata.Links!.Docs);
        Assert.Null(metadata.Links.Website);
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
    public async Task LoadAsync_AcceptsSetupUnderLocalCommand()
    {
        var manifestPath = await WriteLocalCommandManifestAsync("com.example.notes", runtimeArtifact: """, "setup": "npm install" """);

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        Assert.Equal("npm install", selection.Services.Single().Runtime.Setup);
    }

    [Fact]
    public async Task LoadAsync_RejectsSetupUnderDocker()
    {
        var manifestPath = await WriteManifestAsync("com.example.notes", runtimeNetwork: """, "setup": "npm install" """);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == "app_manifest_service_setup_requires_local_command");
    }

    [Fact]
    public async Task LoadAsync_AcceptsDevelopmentRuntime()
    {
        var manifestPath = await WriteRawManifestAsync("""
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.notes",
              "name": "Notes",
              "version": "1.0.0",
              "runtimeProfiles": [
                { "key": "docker", "type": "docker", "default": true },
                { "key": "dev", "type": "localCommand", "development": true }
              ],
              "defaultRuntime": "docker",
              "services": [{
                "key": "app",
                "runtimes": {
                  "docker": { "type": "docker", "image": "ghcr.io/example/notes:1.0.0" },
                  "dev": { "type": "localCommand", "command": "npm run dev" }
                }
              }]
            }
            """);

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        var dev = Assert.Single(selection.Manifest.RuntimeProfiles, profile => profile.Key == "dev");
        Assert.True(dev.Development);
        var docker = Assert.Single(selection.Manifest.RuntimeProfiles, profile => profile.Key == "docker");
        Assert.False(docker.Development);
    }

    [Fact]
    public async Task LoadAsync_RejectsDevelopmentUnderDocker()
    {
        var manifestPath = await WriteRawManifestAsync("""
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.notes",
              "name": "Notes",
              "version": "1.0.0",
              "runtimeProfiles": [{ "key": "docker", "type": "docker", "default": true, "development": true }],
              "services": [{
                "key": "app",
                "runtimes": { "docker": { "type": "docker", "image": "ghcr.io/example/notes:1.0.0" } }
              }]
            }
            """);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == "app_manifest_development_requires_local_command");
    }

    [Fact]
    public async Task LoadAsync_AcceptsMultipleDevelopmentRuntimes()
    {
        // development is now only the default for the per-runtime operator Development Mode toggle, so
        // several flagged runtimes are valid (each just defaults to live). See runtime-artifact-model.md.
        var manifestPath = await WriteRawManifestAsync("""
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.notes",
              "name": "Notes",
              "version": "1.0.0",
              "runtimeProfiles": [
                { "key": "dev1", "type": "localCommand", "default": true, "development": true },
                { "key": "dev2", "type": "localCommand", "development": true }
              ],
              "defaultRuntime": "dev1",
              "services": [{
                "key": "app",
                "runtimes": {
                  "dev1": { "type": "localCommand", "command": "npm run dev" },
                  "dev2": { "type": "localCommand", "command": "npm run dev" }
                }
              }]
            }
            """);

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        Assert.Equal(2, selection.Manifest.RuntimeProfiles.Count(profile => profile.Development));
    }

    [Fact]
    public async Task LoadAsync_AcceptsPrebuiltRuntimeWithFolderDelivery()
    {
        var manifestPath = await WriteRawManifestAsync("""
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.notes",
              "name": "Notes",
              "version": "1.0.0",
              "runtimeProfiles": [{ "key": "release", "type": "localCommand", "default": true }],
              "services": [{
                "key": "web",
                "runtimes": {
                  "release": {
                    "type": "localCommand",
                    "artifact": "prebuilt",
                    "delivery": { "type": "folder", "path": "dist" },
                    "command": "node server.js"
                  }
                }
              }]
            }
            """);

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        var service = Assert.Single(selection.Services);
        Assert.Equal("prebuilt", service.Artifact);
        Assert.Equal("folder", service.Runtime.Delivery?.Type);
        Assert.Equal("dist", service.Runtime.Delivery?.Path);
    }

    [Fact]
    public async Task LoadAsync_RejectsPrebuiltUnderDocker()
    {
        var manifestPath = await WriteRawManifestAsync("""
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.notes",
              "name": "Notes",
              "version": "1.0.0",
              "runtimeProfiles": [{ "key": "docker", "type": "docker", "default": true }],
              "services": [{
                "key": "web",
                "runtimes": { "docker": { "type": "docker", "artifact": "prebuilt", "image": "ghcr.io/example/notes:1.0.0" } }
              }]
            }
            """);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => new AppManifestService().LoadAsync(manifestPath));

        Assert.Contains(error.Errors, candidate => candidate.Code == "app_runtime_artifact_unsupported");
    }

    [Theory]
    [InlineData(""""
        "artifact": "prebuilt", "command": "node server.js"
    """", "app_manifest_prebuilt_delivery_required")]
    [InlineData(""""
        "artifact": "prebuilt", "delivery": { "type": "url", "path": "dist" }, "command": "node server.js"
    """", "app_manifest_prebuilt_delivery_type_unsupported")]
    [InlineData(""""
        "artifact": "prebuilt", "delivery": { "type": "folder" }, "command": "node server.js"
    """", "app_manifest_prebuilt_delivery_path_required")]
    [InlineData(""""
        "artifact": "source", "delivery": { "type": "folder", "path": "dist" }, "command": "npm run dev"
    """", "app_manifest_delivery_requires_prebuilt")]
    public async Task LoadAsync_RejectsInvalidDelivery(string runtimeBody, string expectedCode)
    {
        var manifestPath = await WriteRawManifestAsync($$"""
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.notes",
              "name": "Notes",
              "version": "1.0.0",
              "runtimeProfiles": [{ "key": "release", "type": "localCommand", "default": true }],
              "services": [{
                "key": "web",
                "runtimes": { "release": { "type": "localCommand", {{runtimeBody}} } }
              }]
            }
            """);

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
        var manifestPath = ResolveRepoFile(Path.Combine("apps", "telemetry", "manifest.json"));

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        Assert.Equal(CollectorBootstrap.AppId, selection.Manifest.Id);
        var ports = selection.Services.Single(service => service.Key == "collector").Runtime.Ports;
        Assert.Contains(ports, port => port.Key == "otlp-http" && port.ContainerPort == 4318 && string.Equals(port.Expose, "host", StringComparison.OrdinalIgnoreCase));
        Assert.Contains(ports, port => port.Key == "metrics" && port.ContainerPort == 9464);
        // Phase 2: the telemetry backend is a second service exposing the query API Core proxies.
        var backend = selection.Services.Single(service => service.Key == "backend");
        Assert.Contains(backend.Runtime.Ports, port => port.Key == "query" && port.ContainerPort == 8080);
        Assert.Equal("/etc/otelcol-contrib", selection.DataTarget?.ContainerPath);
    }

    [Fact]
    public async Task LoadAsync_SynthesizesDockerCacheTargetDefaults()
    {
        var manifestPath = await WriteRawManifestAsync("""
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.notes",
              "name": "Notes",
              "version": "1.0.0",
              "runtimeProfiles": [{ "key": "docker", "type": "docker", "default": true }],
              "services": [{
                "key": "app",
                "runtimes": { "docker": { "type": "docker", "image": "ghcr.io/example/notes:1.0.0" } }
              }],
              "cache": { "enabled": true }
            }
            """);

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        Assert.Equal("/app/cache", selection.CacheTarget?.ContainerPath);
        Assert.Equal("HOSTY_APP_CACHE_DIR", selection.CacheTarget?.Environment);
        Assert.Equal("app", selection.CacheTarget?.Service);
    }

    [Fact]
    public async Task LoadAsync_SelectsExplicitCacheTarget()
    {
        var manifestPath = await WriteRawManifestAsync("""
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.notes",
              "name": "Notes",
              "version": "1.0.0",
              "runtimeProfiles": [{ "key": "docker", "type": "docker", "default": true }],
              "services": [{
                "key": "app",
                "runtimes": { "docker": { "type": "docker", "image": "ghcr.io/example/notes:1.0.0" } }
              }],
              "cache": {
                "enabled": true,
                "targets": [{
                  "runtime": "docker",
                  "service": "app",
                  "containerPath": "/var/cache/notes",
                  "environment": "NOTES_CACHE_DIR"
                }]
              }
            }
            """);

        var selection = await new AppManifestService().LoadAsync(manifestPath);

        Assert.Equal("/var/cache/notes", selection.CacheTarget?.ContainerPath);
        Assert.Equal("NOTES_CACHE_DIR", selection.CacheTarget?.Environment);
    }

    [Fact]
    public async Task LoadAsync_LeavesCacheTargetNullWhenAbsentDisabledOrLocalCommand()
    {
        // Absent block.
        var absent = await new AppManifestService().LoadAsync(await WriteManifestAsync("com.example.notes"));
        Assert.Null(absent.CacheTarget);

        // Declared but disabled.
        var disabled = await new AppManifestService().LoadAsync(await WriteRawManifestAsync("""
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.notes",
              "name": "Notes",
              "version": "1.0.0",
              "runtimeProfiles": [{ "key": "docker", "type": "docker", "default": true }],
              "services": [{
                "key": "app",
                "runtimes": { "docker": { "type": "docker", "image": "ghcr.io/example/notes:1.0.0" } }
              }],
              "cache": { "enabled": false }
            }
            """));
        Assert.Null(disabled.CacheTarget);

        // Enabled under localCommand with no explicit target: the /app/cache default is
        // docker-only; the local adapter injects the host path from `enabled` alone.
        var local = await new AppManifestService().LoadAsync(await WriteRawManifestAsync("""
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.notes",
              "name": "Notes",
              "version": "1.0.0",
              "runtimeProfiles": [{ "key": "dev", "type": "localCommand", "default": true }],
              "services": [{
                "key": "app",
                "runtimes": { "dev": { "type": "localCommand", "command": "npm run dev" } }
              }],
              "cache": { "enabled": true }
            }
            """));
        Assert.Null(local.CacheTarget);
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

    // Manifest with a declared http port + endpoint for exercising the strict system-app UI
    // validation; role null keeps the same shape as an ordinary runtime app manifest.
    private static async Task<string> WriteSystemUiManifestAsync(string? role, string ui, string endpointProtocol = "http")
    {
        var root = Path.Combine(Path.GetTempPath(), $"hosty-core-manifest-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, "manifest.json");
        await File.WriteAllTextAsync(path, $$"""
            {
              "schemaVersion": "app.0.1",
              "id": "hosty.sysui",
              "name": "System UI App",
              "version": "1.0.0",{{(role is null ? "" : $"\n  \"role\": \"{role}\",")}}
              "runtimeProfiles": [{ "key": "docker", "type": "docker", "default": true }],
              "services": [{
                "key": "app",
                "runtimes": {
                  "docker": {
                    "type": "docker",
                    "image": "ghcr.io/example/sysui:1.0.0",
                    "ports": [{ "key": "http", "containerPort": 8080, "protocol": "http" }]
                  }
                }
              }],
              "endpoints": [
                { "key": "web", "service": "app", "port": "http", "protocol": "{{endpointProtocol}}", "public": true }
              ]{{ui}}
            }
            """);
        return path;
    }

    private static async Task<string> WriteManifestAsync(string appId, string? externalMounts = null, string? ports = null, string? runtimeNetwork = null, string? dependencies = null, string? runtimeArtifact = null, string? restartPolicy = null, string? healthcheck = null, string? telemetry = null, string? catalogMetadata = null, string? role = null)
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
              }]{{externalMounts ?? ""}}{{dependencies ?? ""}}{{restartPolicy ?? ""}}{{telemetry ?? ""}}{{catalogMetadata ?? ""}}{{role ?? ""}}
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

    private static async Task<string> WriteRawManifestAsync(string json)
    {
        var root = Path.Combine(Path.GetTempPath(), $"hosty-core-manifest-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, "manifest.json");
        await File.WriteAllTextAsync(path, json);
        return path;
    }
}
