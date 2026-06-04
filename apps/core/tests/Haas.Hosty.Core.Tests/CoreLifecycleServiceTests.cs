using System.Net;
using System.Text;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData("pre-update")]
    [InlineData("pre-restore")]
    [InlineData("pre-runtime-switch")]
    [InlineData("scheduled")]
    public async Task CreateBackupAsync_KeepsLastFiveAutomaticBackupsAndAllManualBackups(string automaticReason)
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

        AppBackupRecord? oldestAutomatic = null;
        for (var index = 0; index < 6; index++)
        {
            fixture.Clock.UtcNow = fixture.Clock.UtcNow.AddSeconds(1);
            await File.WriteAllTextAsync(Path.Combine(dataDir, "notes.db"), $"{automaticReason}-{index}");
            var backup = await fixture.Backups.CreateBackupAsync("com.example.notes", automaticReason);
            oldestAutomatic ??= backup;
        }

        var backups = await fixture.Backups.ListBackupsAsync("com.example.notes");

        Assert.Equal(7, backups.Count);
        Assert.Equal(5, backups.Count(backup => backup.Reason == automaticReason));
        Assert.Equal(2, backups.Count(backup => backup.Reason == "manual"));
        Assert.DoesNotContain(backups, backup => backup.BackupId == oldestAutomatic!.BackupId);
    }

    [Fact]
    public async Task ListBackupsAsync_IncludesRetentionStatus()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var dataDir = Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "data");
        Directory.CreateDirectory(dataDir);
        await File.WriteAllTextAsync(Path.Combine(dataDir, "notes.db"), "manual");
        _ = await fixture.Backups.CreateBackupAsync("com.example.notes", "manual");
        fixture.Clock.UtcNow = fixture.Clock.UtcNow.AddSeconds(1);
        await File.WriteAllTextAsync(Path.Combine(dataDir, "notes.db"), "pre-update");
        _ = await fixture.Backups.CreateBackupAsync("com.example.notes", "pre-update");

        var backups = await fixture.Backups.ListBackupsAsync("com.example.notes");

        Assert.Contains(backups, backup => backup.Reason == "manual" && backup.Retention?.Reason == "manual-kept");
        Assert.Contains(backups, backup => backup.Reason == "pre-update" && backup.Retention?.Reason == "retained-by-policy");
    }

    [Fact]
    public async Task ApplyCleanupAsync_DeletesDigestVerifiedMissingMetadataCandidates()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var backupRoot = Path.Combine(fixture.Paths.BackupsRoot, "com.example.notes");
        Directory.CreateDirectory(backupRoot);
        var firstArchive = Path.Combine(backupRoot, "orphan-one.zip");
        var secondArchive = Path.Combine(backupRoot, "orphan-two.zip");
        await File.WriteAllTextAsync(firstArchive, "one");
        await File.WriteAllTextAsync(secondArchive, "two");

        var plan = await fixture.Backups.CreateCleanupPlanAsync("com.example.notes");
        var result = await fixture.Backups.ApplyCleanupAsync(
            "com.example.notes",
            new AppBackupCleanupApplyRequest(plan.PlanDigest));

        Assert.Equal(2, plan.Candidates.Count);
        Assert.Equal(2, result.Deleted.Count);
        Assert.All(result.Deleted, candidate => Assert.Equal("missing-metadata", candidate.CleanupReason));
        Assert.False(File.Exists(firstArchive));
        Assert.False(File.Exists(secondArchive));
    }

    [Fact]
    public async Task ApplyCleanupAsync_RejectsStalePlanDigest()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var backupRoot = Path.Combine(fixture.Paths.BackupsRoot, "com.example.notes");
        Directory.CreateDirectory(backupRoot);
        var firstArchive = Path.Combine(backupRoot, "orphan-one.zip");
        var secondArchive = Path.Combine(backupRoot, "orphan-two.zip");
        await File.WriteAllTextAsync(firstArchive, "one");
        await File.WriteAllTextAsync(secondArchive, "two");
        var plan = await fixture.Backups.CreateCleanupPlanAsync("com.example.notes");
        await File.WriteAllTextAsync(firstArchive, "changed");

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Backups.ApplyCleanupAsync("com.example.notes", new AppBackupCleanupApplyRequest(plan.PlanDigest)));

        Assert.Equal("backup_cleanup_plan_digest_mismatch", error.Code);
        Assert.True(File.Exists(firstArchive));
        Assert.True(File.Exists(secondArchive));
    }

    [Fact]
    public async Task ApplyScheduledCleanupAsync_RemovesMissingArchiveMetadataButKeepsExplicitOnlyCandidates()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var dataDir = Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "data");
        Directory.CreateDirectory(dataDir);
        await File.WriteAllTextAsync(Path.Combine(dataDir, "notes.db"), "manual");
        var backup = await fixture.Backups.CreateBackupAsync("com.example.notes", "manual");
        File.Delete(backup!.ArchivePath);
        var backupRoot = Path.Combine(fixture.Paths.BackupsRoot, "com.example.notes");
        var orphanArchive = Path.Combine(backupRoot, "orphan.zip");
        await File.WriteAllTextAsync(orphanArchive, "orphan");

        var result = await fixture.Backups.ApplyScheduledCleanupAsync();

        var deleted = Assert.Single(result.Deleted);
        Assert.Equal("missing-archive", deleted.CleanupReason);
        Assert.False(File.Exists(Path.Combine(backupRoot, $"{backup.BackupId}.json")));
        Assert.True(File.Exists(orphanArchive));
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
    public async Task CreateUpdatePlanAsync_UsesStoredManifestUrlForRemoteInstalls()
    {
        const string manifestUrl = "https://apps.example.test/notes/manifest.json";
        var remoteManifestJson = CreateRemoteManifestJson("1.0.0");
        using var httpClient = new HttpClient(new StubHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(remoteManifestJson, Encoding.UTF8, "application/json"),
        }));
        var manifests = new AppManifestService(httpClient);
        var fixture = await LifecycleFixture.CreateAsync(manifests);

        await fixture.Service.InstallAsync(new AppInstallRequest(manifestUrl));
        remoteManifestJson = CreateRemoteManifestJson("2.0.0");

        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest());

        Assert.Equal(manifestUrl, app?.ManifestUrl);
        Assert.Equal(Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "manifest.json"), app?.ManifestPath);
        Assert.Equal("2.0.0", plan.TargetVersion);
        Assert.Equal(manifestUrl, plan.ManifestPath);
    }

    [Fact]
    public async Task CreateInstallPlanAsync_ReturnsRuntimeProfilesAndSelectsManifestDefault()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteSwitchableDockerManifestAsync();

        var defaultPlan = await fixture.Service.CreateInstallPlanAsync(new AppInstallPlanRequest(manifest));
        var alternatePlan = await fixture.Service.CreateInstallPlanAsync(new AppInstallPlanRequest(manifest, SelectedRuntime: "docker-alt"));

        Assert.Equal("docker", defaultPlan.TargetRuntime);
        Assert.Collection(defaultPlan.RuntimeProfiles,
            profile =>
            {
                Assert.Equal("docker", profile.Key);
                Assert.Equal("docker", profile.Type);
                Assert.True(profile.Default);
            },
            profile =>
            {
                Assert.Equal("docker-alt", profile.Key);
                Assert.Equal("docker", profile.Type);
                Assert.False(profile.Default);
            });
        Assert.Equal("docker-alt", alternatePlan.TargetRuntime);
        Assert.Contains(alternatePlan.RuntimeProfiles, profile => profile.Key == "docker" && profile.Default);
    }

    [Theory]
    [InlineData("pre-update")]
    [InlineData("pre-restore")]
    [InlineData("pre-runtime-switch")]
    [InlineData("scheduled")]
    public async Task CreateManualBackupAsync_RejectsReservedLifecycleReasons(string reason)
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.CreateManualBackupAsync("com.example.notes", new AppManualBackupRequest(reason)));

        Assert.Equal("backup_reason_reserved", error.Code);
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
    public async Task CreateRuntimeSwitchPlanAsync_ReportsRuntimeContractChanges()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteSwitchableDockerManifestAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var plan = await fixture.Service.CreateRuntimeSwitchPlanAsync(
            "com.example.notes",
            new AppRuntimeSwitchPlanRequest("docker-alt"));

        Assert.Contains("runtime:docker->docker-alt", plan.Changes);
        Assert.Contains("runtimeType:docker", plan.Changes);
        Assert.Contains("image:app:ghcr.io/example/notes:1.0.0->ghcr.io/example/notes:1.0.1", plan.Changes);
        Assert.Contains("container:app:preserved:hosty-com-example-notes-app", plan.Changes);
        Assert.Contains("data:compatible", plan.Changes);
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
    public async Task ApplyRuntimeSwitchAsync_RollsBackSelectedRuntimeWhenRestartFails()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteSwitchableDockerManifestAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        await File.WriteAllTextAsync(
            Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "data", "notes.db"),
            "local-data");
        await fixture.Service.StartAsync("com.example.notes");
        fixture.Adapter.FailOnStartCount = 2;

        var plan = await fixture.Service.CreateRuntimeSwitchPlanAsync(
            "com.example.notes",
            new AppRuntimeSwitchPlanRequest("docker-alt"));
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.ApplyRuntimeSwitchAsync(
                "com.example.notes",
                new AppRuntimeSwitchApplyRequest("docker-alt", plan.PlanDigest)));
        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        var backup = Assert.Single(await fixture.Backups.ListBackupsAsync("com.example.notes"));

        Assert.Equal("runtime_switch_restart_failed", error.Code);
        Assert.Equal("docker", app?.SelectedRuntime);
        Assert.Equal("stopped", app?.RuntimeState);
        Assert.Equal("runtime-switch-rollback", app?.OperationStatus);
        Assert.Equal("switch-runtime", app?.LastOperation);
        Assert.Contains("Runtime failed to start", app?.LastError);
        Assert.Equal("pre-runtime-switch", backup.Reason);
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
    public async Task InstallAsync_DefaultsAutostartOn()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");

        var result = await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        Assert.True(result.App?.Autostart);
        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.True(app?.Autostart);
    }

    [Fact]
    public async Task InstallAsync_CanDisableAutostart()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");

        var result = await fixture.Service.InstallAsync(new AppInstallRequest(manifest, Autostart: false));

        Assert.False(result.App?.Autostart);
        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.False(app?.Autostart);
    }

    [Fact]
    public async Task StartAutostartAppsAsync_StartsOnlyEnabledApps()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest, Autostart: false));

        var disabledResults = await fixture.Service.StartAutostartAppsAsync();

        Assert.Empty(disabledResults);
        Assert.Equal(0, fixture.Adapter.StartCount);

        await fixture.Service.ConfigureAutostartAsync("com.example.notes", new AppAutostartRequest(true));
        var enabledResults = await fixture.Service.StartAutostartAppsAsync();

        var result = Assert.Single(enabledResults);
        Assert.True(result.Succeeded);
        Assert.Equal("com.example.notes", result.AppId);
        Assert.Equal(1, fixture.Adapter.StartCount);
    }

    [Fact]
    public async Task StopRuntimeAppsAsync_StopsAppsRegardlessOfAutostart()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest, Autostart: false));
        await fixture.Service.StartAsync("com.example.notes");

        var results = await fixture.Service.StopRuntimeAppsAsync();

        var result = Assert.Single(results);
        Assert.True(result.Succeeded);
        Assert.Equal("com.example.notes", result.AppId);
        Assert.Equal(1, fixture.Adapter.StopCount);
        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal("stopped", app?.RuntimeState);
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

    [Theory]
    [InlineData("https://user:token@example.test/acme/app.git", "source_repository_credentials_unsupported")]
    [InlineData("ssh://git@example.test/acme/app.git", "source_repository_scheme_unsupported")]
    [InlineData("git@example.test:acme/app.git", "source_repository_scheme_unsupported")]
    public void ValidateManagedRepository_RejectsCredentialOrSshSources(string repository, string expectedCode)
    {
        var error = Assert.Throws<AppLifecycleException>(() => AppSourceService.ValidateManagedRepository(repository));

        Assert.Equal(expectedCode, error.Code);
    }

    [Theory]
    [InlineData("https://example.test/acme/app.git")]
    [InlineData("http://example.test/acme/app.git")]
    [InlineData("./apps/demo-app")]
    public void ValidateManagedRepository_AllowsPublicReadableAndLocalSources(string repository)
    {
        var error = Record.Exception(() => AppSourceService.ValidateManagedRepository(repository));

        Assert.Null(error);
    }

    [Fact]
    public void CreateGitStartInfo_DisablesInteractiveCredentialPrompts()
    {
        var startInfo = AppSourceService.CreateGitStartInfo("/tmp", ["fetch"]);

        Assert.Equal("0", startInfo.Environment["GIT_TERMINAL_PROMPT"]);
        Assert.Equal("", startInfo.Environment["GIT_ASKPASS"]);
        Assert.Equal("", startInfo.Environment["SSH_ASKPASS"]);
        Assert.Equal("never", startInfo.Environment["GCM_INTERACTIVE"]);
    }

    [Fact]
    public async Task ResolveManagedAsync_RejectsRepositoryWithEmbeddedCredentials()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync(
            "1.0.0",
            sourceRepository: "https://user:token@example.test/acme/notes.git");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Sources.ResolveManagedAsync("com.example.notes", new AppSourceResolveRequest()));

        Assert.Equal("source_repository_credentials_unsupported", error.Code);
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
    public async Task InstallAsync_UsesGitRootAsLocalOverrideForRepositoryRelativeManifest()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var repositoryRoot = Path.Combine(fixture.Root, "repo");
        var appDirectory = Path.Combine(repositoryRoot, "apps", "demo-app");
        Directory.CreateDirectory(Path.Combine(repositoryRoot, ".git"));
        Directory.CreateDirectory(appDirectory);
        var manifestPath = Path.Combine(appDirectory, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, """
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.repo-local",
              "name": "Repo Local App",
              "version": "1.0.0",
              "source": {
                "type": "git",
                "repository": ".",
                "branch": "main"
              },
              "runtimeProfiles": [{ "key": "dev", "type": "localCommand", "default": true }],
              "defaultRuntime": "dev",
              "services": [{
                "key": "app",
                "runtimes": {
                  "dev": {
                    "type": "localCommand",
                    "command": "pwd > \"$HOSTY_APP_DATA_DIR/cwd.txt\"; sleep 5",
                    "workingDirectory": "apps/demo-app"
                  }
                }
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

        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath, SelectedRuntime: "dev"));
        var app = await fixture.Apps.GetAppAsync("com.example.repo-local");

        var localOverridePath = Assert.IsType<string>(app?.SourceState?.LocalOverridePath);
        Assert.True(Directory.Exists(Path.Combine(localOverridePath, ".git")));
        Assert.EndsWith($"{Path.DirectorySeparatorChar}repo", localOverridePath, StringComparison.Ordinal);

        try
        {
            var start = await fixture.Service.StartAsync("com.example.repo-local");
            var cwdPath = Path.Combine(fixture.Paths.AppsRoot, "com.example.repo-local", "data", "cwd.txt");

            Assert.Equal("running", start.App?.RuntimeState);
            Assert.True(File.Exists(cwdPath));
            var serviceWorkingDirectory = (await File.ReadAllTextAsync(cwdPath)).Trim();
            Assert.EndsWith(
                $"{Path.DirectorySeparatorChar}repo{Path.DirectorySeparatorChar}apps{Path.DirectorySeparatorChar}demo-app",
                serviceWorkingDirectory,
                StringComparison.Ordinal);
        }
        finally
        {
            _ = await fixture.Service.StopAsync("com.example.repo-local");
        }
    }

    [Fact]
    public async Task ApplyCleanupAsync_RemovesOnlyAbandonedManagedSourceCheckouts()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var repository = await CreateGitRepositoryAsync(fixture.Root);
        var manifest = await fixture.WriteManifestAsync("1.0.0", sourceRepository: repository);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        _ = await fixture.Sources.ResolveManagedAsync("com.example.notes", new AppSourceResolveRequest(Branch: "main"));
        var managedPath = Path.Combine(fixture.Paths.SourcesRoot, "com.example.notes");
        var orphanPath = Path.Combine(fixture.Paths.SourcesRoot, "com.example.orphan");
        Directory.CreateDirectory(orphanPath);
        await File.WriteAllTextAsync(Path.Combine(orphanPath, "README.md"), "orphan");

        var plan = await fixture.Sources.CreateCleanupPlanAsync();
        var result = await fixture.Sources.ApplyCleanupAsync();

        var candidate = Assert.Single(plan.Candidates);
        Assert.Equal("com.example.orphan", candidate.AppId);
        Assert.Equal("app-not-installed", candidate.Reason);
        var deleted = Assert.Single(result.Deleted);
        Assert.Equal(orphanPath, deleted.Path);
        Assert.True(Directory.Exists(managedPath));
        Assert.False(Directory.Exists(orphanPath));
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
    public async Task GetHealthAsync_ReportsLocalCommandProcessState()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var overridePath = Path.Combine(fixture.Root, "local-app");
        Directory.CreateDirectory(overridePath);
        var manifest = await fixture.WriteLocalCommandManifestAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest, SelectedRuntime: "dev"));
        _ = await fixture.Sources.SetLocalOverrideAsync("com.example.local", new AppSourceOverrideRequest(overridePath));

        try
        {
            _ = await fixture.Service.StartAsync("com.example.local");
            var running = await fixture.Service.GetHealthAsync("com.example.local");

            Assert.Equal("healthy", running.Status);
            var service = Assert.Single(running.Services);
            Assert.Equal("app", service.Service);
            Assert.Equal("running", service.Status);
            Assert.NotNull(service.ProcessId);
            Assert.Equal(overridePath, service.WorkingDirectory);
            Assert.EndsWith(Path.Combine("logs", "app.log"), service.LogPath);
        }
        finally
        {
            _ = await fixture.Service.StopAsync("com.example.local");
        }

        var stopped = await fixture.Service.GetHealthAsync("com.example.local");
        Assert.Equal("stopped", stopped.Status);
        Assert.Equal("stopped", Assert.Single(stopped.Services).Status);
    }

    [Fact]
    public async Task ListAppsAsync_ReconcilesStaleRunningLocalCommandState()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteLocalCommandManifestAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest, SelectedRuntime: "dev"));
        await fixture.Apps.UpdateAppAsync("com.example.local", app => app with
        {
            RuntimeState = "running",
            OperationStatus = "started",
            LastOperation = "start",
        });

        var apps = await fixture.Service.ListAppsAsync();

        var listed = Assert.Single(apps);
        Assert.Equal("stopped", listed.RuntimeState);
        var stored = await fixture.Apps.GetAppAsync("com.example.local");
        Assert.Equal("stopped", stored?.RuntimeState);
        Assert.Equal("started", stored?.OperationStatus);
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

    private static string CreateRemoteManifestJson(string version)
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

        public static async Task<LifecycleFixture> CreateAsync(AppManifestService? manifests = null)
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
            manifests ??= new AppManifestService();
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
            var appServiceTokens = new AppServiceTokenService(new ControlSecret("test-control-secret"));
            var localAdapter = new LocalCommandRuntimeAdapter(runtimeConfig, localProcesses, appServiceTokens);
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

        public int? FailOnStartCount { get; set; }

        public RuntimeLifecycleContext? LastContext { get; private set; }

        public Task<AppRuntimeStartResult> StartAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
        {
            StartCount++;
            LastContext = context;
            if (FailOnStartCount == StartCount)
            {
                throw new AppLifecycleException("runtime_start_failed", "Runtime failed to start.");
            }

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

        public Task<AppRuntimeHealthResult> GetHealthAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
            => Task.FromResult(new AppRuntimeHealthResult("unknown", []));
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
