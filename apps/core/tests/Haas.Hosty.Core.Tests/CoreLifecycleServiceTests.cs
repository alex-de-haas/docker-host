using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class CoreLifecycleServiceTests
{
    [Fact]
    public async Task CreateBackupAsync_KeepsLastFivePreUpdateBackupsAndAllManualBackups()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var dataDir = Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "data");
        Directory.CreateDirectory(dataDir);

        for (var index = 0; index < 2; index++)
        {
            fixture.Clock.UtcNow = fixture.Clock.UtcNow.AddSeconds(1);
            await File.WriteAllTextAsync(Path.Combine(dataDir, "notes.db"), $"manual-{index}");
            _ = await fixture.Backups.CreateBackupAsync("com.example.notes", "manual");
        }

        AppBackupRecord? oldestPreUpdate = null;
        for (var index = 0; index < 6; index++)
        {
            fixture.Clock.UtcNow = fixture.Clock.UtcNow.AddSeconds(1);
            await File.WriteAllTextAsync(Path.Combine(dataDir, "notes.db"), $"pre-update-{index}");
            var backup = await fixture.Backups.CreateBackupAsync("com.example.notes", "pre-update");
            oldestPreUpdate ??= backup;
        }

        var backups = await fixture.Backups.ListBackupsAsync("com.example.notes");

        Assert.Equal(7, backups.Count);
        Assert.Equal(5, backups.Count(backup => backup.Reason == "pre-update"));
        Assert.Equal(2, backups.Count(backup => backup.Reason == "manual"));
        Assert.DoesNotContain(backups, backup => backup.BackupId == oldestPreUpdate!.BackupId);
    }

    [Fact]
    public async Task ApplyUpdateAsync_CreatesPreUpdateBackupAndLeavesAppDataUntouched()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifestV1 = await fixture.WriteManifestAsync("1.0.0");
        var manifestV2 = await fixture.WriteManifestAsync("2.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestV1));
        var dataPath = Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "data", "notes.db");
        await File.WriteAllTextAsync(dataPath, "local-data");

        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(manifestV2));
        var result = await fixture.Service.ApplyUpdateAsync("com.example.notes", new AppUpdateApplyRequest(plan.PlanDigest, manifestV2));

        Assert.Equal("updated", result.Status);
        Assert.Equal("2.0.0", result.App?.Version);
        Assert.Equal("stopped", result.App?.RuntimeState);
        Assert.Equal("local-data", await File.ReadAllTextAsync(dataPath));
        var backup = Assert.Single(await fixture.Backups.ListBackupsAsync("com.example.notes"));
        Assert.Equal("pre-update", backup.Reason);
    }

    [Fact]
    public async Task ApplyRuntimeSwitchAsync_CreatesPreRuntimeSwitchBackupAndPreservesData()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteSwitchableDockerManifestAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var dataPath = Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "data", "notes.db");
        await File.WriteAllTextAsync(dataPath, "local-data");

        var plan = await fixture.Service.CreateRuntimeSwitchPlanAsync(
            "com.example.notes",
            new AppRuntimeSwitchPlanRequest("docker-alt"));
        var result = await fixture.Service.ApplyRuntimeSwitchAsync(
            "com.example.notes",
            new AppRuntimeSwitchApplyRequest("docker-alt", plan.PlanDigest));

        Assert.True(plan.AutomaticBackup);
        Assert.Equal("runtime-switched", result.Status);
        Assert.Equal("docker-alt", result.App?.SelectedRuntime);
        Assert.Equal("stopped", result.App?.RuntimeState);
        Assert.Equal("pre-runtime-switch", result.Backup?.Reason);
        Assert.Equal("local-data", await File.ReadAllTextAsync(dataPath));
        var backup = Assert.Single(await fixture.Backups.ListBackupsAsync("com.example.notes"));
        Assert.Equal("pre-runtime-switch", backup.Reason);
    }

    [Fact]
    public async Task ApplyRuntimeSwitchAsync_RestartsRunningAppAndReturnsBackup()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteSwitchableDockerManifestAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        await File.WriteAllTextAsync(
            Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "data", "notes.db"),
            "local-data");
        await fixture.Service.StartAsync("com.example.notes");

        var plan = await fixture.Service.CreateRuntimeSwitchPlanAsync(
            "com.example.notes",
            new AppRuntimeSwitchPlanRequest("docker-alt"));
        var result = await fixture.Service.ApplyRuntimeSwitchAsync(
            "com.example.notes",
            new AppRuntimeSwitchApplyRequest("docker-alt", plan.PlanDigest));

        Assert.Equal("runtime-switched", result.Status);
        Assert.Equal("running", result.App?.RuntimeState);
        Assert.Equal("docker-alt", result.App?.SelectedRuntime);
        Assert.Equal("pre-runtime-switch", result.Backup?.Reason);
        Assert.Equal(2, fixture.Adapter.StartCount);
        Assert.Equal(1, fixture.Adapter.StopCount);
    }

    [Fact]
    public async Task CreateRuntimeSwitchPlanAsync_RejectsTargetRuntimeWithoutCompatibleDataTarget()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteDataIncompatibleLocalSwitchManifestAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        await File.WriteAllTextAsync(
            Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "data", "notes.db"),
            "local-data");

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.CreateRuntimeSwitchPlanAsync(
                "com.example.notes",
                new AppRuntimeSwitchPlanRequest("dev")));

        Assert.Equal("runtime_switch_data_incompatible", error.Code);
    }

    [Fact]
    public async Task StartAsync_UsesRuntimeAdapterAndStoresRuntimeEndpoint()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var result = await fixture.Service.StartAsync("com.example.notes");
        var app = await fixture.Apps.GetAppAsync("com.example.notes");

        Assert.Equal("running", result.App?.RuntimeState);
        Assert.Equal(1, fixture.Adapter.StartCount);
        Assert.Contains(app!.Endpoints, endpoint =>
            endpoint.Key == "app.http" &&
            endpoint.Url == "http://127.0.0.1:3100");
    }

    [Fact]
    public async Task StartAsync_ResolvesDependencyUrlsForRuntimeAdapter()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Apps.UpsertAppAsync(CreateDependencyApp());
        var manifest = await fixture.WriteManifestAsync("1.0.0", includeDependency: true);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        _ = await fixture.Service.StartAsync("com.example.notes");

        Assert.NotNull(fixture.Adapter.LastContext);
        Assert.Equal(
            "http://127.0.0.1:6379",
            fixture.Adapter.LastContext!.DependencyUrls["com.example.cache"]);
    }


    [Fact]
    public async Task RestoreBackupAsync_RequiresStoppedRuntimeApp()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        await File.WriteAllTextAsync(Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "data", "notes.db"), "before");
        var backup = await fixture.Backups.CreateBackupAsync("com.example.notes", "manual");
        await fixture.Service.StartAsync("com.example.notes");

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.RestoreBackupAsync("com.example.notes", backup!.BackupId, new AppRestoreBackupRequest()));

        Assert.Equal("app_must_be_stopped", error.Code);
    }

    [Fact]
    public async Task RemoveAsync_HonorsSeparateDataBackupAndSourceOptions()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var dataPath = Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "data", "notes.db");
        await File.WriteAllTextAsync(dataPath, "local-data");
        var sourcePath = Path.Combine(fixture.Paths.SourcesRoot, "com.example.notes");
        Directory.CreateDirectory(sourcePath);
        await File.WriteAllTextAsync(Path.Combine(sourcePath, "README.md"), "source");
        _ = await fixture.Backups.CreateBackupAsync("com.example.notes", "manual");

        await fixture.Service.RemoveAsync("com.example.notes", new AppRemoveRequest(
            DeleteRuntimeState: true,
            DeleteData: false,
            DeleteBackups: false,
            DeleteSource: true));

        Assert.False(File.Exists(Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "state.json")));
        Assert.True(File.Exists(dataPath));
        Assert.True((await fixture.Backups.ListBackupsAsync("com.example.notes")).Count > 0);
        Assert.False(Directory.Exists(sourcePath));
    }

    [Fact]
    public async Task AppManifestService_RejectsDockerRuntimeWithoutImage()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifestPath = Path.Combine(fixture.Root, "bad-manifest.json");
        await File.WriteAllTextAsync(manifestPath, """
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.notes",
              "name": "Notes",
              "version": "1.0.0",
              "runtimeProfiles": [{ "key": "docker", "type": "docker", "default": true }],
              "services": [{
                "key": "app",
                "runtimes": {
                  "docker": { "type": "docker" }
                }
              }]
            }
            """);

        var error = await Assert.ThrowsAsync<AppManifestException>(() => fixture.Manifests.LoadAsync(manifestPath));

        Assert.Equal("manifest_validation_failed", error.Code);
        Assert.Contains(error.Errors, item => item.Code == "app_manifest_runtime_image_required");
    }

    [Fact]
    public async Task ResolveManagedAsync_RejectsSourceLessDockerApps()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Sources.ResolveManagedAsync("com.example.notes", new AppSourceResolveRequest()));

        Assert.Equal("source_not_configured", error.Code);
    }

    [Fact]
    public async Task ResolveManagedAsync_ClonesLocalRepositoryAndStoresImmutableCommit()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var repository = await CreateGitRepositoryAsync(fixture.Root);
        var expectedCommit = await RunGitAsync(repository, ["rev-parse", "HEAD"]);
        var manifest = await fixture.WriteManifestAsync("1.0.0", sourceRepository: repository);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var response = await fixture.Sources.ResolveManagedAsync(
            "com.example.notes",
            new AppSourceResolveRequest(Branch: "main"));

        Assert.Equal(expectedCommit, response.Source?.Commit);
        Assert.Equal("main", response.Source?.ResolvedRef);
        Assert.True(Directory.Exists(Path.Combine(fixture.Paths.SourcesRoot, "com.example.notes", ".git")));
    }

    [Fact]
    public async Task SetLocalOverrideAsync_StoresOverrideInInstallState()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var repository = await CreateGitRepositoryAsync(fixture.Root);
        var overridePath = Path.Combine(fixture.Root, "override");
        Directory.CreateDirectory(overridePath);
        var manifest = await fixture.WriteManifestAsync("1.0.0", sourceRepository: repository);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var response = await fixture.Sources.SetLocalOverrideAsync(
            "com.example.notes",
            new AppSourceOverrideRequest(overridePath, Commit: "abc123"));
        var app = await fixture.Apps.GetAppAsync("com.example.notes");

        Assert.Equal(overridePath, response.Source?.LocalOverridePath);
        Assert.Equal(overridePath, app?.SourceState?.LocalOverridePath);
        Assert.Equal("abc123", app?.SourceState?.Commit);
        Assert.Equal(repository, app?.SourceState?.Repository);
    }

    [Fact]
    public async Task StartAsync_RunsLocalCommandRuntimeFromLocalOverrideWithInjectedEnvironment()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Apps.UpsertAppAsync(CreateDependencyApp());
        var overridePath = Path.Combine(fixture.Root, "local-app");
        Directory.CreateDirectory(overridePath);
        var manifest = await fixture.WriteLocalCommandManifestAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest, SelectedRuntime: "dev"));
        _ = await fixture.Sources.SetLocalOverrideAsync("com.example.local", new AppSourceOverrideRequest(overridePath));

        try
        {
            var start = await fixture.Service.StartAsync("com.example.local");
            var outputPath = Path.Combine(fixture.Paths.AppsRoot, "com.example.local", "data", "local-output.txt");

            Assert.Equal("running", start.App?.RuntimeState);
            Assert.True(File.Exists(outputPath));
            var output = await File.ReadAllTextAsync(outputPath);
            Assert.Contains("local", output);
            Assert.Contains("http://127.0.0.1:6379", output);
        }
        finally
        {
            _ = await fixture.Service.StopAsync("com.example.local");
        }

        var app = await fixture.Apps.GetAppAsync("com.example.local");
        Assert.Equal("stopped", app?.RuntimeState);
    }

    [Fact]
    public async Task StartAsync_LocalCommandFailureStopsPreviouslyStartedServices()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteFailingLocalCommandManifestAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest, SelectedRuntime: "dev"));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.StartAsync("com.example.local-fail"));

        Assert.Equal("local_command_start_failed", error.Code);
        Assert.Null(fixture.LocalProcesses.Get("com.example.local-fail", "first"));
        Assert.Null(fixture.LocalProcesses.Get("com.example.local-fail", "second"));
    }


    private sealed class LifecycleFixture
    {
        private LifecycleFixture(
            string root,
            CoreDataPaths paths,
            AppRegistryStore apps,
            AppBackupService backups,
            AppManifestService manifests,
            AppSourceService sources,
            CoreLifecycleService service,
            RecordingRuntimeAdapter adapter,
            LocalCommandProcessRegistry localProcesses,
            FakeClock clock)
        {
            Root = root;
            Paths = paths;
            Apps = apps;
            Backups = backups;
            Manifests = manifests;
            Sources = sources;
            Service = service;
            Adapter = adapter;
            LocalProcesses = localProcesses;
            Clock = clock;
        }

        public string Root { get; }

        public CoreDataPaths Paths { get; }

        public AppRegistryStore Apps { get; }

        public AppBackupService Backups { get; }

        public AppManifestService Manifests { get; }

        public AppSourceService Sources { get; }

        public CoreLifecycleService Service { get; }

        public RecordingRuntimeAdapter Adapter { get; }

        public LocalCommandProcessRegistry LocalProcesses { get; }

        public FakeClock Clock { get; }

        public static async Task<LifecycleFixture> CreateAsync()
        {
            var root = Path.Combine(Path.GetTempPath(), $"hosty-core-lifecycle-tests-{Guid.NewGuid():N}");
            Directory.CreateDirectory(root);
            await File.WriteAllTextAsync(Path.Combine(root, ".keep"), "test");
            var paths = new CoreDataPaths(
                DataRoot: root,
                CoreRoot: Path.Combine(root, "core"),
                AppsRoot: Path.Combine(root, "apps"),
                BackupsRoot: Path.Combine(root, "backups"),
                SourcesRoot: Path.Combine(root, "sources"),
                AuthRoot: Path.Combine(root, "core", "auth"),
                AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));
            var apps = new AppRegistryStore(paths);
            var clock = new FakeClock(DateTimeOffset.Parse("2026-06-02T12:00:00Z"));
            var backups = new AppBackupService(paths, clock);
            var manifests = new AppManifestService();
            var sources = new AppSourceService(paths, apps, clock);
            var adapter = new RecordingRuntimeAdapter();
            var runtimeConfig = new HostyCoreRuntimeConfig(
                DataRoot: root,
                RunDirectory: Path.Combine(root, "core", "run"),
                ControlDiscoveryPath: Path.Combine(root, "core", "run", "control.json"),
                ListenUrl: "http://127.0.0.1:3001",
                CorePublicOrigin: "http://127.0.0.1:3001",
                ShellPublicOrigin: null,
                RuntimePublicHost: "localhost",
                ShellManifestPath: null,
                ShellBootstrapEnabled: false,
                ShellAutostart: false);
            var localProcesses = new LocalCommandProcessRegistry();
            var localAdapter = new LocalCommandRuntimeAdapter(runtimeConfig, localProcesses);
            var service = new CoreLifecycleService(paths, apps, manifests, backups, [adapter, localAdapter]);
            return new LifecycleFixture(root, paths, apps, backups, manifests, sources, service, adapter, localProcesses, clock);
        }

        public async Task<string> WriteManifestAsync(string version, bool includeDependency = false, string? sourceRepository = null)
        {
            var path = Path.Combine(Root, $"notes-{version}.json");
            var dependencyJson = includeDependency
                ? """
                  "dependencies": [{
                    "id": "com.example.cache",
                    "version": "1",
                    "required": true
                  }],
                """
                : "";
            var sourceJson = sourceRepository is null
                ? ""
                : $$"""
                  "source": {
                    "type": "git",
                    "repository": "{{JsonEscape(sourceRepository)}}",
                    "branch": "main"
                  },
                """;
            await File.WriteAllTextAsync(path, $$"""
                {
                  "schemaVersion": "app.0.1",
                  "id": "com.example.notes",
                  "name": "Notes",
                  "description": "Personal notes.",
                  "version": "{{version}}",
                  {{sourceJson}}
                  "runtimeProfiles": [{ "key": "docker", "type": "docker", "default": true }],
                  "defaultRuntime": "docker",
                  "services": [{
                    "key": "app",
                    "runtimes": {
                      "docker": {
                        "type": "docker",
                        "image": "ghcr.io/example/notes:{{version}}",
                        "ports": [{
                          "key": "http",
                          "containerPort": 3000,
                          "protocol": "http",
                          "public": true
                        }]
                      }
                    }
                  }],
                  "endpoints": [{
                    "key": "app.http",
                    "service": "app",
                    "port": "http",
                    "protocol": "http",
                    "public": true
                  }],
                  "settings": [{
                    "key": "APP_MODE",
                    "type": "string",
                    "default": "production"
                  }],
                  {{dependencyJson}}
                  "data": {
                    "enabled": true,
                    "targets": [{
                      "runtime": "docker",
                      "service": "app",
                      "containerPath": "/app/data",
                      "environment": "HOSTY_APP_DATA_DIR"
                    }]
                  }
                }
                """);
            return path;
        }

        public async Task<string> WriteSwitchableDockerManifestAsync()
        {
            var path = Path.Combine(Root, "notes-switchable.json");
            await File.WriteAllTextAsync(path, """
                {
                  "schemaVersion": "app.0.1",
                  "id": "com.example.notes",
                  "name": "Notes",
                  "description": "Personal notes.",
                  "version": "1.0.0",
                  "runtimeProfiles": [
                    { "key": "docker", "type": "docker", "default": true },
                    { "key": "docker-alt", "type": "docker" }
                  ],
                  "defaultRuntime": "docker",
                  "services": [{
                    "key": "app",
                    "runtimes": {
                      "docker": {
                        "type": "docker",
                        "image": "ghcr.io/example/notes:1.0.0",
                        "ports": [{
                          "key": "http",
                          "containerPort": 3000,
                          "protocol": "http",
                          "public": true
                        }]
                      },
                      "docker-alt": {
                        "type": "docker",
                        "image": "ghcr.io/example/notes:1.0.1",
                        "ports": [{
                          "key": "http",
                          "containerPort": 3000,
                          "protocol": "http",
                          "public": true
                        }]
                      }
                    }
                  }],
                  "endpoints": [{
                    "key": "app.http",
                    "service": "app",
                    "port": "http",
                    "protocol": "http",
                    "public": true
                  }],
                  "data": {
                    "enabled": true,
                    "targets": [
                      {
                        "runtime": "docker",
                        "service": "app",
                        "containerPath": "/app/data",
                        "environment": "HOSTY_APP_DATA_DIR"
                      },
                      {
                        "runtime": "docker-alt",
                        "service": "app",
                        "containerPath": "/app/data",
                        "environment": "HOSTY_APP_DATA_DIR"
                      }
                    ]
                  }
                }
                """);
            return path;
        }

        public async Task<string> WriteDataIncompatibleLocalSwitchManifestAsync()
        {
            var path = Path.Combine(Root, "notes-data-incompatible.json");
            await File.WriteAllTextAsync(path, """
                {
                  "schemaVersion": "app.0.1",
                  "id": "com.example.notes",
                  "name": "Notes",
                  "description": "Personal notes.",
                  "version": "1.0.0",
                  "runtimeProfiles": [
                    { "key": "docker", "type": "docker", "default": true },
                    { "key": "dev", "type": "localCommand" }
                  ],
                  "defaultRuntime": "docker",
                  "services": [{
                    "key": "app",
                    "runtimes": {
                      "docker": {
                        "type": "docker",
                        "image": "ghcr.io/example/notes:1.0.0",
                        "ports": [{
                          "key": "http",
                          "containerPort": 3000,
                          "protocol": "http",
                          "public": true
                        }]
                      },
                      "dev": {
                        "type": "localCommand",
                        "command": "sleep 5",
                        "workingDirectory": ".",
                        "ports": [{
                          "key": "http",
                          "containerPort": 3000,
                          "protocol": "http",
                          "public": true
                        }]
                      }
                    }
                  }],
                  "data": {
                    "enabled": true,
                    "targets": [{
                      "runtime": "docker",
                      "service": "app",
                      "containerPath": "/app/data",
                      "environment": "HOSTY_APP_DATA_DIR"
                    }]
                  }
                }
                """);
            return path;
        }

        public async Task<string> WriteLocalCommandManifestAsync()
        {
            var path = Path.Combine(Root, "local-command.json");
            await File.WriteAllTextAsync(path, """
                {
                  "schemaVersion": "app.0.1",
                  "id": "com.example.local",
                  "name": "Local App",
                  "version": "1.0.0",
                  "runtimeProfiles": [{ "key": "dev", "type": "localCommand", "default": true }],
                  "defaultRuntime": "dev",
                  "services": [{
                    "key": "app",
                    "runtimes": {
                      "dev": {
                        "type": "localCommand",
                        "command": "printf \"$APP_MODE|$HOSTY_APP_DATA_DIR|$HOSTY_DEPENDENCY_COM_EXAMPLE_CACHE_URL\" > \"$HOSTY_APP_DATA_DIR/local-output.txt\"; sleep 5",
                        "workingDirectory": ".",
                        "ports": [{
                          "key": "http",
                          "containerPort": 5173,
                          "protocol": "http",
                          "public": true
                        }]
                      }
                    }
                  }],
                  "settings": [{
                    "key": "APP_MODE",
                    "type": "string",
                    "default": "local"
                  }],
                  "dependencies": [{
                    "id": "com.example.cache",
                    "version": "1",
                    "required": true
                  }],
                  "data": {
                    "enabled": true,
                    "targets": [{
                      "runtime": "dev",
                      "environment": "HOSTY_APP_DATA_DIR"
                    }]
                  }
                }
                """);
            return path;
        }

        public async Task<string> WriteFailingLocalCommandManifestAsync()
        {
            var path = Path.Combine(Root, "local-command-fail.json");
            await File.WriteAllTextAsync(path, """
                {
                  "schemaVersion": "app.0.1",
                  "id": "com.example.local-fail",
                  "name": "Failing Local App",
                  "version": "1.0.0",
                  "runtimeProfiles": [{ "key": "dev", "type": "localCommand", "default": true }],
                  "defaultRuntime": "dev",
                  "services": [
                    {
                      "key": "first",
                      "runtimes": {
                        "dev": {
                          "type": "localCommand",
                          "command": "sleep 5",
                          "workingDirectory": "."
                        }
                      }
                    },
                    {
                      "key": "second",
                      "runtimes": {
                        "dev": {
                          "type": "localCommand",
                          "command": "exit 9",
                          "workingDirectory": "."
                        }
                      }
                    }
                  ]
                }
                """);
            return path;
        }
    }

    private sealed class RecordingRuntimeAdapter : IAppRuntimeAdapter
    {
        public string Type => "docker";

        public int StartCount { get; private set; }

        public int StopCount { get; private set; }

        public RuntimeLifecycleContext? LastContext { get; private set; }

        public Task<AppRuntimeStartResult> StartAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
        {
            StartCount++;
            LastContext = context;
            return Task.FromResult(new AppRuntimeStartResult("running", [
                new AppEndpointContract("app.http", "http", "http://127.0.0.1:3100", Public: true),
            ]));
        }

        public Task<AppRuntimeOperationResult> StopAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
        {
            StopCount++;
            return Task.FromResult(new AppRuntimeOperationResult("stopped"));
        }

        public Task<AppRuntimeOperationResult> RemoveAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
            => Task.FromResult(new AppRuntimeOperationResult("removed"));

        public Task<AppRuntimeLogsResult> GetLogsAsync(RuntimeLifecycleContext context, int tail, CancellationToken cancellationToken = default)
            => Task.FromResult(new AppRuntimeLogsResult("log line"));
    }

    private sealed class FakeClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow { get; set; } = now;
    }

    private static AppRecord CreateDependencyApp()
        => new(
            Id: "com.example.cache",
            DisplayName: "Cache",
            Description: null,
            Version: "1.0.0",
            Kind: "runtime",
            System: false,
            Source: "manifest",
            ManifestPath: null,
            ManifestUrl: null,
            SelectedChannel: null,
            SelectedRuntime: "docker",
            OperationStatus: "started",
            RuntimeState: "running",
            LastOperation: "start",
            LastError: null,
            Capabilities: [],
            Settings: new Dictionary<string, AppSettingValue>(),
            StorageMappings: [],
            Dependencies: [],
            Endpoints: [new AppEndpointContract("default", "tcp", "http://127.0.0.1:6379", Public: false)],
            InstalledAt: DateTimeOffset.UtcNow,
            UpdatedAt: DateTimeOffset.UtcNow);

    private static string JsonEscape(string value)
        => value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal);

    private static async Task<string> CreateGitRepositoryAsync(string root)
    {
        var repository = Path.Combine(root, "repo");
        Directory.CreateDirectory(repository);
        _ = await RunGitAsync(repository, ["init", "-b", "main"]);
        await File.WriteAllTextAsync(Path.Combine(repository, "README.md"), "source");
        _ = await RunGitAsync(repository, ["add", "README.md"]);
        _ = await RunGitAsync(repository, ["-c", "user.name=Hosty Test", "-c", "user.email=hosty@example.test", "commit", "-m", "Initial commit"]);
        return repository;
    }

    private static async Task<string> RunGitAsync(string workingDirectory, IReadOnlyList<string> args)
    {
        var process = new System.Diagnostics.Process
        {
            StartInfo = new System.Diagnostics.ProcessStartInfo
            {
                FileName = "git",
                WorkingDirectory = workingDirectory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            },
        };
        foreach (var arg in args)
        {
            process.StartInfo.ArgumentList.Add(arg);
        }

        process.Start();
        var stdout = await process.StandardOutput.ReadToEndAsync();
        var stderr = await process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException(stderr);
        }

        return stdout.Trim();
    }
}
