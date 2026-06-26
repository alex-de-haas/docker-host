using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
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
    public async Task CreateBackupAsync_AppInitiated_KeepsLastFiveAndPersistsNote()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var dataDir = Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "data");
        Directory.CreateDirectory(dataDir);

        AppBackupRecord? oldest = null;
        for (var index = 0; index < 7; index++)
        {
            fixture.Clock.UtcNow = fixture.Clock.UtcNow.AddSeconds(1);
            await File.WriteAllTextAsync(Path.Combine(dataDir, "notes.db"), $"app-{index}");
            var backup = await fixture.Backups.CreateBackupAsync(
                "com.example.notes",
                AppBackupService.AppInitiatedReason,
                note: $"pre-migration-{index}");
            oldest ??= backup;
        }

        var backups = await fixture.Backups.ListBackupsAsync("com.example.notes");
        var appInitiated = backups
            .Where(backup => backup.Reason == AppBackupService.AppInitiatedReason)
            .ToArray();

        // Unlike "manual", app-initiated backups are retention-managed so an app that requests
        // one on every startup cannot accumulate archives without bound.
        Assert.Equal(5, appInitiated.Length);
        Assert.DoesNotContain(backups, backup => backup.BackupId == oldest!.BackupId);
        // The descriptive note round-trips through the persisted metadata.
        Assert.All(appInitiated, backup => Assert.StartsWith("pre-migration-", backup.Note!));
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
    public async Task CreateBackupAsync_RecordsArchiveSizeAndSha256()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var dataDir = Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "data");
        Directory.CreateDirectory(dataDir);
        await File.WriteAllTextAsync(Path.Combine(dataDir, "notes.db"), "manual");

        var backup = await fixture.Backups.CreateBackupAsync("com.example.notes", "manual");

        Assert.NotNull(backup);
        var archiveBytes = await File.ReadAllBytesAsync(backup.ArchivePath);
        Assert.Equal(new FileInfo(backup.ArchivePath).Length, backup.ArchiveSize);
        Assert.Equal(Convert.ToHexString(SHA256.HashData(archiveBytes)).ToLowerInvariant(), backup.ArchiveSha256);
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
    public async Task GetLogsAsync_ReturnsPerServiceSegmentsAlongsideCombinedText()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var response = await fixture.Service.GetLogsAsync("com.example.notes", 200);

        var segment = Assert.Single(response.Services);
        Assert.Equal("app", segment.Service);
        Assert.Equal("app log line", segment.Text);
        Assert.Contains("== app ==", response.Text, StringComparison.Ordinal);
        Assert.Contains("app log line", response.Text, StringComparison.Ordinal);
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
    public async Task CreateUpdatePlanAsync_ReturnsNoChangesForInstalledManifestRecheck()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest());

        Assert.Empty(plan.Changes);
    }

    [Fact]
    public async Task CreateUpdatePlanAsync_ReportsManifestFallbackOnlyForUnclassifiedDigestChange()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var targetManifest = Path.Combine(fixture.Root, "notes-description-only.json");
        var json = await File.ReadAllTextAsync(manifest);
        await File.WriteAllTextAsync(targetManifest, json.Replace("Personal notes.", "Personal notes with updated copy.", StringComparison.Ordinal));

        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(targetManifest));

        Assert.Equal(["manifest"], plan.Changes);
    }

    [Fact]
    public async Task CreateUpdatePlanAsync_ReportsRuntimeContractChanges()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifestV1 = await fixture.WriteManifestAsync("1.0.0");
        var manifestV2 = await fixture.WriteManifestAsync("1.0.1");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestV1));

        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(manifestV2));

        Assert.Contains("version:1.0.0->1.0.1", plan.Changes);
        Assert.Contains("image:app:ghcr.io/example/notes:1.0.0->ghcr.io/example/notes:1.0.1", plan.Changes);
        Assert.DoesNotContain("manifest", plan.Changes);
    }

    [Fact]
    public async Task CreateUpdatePlanAsync_ReportsNetworkModeToggle()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifestV1 = await fixture.WriteManifestAsync("1.0.0");
        var manifestV2 = await fixture.WriteManifestAsync("1.0.1", networkJson: """ "network": "host", """);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestV1));

        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(manifestV2));

        // Switching to host networking changes how the container launches, so it must be a detected
        // change (which drives a restart) rather than an unclassified "manifest" digest difference.
        Assert.Contains("network:app:bridge->host", plan.Changes);
    }

    [Fact]
    public async Task CreateUpdatePlanAsync_ReportsCapabilityToggle()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifestV1 = await fixture.WriteManifestAsync("1.0.0");
        var manifestV2 = await fixture.WriteManifestAsync("1.0.1", networkJson: """ "capabilities": ["NET_ADMIN"], """);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestV1));

        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(manifestV2));

        // Granting a capability changes the container launch args, so it must drive a restart.
        Assert.Contains("capabilities:app:none->NET_ADMIN", plan.Changes);
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

    [Fact]
    public async Task CreateInstallPlanAsync_CarriesRequiredSettingFlag()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", settingsJson: """
              "settings": [{
                "key": "APP_MODE",
                "type": "string",
                "required": true
              }],
            """);

        var plan = await fixture.Service.CreateInstallPlanAsync(new AppInstallPlanRequest(manifest));
        var install = await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var planSetting = Assert.Single(plan.Settings);
        Assert.True(planSetting.Required);
        var appSetting = Assert.Single(install.App!.Settings, setting => setting.Key == "APP_MODE");
        Assert.True(appSetting.Required);
    }

    [Fact]
    public async Task StartAsync_RefusesWhenRequiredSettingMissing()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", settingsJson: """
              "settings": [{ "key": "APP_MODE", "type": "string", "required": true }],
            """);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.StartAsync("com.example.notes"));

        Assert.Equal("app_required_settings_missing", error.Code);
        Assert.Contains("APP_MODE", error.Message);
        // The runtime is never invoked and the app stays stopped with the failure recorded.
        Assert.Equal(0, fixture.Adapter.StartCount);
        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal("stopped", app!.RuntimeState);
        Assert.Contains("APP_MODE", app.LastError);
    }

    [Fact]
    public async Task StartAsync_SucceedsAfterRequiredSettingConfigured()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", settingsJson: """
              "settings": [{ "key": "APP_MODE", "type": "string", "required": true }],
            """);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        await fixture.Service.ConfigureAsync(
            "com.example.notes",
            new AppConfigureRequest(Settings: new Dictionary<string, string?> { ["APP_MODE"] = "staging" }));

        var result = await fixture.Service.StartAsync("com.example.notes");

        Assert.Equal("running", result.App?.RuntimeState);
        Assert.Equal(1, fixture.Adapter.StartCount);
    }

    [Fact]
    public async Task RemoveAsync_RetainsConfigWhenDataKept_RestoredOnReinstall()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: RequiredCatalogMountsJson);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        await fixture.Service.ConfigureAsync(
            "com.example.notes",
            new AppConfigureRequest(Settings: new Dictionary<string, string?> { ["APP_MODE"] = "staging" }, Autostart: false));
        var host = CreateExternalDirectory();
        await fixture.Service.ConfigureMountsAsync(
            "com.example.notes",
            new AppMountsRequest([new AppMountBindingInput("catalogRoots", "movies", host)]));

        await fixture.Service.RemoveAsync("com.example.notes", new AppRemoveRequest(DeleteData: false));

        var retainedPath = Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "retained-config.json");
        Assert.False(File.Exists(Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "state.json")));
        Assert.True(File.Exists(retainedPath));

        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal("staging", app!.Settings["APP_MODE"].Value);
        Assert.False(app.Autostart);
        var summary = (await fixture.Service.ListAppsAsync()).Single();
        var binding = Assert.Single(summary.Mounts.Single().Bindings);
        Assert.Equal("movies", binding.Label);
        Assert.Equal(Path.GetFullPath(host), binding.HostPath);
        // The snapshot is consumed by the reinstall so it does not linger.
        Assert.False(File.Exists(retainedPath));
    }

    [Fact]
    public async Task RemoveAsync_RetainsClearedSettingOverManifestDefault()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        // APP_MODE defaults to "production" in the manifest; the operator intentionally clears it.
        await fixture.Service.ConfigureAsync(
            "com.example.notes",
            new AppConfigureRequest(Settings: new Dictionary<string, string?> { ["APP_MODE"] = "" }));

        await fixture.Service.RemoveAsync("com.example.notes", new AppRemoveRequest(DeleteData: false));
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        // The cleared value must survive the reinstall rather than reverting to the manifest default.
        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal(string.Empty, app!.Settings["APP_MODE"].Value);
    }

    [Fact]
    public async Task RemoveAsync_DiscardsConfigWhenDataDeleted()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        await fixture.Service.ConfigureAsync(
            "com.example.notes",
            new AppConfigureRequest(Settings: new Dictionary<string, string?> { ["APP_MODE"] = "staging" }));

        await fixture.Service.RemoveAsync("com.example.notes", new AppRemoveRequest(DeleteData: true));
        Assert.False(File.Exists(Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "retained-config.json")));

        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal("production", app!.Settings["APP_MODE"].Value);
    }

    [Fact]
    public async Task CreateUpdatePlanAsync_FolderInstall_DetectsUpdatedManifest()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var folder = Path.Combine(fixture.Root, "folder-app");
        Directory.CreateDirectory(folder);
        var manifestPath = Path.Combine(folder, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, CreateRemoteManifestJson("1.0.0"));
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath));

        // The operator edits the same source folder; an update with no explicit path must re-read it
        // rather than the internal copy Core saved at install.
        await File.WriteAllTextAsync(manifestPath, CreateRemoteManifestJson("2.0.0"));
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest());

        Assert.Equal("1.0.0", plan.CurrentVersion);
        Assert.Equal("2.0.0", plan.TargetVersion);
        Assert.Contains(plan.Changes, change => change.StartsWith("version:", StringComparison.Ordinal));
        Assert.True(plan.SourceConfigured);
    }

    [Fact]
    public async Task InstallAsync_FolderInstall_CapturesOperatorFolderAsInstallManifestPath()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var folder = Path.Combine(fixture.Root, "folder-app");
        Directory.CreateDirectory(folder);
        var manifestPath = Path.Combine(folder, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, CreateRemoteManifestJson("1.0.0"));
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath));

        var app = await fixture.Apps.GetAppAsync("com.example.notes");

        // The operator folder is captured, never Core's internal copy under AppsRoot.
        Assert.Equal(Path.GetFullPath(manifestPath), app?.InstallManifestPath);
        var internalCopy = Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "manifest.json");
        Assert.NotEqual(Path.GetFullPath(internalCopy), app?.InstallManifestPath);
    }

    [Fact]
    public async Task CreateUpdatePlanAsync_ReportsSourceNotConfigured_WhenOnlyInternalCopyAvailable()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var folder = Path.Combine(fixture.Root, "folder-app");
        Directory.CreateDirectory(folder);
        var manifestPath = Path.Combine(folder, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, CreateRemoteManifestJson("1.0.0"));
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath));

        // Simulate a legacy/corrupted record whose source pointer is Core's own internal copy.
        var internalCopy = Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "manifest.json");
        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        await fixture.Apps.UpsertAppAsync(app! with { InstallManifestPath = internalCopy });

        // Operator edits the real folder, but the record no longer points at it.
        await File.WriteAllTextAsync(manifestPath, CreateRemoteManifestJson("2.0.0"));
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest());

        // The internal copy is ignored as a source: Recheck reads its own snapshot, finds no changes,
        // and the plan flags that there is no external source to compare against.
        Assert.False(plan.SourceConfigured);
        Assert.Empty(plan.Changes);
        Assert.Equal("1.0.0", plan.TargetVersion);
    }

    [Fact]
    public async Task CreateUpdatePlanAsync_ReportsSourceNotConfigured_WhenRequestedManifestPathIsInternalCopy()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var folder = Path.Combine(fixture.Root, "folder-app");
        Directory.CreateDirectory(folder);
        var manifestPath = Path.Combine(folder, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, CreateRemoteManifestJson("1.0.0"));
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath));

        // Drop the real source pointer so only the explicitly-passed internal copy path remains.
        var internalCopy = Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "manifest.json");
        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        await fixture.Apps.UpsertAppAsync(app! with { InstallManifestPath = internalCopy });

        // Even an explicit manifest path is not an external source when it points back into the app root.
        var plan = await fixture.Service.CreateUpdatePlanAsync(
            "com.example.notes",
            new AppUpdatePlanRequest(internalCopy));

        Assert.False(plan.SourceConfigured);
    }

    [Theory]
    [InlineData("pre-update")]
    [InlineData("pre-restore")]
    [InlineData("pre-runtime-switch")]
    [InlineData("scheduled")]
    [InlineData("app-initiated")]
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
    public async Task CreateManualBackupAsync_StopsRunningAppForConsistentSnapshotThenRestarts()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        await File.WriteAllTextAsync(
            Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "data", "notes.db"),
            "local-data");
        await fixture.Service.StartAsync("com.example.notes");

        var result = await fixture.Service.CreateManualBackupAsync(
            "com.example.notes",
            new AppManualBackupRequest("manual"));
        var app = await fixture.Apps.GetAppAsync("com.example.notes");

        Assert.Equal("manual", result.Backup?.Reason);
        // App was stopped for the copy and restarted afterwards.
        Assert.Equal("running", app?.RuntimeState);
        Assert.Equal(1, fixture.Adapter.StopCount);
        Assert.Equal(2, fixture.Adapter.StartCount);
    }

    [Fact]
    public async Task CreateManualBackupAsync_DoesNotTouchLifecycleWhenAppAlreadyStopped()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        await File.WriteAllTextAsync(
            Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "data", "notes.db"),
            "local-data");

        var result = await fixture.Service.CreateManualBackupAsync(
            "com.example.notes",
            new AppManualBackupRequest("manual"));
        var app = await fixture.Apps.GetAppAsync("com.example.notes");

        Assert.Equal("manual", result.Backup?.Reason);
        Assert.Equal("stopped", app?.RuntimeState);
        Assert.Equal(0, fixture.Adapter.StopCount);
        Assert.Equal(0, fixture.Adapter.StartCount);
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
    public async Task ListAppsAsync_IncludesRuntimeProfilesFromInstalledManifest()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteSwitchableDockerManifestAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        await fixture.Apps.UpdateAppAsync("com.example.notes", app => app with { RuntimeProfiles = null });

        var app = Assert.Single(await fixture.Service.ListAppsAsync());

        Assert.Equal(["docker", "docker-alt"], app.RuntimeProfiles.Select(profile => profile.Key));
        Assert.Contains(app.RuntimeProfiles, profile => profile.Key == "docker" && profile.Default);
        Assert.Contains(app.RuntimeProfiles, profile => profile.Key == "docker-alt" && profile.Type == "docker");
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
            endpoint.Url == "http://localhost:3100");
    }

    [Fact]
    public async Task StartAsync_PersistsResolvedArtifactLocksAndBackfillsLazily()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var digest = "sha256:" + new string('a', 64);
        fixture.Adapter.StartLocks = new Dictionary<string, ArtifactLock>
        {
            ["app"] = new("image", digest, "ghcr.io/example/notes:1.0.0", null, null, DateTimeOffset.UtcNow),
        };

        await fixture.Service.StartAsync("com.example.notes");
        var app = await fixture.Apps.GetAppAsync("com.example.notes");

        // Lazy backfill: the app had no lock when this start ran (TOFU), and the runtime's resolved
        // lock is persisted onto the record.
        Assert.Null(fixture.Adapter.LastContext!.App.ArtifactLocks);
        Assert.Equal(digest, app!.ArtifactLocks?["app"].ImageDigest);
        Assert.Equal("ghcr.io/example/notes:1.0.0", app.ArtifactLocks?["app"].ResolvedFromRef);
    }

    [Fact]
    public async Task StartAsync_LeavesArtifactLocksUntouchedWhenRuntimeResolvesNone()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var digest = "sha256:" + new string('b', 64);
        await fixture.Apps.UpdateAppAsync("com.example.notes", app => app with
        {
            ArtifactLocks = new Dictionary<string, ArtifactLock>
            {
                ["app"] = new("image", digest, "ghcr.io/example/notes:1.0.0", null, null, DateTimeOffset.UtcNow),
            },
        });
        // A runtime with nothing to pin (source / localCommand) returns no locks.
        fixture.Adapter.StartLocks = null;

        await fixture.Service.StartAsync("com.example.notes");
        var app = await fixture.Apps.GetAppAsync("com.example.notes");

        Assert.Equal(digest, app!.ArtifactLocks?["app"].ImageDigest);
    }

    [Fact]
    public async Task CreateUpdatePlanAsync_SurfacesArtifactDigestChangeForRePushedTag()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var lockedDigest = "sha256:" + new string('c', 64);
        fixture.Adapter.StartLocks = new Dictionary<string, ArtifactLock>
        {
            ["app"] = new("image", lockedDigest, "ghcr.io/example/notes:1.0.0", null, null, DateTimeOffset.UtcNow),
        };
        await fixture.Service.StartAsync("com.example.notes");

        // The registry now resolves the same tag to a different digest (a re-pushed tag), while the
        // manifest JSON is byte-identical.
        var rePushedDigest = "sha256:" + new string('d', 64);
        fixture.Adapter.RemoteDigest = rePushedDigest;

        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest());

        Assert.Contains($"artifact:app:{lockedDigest}->{rePushedDigest}", plan.Changes);
    }

    [Fact]
    public async Task CreateUpdatePlanAsync_MarksArtifactDeltaUnknownWhenRegistryUnreachable()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var lockedDigest = "sha256:" + new string('e', 64);
        fixture.Adapter.StartLocks = new Dictionary<string, ArtifactLock>
        {
            ["app"] = new("image", lockedDigest, "ghcr.io/example/notes:1.0.0", null, null, DateTimeOffset.UtcNow),
        };
        await fixture.Service.StartAsync("com.example.notes");
        // Registry unreachable -> resolver returns null; the plan must not fail and the delta is unknown.
        fixture.Adapter.RemoteDigest = null;

        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest());

        Assert.Contains($"artifact:app:{lockedDigest}->unknown", plan.Changes);
    }

    [Fact]
    public async Task ApplyUpdateAsync_ResetsArtifactLocksSoNextStartReResolves()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifestV1 = await fixture.WriteManifestAsync("1.0.0");
        var manifestV2 = await fixture.WriteManifestAsync("1.0.1");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestV1));
        fixture.Adapter.StartLocks = new Dictionary<string, ArtifactLock>
        {
            ["app"] = new("image", "sha256:" + new string('a', 64), "ghcr.io/example/notes:1.0.0", null, null, DateTimeOffset.UtcNow),
        };
        await fixture.Service.StartAsync("com.example.notes");
        await fixture.Service.StopAsync("com.example.notes");
        // Stop the runtime from re-resolving on the apply-triggered restart so we observe the reset.
        fixture.Adapter.StartLocks = null;

        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(manifestV2));
        await fixture.Service.ApplyUpdateAsync("com.example.notes", new AppUpdateApplyRequest(plan.PlanDigest, manifestV2));
        var app = await fixture.Apps.GetAppAsync("com.example.notes");

        // The stale lock is dropped on update so the next start re-resolves the new target digest.
        Assert.Null(app!.ArtifactLocks);
    }

    [Fact]
    public async Task ConfigureAsync_SetsUpdatePolicyAndSurfacesItOnSummary()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var installed = await fixture.Apps.ListAppsAsync();
        Assert.Equal("pinned", Assert.Single(installed).UpdatePolicy);

        var configured = await fixture.Service.ConfigureAsync(
            "com.example.notes",
            new AppConfigureRequest(UpdatePolicy: "rolling"));

        Assert.Equal("rolling", configured.App?.UpdatePolicy);
        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal("rolling", app!.UpdatePolicy);
    }

    [Fact]
    public async Task ConfigureAsync_RejectsInvalidUpdatePolicy()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var exception = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.ConfigureAsync("com.example.notes", new AppConfigureRequest(UpdatePolicy: "always")));

        Assert.Equal("app_update_policy_invalid", exception.Code);
    }

    [Fact]
    public async Task GetUpdateStatusAsync_ReportsUpdateAvailableWhenCandidateDiffersFromLock()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var lockedDigest = "sha256:" + new string('a', 64);
        fixture.Adapter.StartLocks = new Dictionary<string, ArtifactLock>
        {
            ["app"] = new("image", lockedDigest, "ghcr.io/example/notes:1.0.0", null, null, DateTimeOffset.UtcNow),
        };
        await fixture.Service.StartAsync("com.example.notes");

        // The registry now resolves the tracked tag to a newer digest.
        var candidateDigest = "sha256:" + new string('b', 64);
        fixture.Adapter.RemoteDigest = candidateDigest;

        var status = await fixture.Service.GetUpdateStatusAsync("com.example.notes");

        Assert.True(status.UpdateAvailable);
        Assert.Equal("pinned", status.UpdatePolicy);
        var service = Assert.Single(status.Services);
        Assert.Equal("app", service.Service);
        Assert.Equal(lockedDigest, service.LockedDigest);
        Assert.Equal(candidateDigest, service.CandidateDigest);
        Assert.True(service.UpdateAvailable);
        Assert.False(service.Unknown);
    }

    [Fact]
    public async Task GetUpdateStatusAsync_ReportsUpToDateWhenCandidateMatchesLock()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var digest = "sha256:" + new string('c', 64);
        fixture.Adapter.StartLocks = new Dictionary<string, ArtifactLock>
        {
            ["app"] = new("image", digest, "ghcr.io/example/notes:1.0.0", null, null, DateTimeOffset.UtcNow),
        };
        await fixture.Service.StartAsync("com.example.notes");
        // The registry resolves the same digest the app is already locked to.
        fixture.Adapter.RemoteDigest = digest;

        var status = await fixture.Service.GetUpdateStatusAsync("com.example.notes");

        Assert.False(status.UpdateAvailable);
        var service = Assert.Single(status.Services);
        Assert.False(service.UpdateAvailable);
        Assert.False(service.Unknown);
        Assert.Equal(digest, service.CandidateDigest);
    }

    [Fact]
    public async Task GetUpdateStatusAsync_MarksServiceUnknownWhenRegistryUnreachable()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        fixture.Adapter.StartLocks = new Dictionary<string, ArtifactLock>
        {
            ["app"] = new("image", "sha256:" + new string('d', 64), "ghcr.io/example/notes:1.0.0", null, null, DateTimeOffset.UtcNow),
        };
        await fixture.Service.StartAsync("com.example.notes");
        // Registry unreachable -> resolver returns null; status must not fail and the delta is unknown.
        fixture.Adapter.RemoteDigest = null;

        var status = await fixture.Service.GetUpdateStatusAsync("com.example.notes");

        Assert.False(status.UpdateAvailable);
        var service = Assert.Single(status.Services);
        Assert.True(service.Unknown);
        Assert.False(service.UpdateAvailable);
        Assert.Null(service.CandidateDigest);
    }

    [Fact]
    public async Task StartAsync_CloudflaredIngress_PersistsPublicOriginAndWritesTunnelConfig()
    {
        var fixture = await LifecycleFixture.CreateAsync(ingressBaseDomain: "apps.example.test");
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        await fixture.Service.StartAsync("com.example.notes");
        var app = await fixture.Apps.GetAppAsync("com.example.notes");

        // Core derives and persists the public origin so the existing settings -> env path injects it.
        Assert.Equal(
            "https://com-example-notes.apps.example.test",
            app!.Settings["HOSTY_PUBLIC_ORIGIN_APP_HTTP"].Value);

        // The cloudflared tunnel config is rendered from the running apps plus the Core seed.
        var configPath = Path.Combine(fixture.Root, "core", "ingress", "config.yml");
        Assert.True(File.Exists(configPath));
        var yaml = await File.ReadAllTextAsync(configPath);
        Assert.Contains("hostname: core.apps.example.test", yaml);
        Assert.Contains("hostname: com-example-notes.apps.example.test", yaml);
        Assert.Contains("service: http_status:404", yaml);
    }

    [Fact]
    public async Task StartAsync_StopsRuntimeWhenPersistingStartedStateFails()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var statePath = Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "state.json");
        fixture.Adapter.OnStarted = () =>
        {
            File.Delete(statePath);
            Directory.CreateDirectory(statePath);
        };

        var error = await Assert.ThrowsAnyAsync<Exception>(() =>
            fixture.Service.StartAsync("com.example.notes"));

        Assert.True(error is IOException or UnauthorizedAccessException);
        Assert.Equal(1, fixture.Adapter.StartCount);
        Assert.Equal(1, fixture.Adapter.StopCount);
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
            fixture.Adapter.LastContext!.DependencyUrls["cache"]);
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
    public async Task InstallAsync_UsesAbsoluteSourceRepositoryBeforeContainingGitRoot()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var containingRepositoryRoot = Path.Combine(fixture.Root, "container-repo");
        var appDirectory = Path.Combine(containingRepositoryRoot, "apps", "external-app");
        var externalSourceRoot = Path.Combine(fixture.Root, "external-source");
        Directory.CreateDirectory(Path.Combine(containingRepositoryRoot, ".git"));
        Directory.CreateDirectory(appDirectory);
        Directory.CreateDirectory(externalSourceRoot);
        var manifestPath = Path.Combine(appDirectory, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, $$"""
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.external-local",
              "name": "External Local App",
              "version": "1.0.0",
              "source": {
                "type": "git",
                "repository": "{{JsonEscape(externalSourceRoot)}}",
                "branch": "main"
              },
              "runtimeProfiles": [{ "key": "dev", "type": "localCommand", "default": true }],
              "defaultRuntime": "dev",
              "services": [{
                "key": "app",
                "runtimes": {
                  "dev": {
                    "type": "localCommand",
                    "command": "sleep 5",
                    "workingDirectory": "."
                  }
                }
              }]
            }
            """);

        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath, SelectedRuntime: "dev"));

        var app = await fixture.Apps.GetAppAsync("com.example.external-local");
        Assert.Equal(externalSourceRoot, app?.SourceState?.LocalOverridePath);
    }

    [Fact]
    public async Task InstallAsync_PreservesManifestEndpointServiceMetadata()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");

        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        var endpoint = Assert.Single(app?.Endpoints ?? []);
        Assert.Equal("app.http", endpoint.Key);
        Assert.Equal("app", endpoint.Service);
        Assert.Equal("http", endpoint.Port);
        Assert.True(endpoint.Public);
        Assert.Null(endpoint.Url);
    }

    [Fact]
    public async Task CreateInstallPlanAsync_DoesNotAddPublicOriginSettingForPublicEndpoint()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");

        var plan = await fixture.Service.CreateInstallPlanAsync(new AppInstallPlanRequest(manifest));

        Assert.DoesNotContain(plan.Settings, setting =>
            setting.Key.StartsWith("HOSTY_PUBLIC_ORIGIN_", StringComparison.Ordinal));
    }

    [Fact]
    public async Task CreateInstallPlanAsync_FiltersReservedPublicOriginManifestSettings()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", settingsJson: ReservedPublicOriginSettingsJson());

        var plan = await fixture.Service.CreateInstallPlanAsync(new AppInstallPlanRequest(manifest));

        Assert.DoesNotContain(plan.Settings, setting =>
            setting.Key.StartsWith("HOSTY_PUBLIC_ORIGIN_", StringComparison.Ordinal));
        Assert.Contains(plan.Settings, setting => setting.Key == "APP_MODE");
    }

    [Fact]
    public async Task InstallAsync_AddsPublicOriginSettingForConfigure()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");

        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        var setting = Assert.Contains("HOSTY_PUBLIC_ORIGIN_APP_HTTP", app!.Settings);
        Assert.Equal("url", setting.Type);
        Assert.Null(setting.Value);
        Assert.False(setting.Secret);
    }

    [Fact]
    public async Task InstallAsync_DoesNotPreseedPublicOriginFromManifestReservedSetting()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", settingsJson: ReservedPublicOriginSettingsJson());

        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        var setting = Assert.Contains("HOSTY_PUBLIC_ORIGIN_APP_HTTP", app!.Settings);
        Assert.Equal("url", setting.Type);
        Assert.Null(setting.Value);
        Assert.False(setting.Secret);
        Assert.DoesNotContain(app.Settings.Values, setting => setting.Value == "https://attacker.example.com");
    }

    [Fact]
    public async Task InstallAsync_RejectsInvalidPublicOriginSetting()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.InstallAsync(new AppInstallRequest(
                manifest,
                Settings: new Dictionary<string, string?>
                {
                    ["HOSTY_PUBLIC_ORIGIN_HTTP"] = "https://notes.example.com/app",
                })));

        Assert.Equal("public_origin_invalid", error.Code);
    }

    [Fact]
    public async Task ConfigureAsync_AllowsNullSettings()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        await fixture.Service.ConfigureAsync("com.example.notes", new AppConfigureRequest(null, Autostart: false));

        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.False(app!.Autostart.GetValueOrDefault());
        Assert.Equal("configured", app.OperationStatus);
    }

    [Fact]
    public async Task InstallAsync_StripsDotSegmentFromWorkingDirectoryWhenInferringLocalSourceRoot()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var repositoryRoot = Path.Combine(fixture.Root, "repo-without-git");
        var appDirectory = Path.Combine(repositoryRoot, "apps", "demo-app");
        Directory.CreateDirectory(appDirectory);
        var manifestPath = Path.Combine(appDirectory, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, """
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.dot-working-directory",
              "name": "Dot Working Directory App",
              "version": "1.0.0",
              "runtimeProfiles": [{ "key": "dev", "type": "localCommand", "default": true }],
              "defaultRuntime": "dev",
              "services": [{
                "key": "app",
                "runtimes": {
                  "dev": {
                    "type": "localCommand",
                    "command": "sleep 5",
                    "workingDirectory": "./apps/demo-app"
                  }
                }
              }]
            }
            """);

        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath, SelectedRuntime: "dev"));

        var app = await fixture.Apps.GetAppAsync("com.example.dot-working-directory");
        Assert.Equal(repositoryRoot, app?.SourceState?.LocalOverridePath);
    }

    [Fact]
    public async Task StartAsync_ClonesRemoteManifestSourceForLocalCommandRuntime()
    {
        const string manifestUrl = "https://apps.example.test/remote-local/manifest.json";
        string? repository = null;
        var manifests = new AppManifestService(new HttpClient(new StubHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(CreateRemoteLocalCommandManifestJson(repository!), Encoding.UTF8, "application/json"),
        })), allowRemoteLocalCommand: true);
        var fixture = await LifecycleFixture.CreateAsync(manifests);
        repository = await CreateLocalCommandGitRepositoryAsync(fixture.Root);

        await fixture.Service.InstallAsync(new AppInstallRequest(manifestUrl, SelectedRuntime: "dev"));

        try
        {
            var start = await fixture.Service.StartAsync("com.example.remote-local");
            var app = await fixture.Apps.GetAppAsync("com.example.remote-local");
            var managedCheckoutPath = Path.Combine(fixture.Paths.SourcesRoot, "com.example.remote-local");
            var cwdPath = Path.Combine(fixture.Paths.AppsRoot, "com.example.remote-local", "data", "cwd.txt");

            Assert.Equal("running", start.App?.RuntimeState);
            Assert.Equal(manifestUrl, app?.ManifestUrl);
            Assert.Equal(repository, app?.SourceState?.Repository);
            Assert.Null(app?.SourceState?.LocalOverridePath);
            Assert.True(Directory.Exists(Path.Combine(managedCheckoutPath, ".git")));
            Assert.True(File.Exists(cwdPath));
            var serviceWorkingDirectory = (await File.ReadAllTextAsync(cwdPath)).Trim();
            Assert.EndsWith(
                $"{Path.DirectorySeparatorChar}sources{Path.DirectorySeparatorChar}com.example.remote-local{Path.DirectorySeparatorChar}apps{Path.DirectorySeparatorChar}remote-app",
                serviceWorkingDirectory,
                StringComparison.Ordinal);
        }
        finally
        {
            _ = await fixture.Service.StopAsync("com.example.remote-local");
        }
    }

    [Fact]
    public async Task StartAsync_RejectsRemoteManifestRelativeSourceForLocalCommandRuntime()
    {
        const string manifestUrl = "https://apps.example.test/remote-local/manifest.json";
        var manifests = new AppManifestService(new HttpClient(new StubHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(CreateRemoteLocalCommandManifestJson("."), Encoding.UTF8, "application/json"),
        })), allowRemoteLocalCommand: true);
        var fixture = await LifecycleFixture.CreateAsync(manifests);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestUrl, SelectedRuntime: "dev"));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.StartAsync("com.example.remote-local"));

        Assert.Equal("source_repository_relative_remote_unsupported", error.Code);
    }

    [Fact]
    public async Task InstallAsync_BlocksRemoteManifestLocalCommandRuntimeByDefault()
    {
        const string manifestUrl = "https://apps.example.test/remote-local/manifest.json";
        var manifests = new AppManifestService(new HttpClient(new StubHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(CreateRemoteLocalCommandManifestJson("."), Encoding.UTF8, "application/json"),
        })));
        var fixture = await LifecycleFixture.CreateAsync(manifests);

        var error = await Assert.ThrowsAsync<AppManifestException>(() =>
            fixture.Service.InstallAsync(new AppInstallRequest(manifestUrl, SelectedRuntime: "dev")));

        Assert.Contains(error.Errors, candidate => candidate.Code == "app_manifest_remote_local_command_blocked");
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
            var parts = output.Split('|');
            Assert.Equal(parts[3], parts[4]);
            Assert.Matches("^[0-9]+$", parts[3]);
            Assert.NotNull(start.App);
            var endpoint = Assert.Single(start.App.Endpoints);
            Assert.Equal("app.http", endpoint.Key);
            Assert.Equal("app", endpoint.Service);
            Assert.Equal("http", endpoint.Port);
            Assert.StartsWith("http://localhost:", endpoint.Url, StringComparison.Ordinal);
        }
        finally
        {
            _ = await fixture.Service.StopAsync("com.example.local");
        }

        var app = await fixture.Apps.GetAppAsync("com.example.local");
        Assert.Equal("stopped", app?.RuntimeState);
    }

    [Fact]
    public async Task StartAsync_LocalCommandUsesHostyPortSettingAsAssignedPort()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Apps.UpsertAppAsync(CreateDependencyApp());
        var overridePath = Path.Combine(fixture.Root, "local-app");
        Directory.CreateDirectory(overridePath);
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        var manifest = await fixture.WriteLocalCommandManifestAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest, SelectedRuntime: "dev"));
        await fixture.Service.ConfigureAsync(
            "com.example.local",
            new AppConfigureRequest(new Dictionary<string, string?>
            {
                ["HOSTY_PORT_HTTP"] = $" {port.ToString(System.Globalization.CultureInfo.InvariantCulture)} ",
            }));
        _ = await fixture.Sources.SetLocalOverrideAsync("com.example.local", new AppSourceOverrideRequest(overridePath));

        try
        {
            var start = await fixture.Service.StartAsync("com.example.local");
            var outputPath = Path.Combine(fixture.Paths.AppsRoot, "com.example.local", "data", "local-output.txt");

            var output = await File.ReadAllTextAsync(outputPath);
            var parts = output.Split('|');
            Assert.Equal(port.ToString(System.Globalization.CultureInfo.InvariantCulture), parts[3]);
            Assert.Equal(parts[3], parts[4]);
            Assert.NotNull(start.App);
            var endpoint = Assert.Single(start.App.Endpoints);
            Assert.Equal($"http://localhost:{port}", endpoint.Url);
        }
        finally
        {
            _ = await fixture.Service.StopAsync("com.example.local");
        }
    }

    [Fact]
    public async Task StartAsync_LocalCommandReusesStoredAutoPortAfterStop()
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
            var first = await fixture.Service.StartAsync("com.example.local");
            var firstUrl = Assert.Single(first.App!.Endpoints).Url;
            _ = await fixture.Service.StopAsync("com.example.local");

            var second = await fixture.Service.StartAsync("com.example.local");
            var secondUrl = Assert.Single(second.App!.Endpoints).Url;

            Assert.Equal(firstUrl, secondUrl);
        }
        finally
        {
            _ = await fixture.Service.StopAsync("com.example.local");
        }
    }

    [Fact]
    public async Task RestartAsync_LocalCommandReusesStoredAutoPort()
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
            var first = await fixture.Service.StartAsync("com.example.local");
            var firstUrl = Assert.Single(first.App!.Endpoints).Url;

            var restarted = await fixture.Service.RestartAsync("com.example.local");
            var restartedUrl = Assert.Single(restarted.App!.Endpoints).Url;

            Assert.Equal(firstUrl, restartedUrl);
        }
        finally
        {
            _ = await fixture.Service.StopAsync("com.example.local");
        }
    }

    [Fact]
    public async Task ApplyUpdateAsync_PreservesStoredAutoPortForMatchingLocalCommandEndpoint()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Apps.UpsertAppAsync(CreateDependencyApp());
        var overridePath = Path.Combine(fixture.Root, "local-app");
        Directory.CreateDirectory(overridePath);
        var manifest = await fixture.WriteLocalCommandManifestAsync(version: "1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest, SelectedRuntime: "dev"));
        _ = await fixture.Sources.SetLocalOverrideAsync("com.example.local", new AppSourceOverrideRequest(overridePath));

        try
        {
            var first = await fixture.Service.StartAsync("com.example.local");
            var firstUrl = Assert.Single(first.App!.Endpoints).Url;
            _ = await fixture.Service.StopAsync("com.example.local");

            var updateManifest = await fixture.WriteLocalCommandManifestAsync(version: "1.0.1");
            var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.local", new AppUpdatePlanRequest(updateManifest));
            _ = await fixture.Service.ApplyUpdateAsync("com.example.local", new AppUpdateApplyRequest(plan.PlanDigest, updateManifest));
            var updated = await fixture.Apps.GetAppAsync("com.example.local");

            Assert.Equal(firstUrl, Assert.Single(updated!.Endpoints).Url);

            var second = await fixture.Service.StartAsync("com.example.local");
            Assert.Equal(firstUrl, Assert.Single(second.App!.Endpoints).Url);
        }
        finally
        {
            _ = await fixture.Service.StopAsync("com.example.local");
        }
    }

    [Fact]
    public async Task StartAsync_PreservesManifestEndpointPublicFlagForAliasedRuntimePort()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifestPath = Path.Combine(fixture.Root, "endpoint-public-alias.json");
        await File.WriteAllTextAsync(manifestPath, """
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.endpoint-public",
              "name": "Endpoint Public",
              "version": "1.0.0",
              "runtimeProfiles": [{ "key": "dev", "type": "localCommand", "default": true }],
              "defaultRuntime": "dev",
              "services": [{
                "key": "backend",
                "runtimes": {
                  "dev": {
                    "type": "localCommand",
                    "command": "sleep 5",
                    "workingDirectory": ".",
                    "ports": [{
                      "key": "http",
                      "containerPort": 5173,
                      "protocol": "http"
                    }]
                  }
                }
              }],
              "endpoints": [{
                "key": "api",
                "service": "backend",
                "port": "http",
                "protocol": "http",
                "public": true
              }]
            }
            """);

        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath, SelectedRuntime: "dev"));

        try
        {
            var start = await fixture.Service.StartAsync("com.example.endpoint-public");

            Assert.NotNull(start.App);
            var endpoint = Assert.Single(start.App.Endpoints);
            Assert.Equal("api", endpoint.Key);
            Assert.True(endpoint.Public);
            Assert.StartsWith("http://localhost:", endpoint.Url, StringComparison.Ordinal);
            Assert.Contains("HOSTY_PUBLIC_ORIGIN_API", (await fixture.Apps.GetAppAsync("com.example.endpoint-public"))!.Settings);
        }
        finally
        {
            _ = await fixture.Service.StopAsync("com.example.endpoint-public");
        }
    }

    [Fact]
    public async Task StartAsync_DropsRuntimePortsWithoutDeclaredEndpointSoUpdatePlanConverges()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifestPath = Path.Combine(fixture.Root, "undeclared-port.json");
        await File.WriteAllTextAsync(manifestPath, """
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.undeclared-port",
              "name": "Undeclared Port",
              "version": "1.0.0",
              "runtimeProfiles": [{ "key": "dev", "type": "localCommand", "default": true }],
              "defaultRuntime": "dev",
              "services": [{
                "key": "backend",
                "runtimes": {
                  "dev": {
                    "type": "localCommand",
                    "command": "sleep 5",
                    "workingDirectory": ".",
                    "ports": [
                      { "key": "http", "containerPort": 5173, "protocol": "http" },
                      { "key": "internal", "containerPort": 8080, "protocol": "http" }
                    ]
                  }
                }
              }],
              "endpoints": [{
                "key": "api",
                "service": "backend",
                "port": "http",
                "protocol": "http",
                "public": true
              }]
            }
            """);

        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath, SelectedRuntime: "dev"));

        try
        {
            var start = await fixture.Service.StartAsync("com.example.undeclared-port");

            Assert.NotNull(start.App);
            // Only the declared endpoint is persisted; the undeclared `backend.internal` runtime
            // port is not appended to the record.
            var endpoint = Assert.Single(start.App.Endpoints);
            Assert.Equal("api", endpoint.Key);

            // Re-checking the same manifest must report no changes. The plan target is rebuilt from
            // the manifest (declared endpoints only), so a lingering backend.internal endpoint would
            // surface as a perpetual "removed" change and the update plan would never converge.
            var plan = await fixture.Service.CreateUpdatePlanAsync(
                "com.example.undeclared-port",
                new AppUpdatePlanRequest(manifestPath, SelectedRuntime: "dev"));
            Assert.Empty(plan.Changes);
        }
        finally
        {
            _ = await fixture.Service.StopAsync("com.example.undeclared-port");
        }
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
    public async Task StartAsync_LocalCommandFixedPortInUseRecordsFailure()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var manifest = await fixture.WriteLocalCommandManifestAsync(localPort: port);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest, SelectedRuntime: "dev"));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.StartAsync("com.example.local"));

        Assert.Equal("local_command_port_unavailable", error.Code);
        var stored = await fixture.Apps.GetAppAsync("com.example.local");
        Assert.Equal("stopped", stored?.RuntimeState);
        Assert.Equal("failed", stored?.OperationStatus);
        Assert.Equal("start", stored?.LastOperation);
        Assert.Contains(port.ToString(System.Globalization.CultureInfo.InvariantCulture), stored?.LastError);
    }

    [Fact]
    public async Task StartAsync_LocalCommandRejectsExplicitPortZero()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteLocalCommandManifestAsync(localPort: 0);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest, SelectedRuntime: "dev"));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.StartAsync("com.example.local"));

        Assert.Equal("local_command_port_unavailable", error.Code);
        Assert.Contains("0", error.Message, StringComparison.Ordinal);
        var stored = await fixture.Apps.GetAppAsync("com.example.local");
        Assert.Equal("stopped", stored?.RuntimeState);
        Assert.Equal("failed", stored?.OperationStatus);
    }

    [Fact]
    public async Task StartAsync_LocalCommandPreflightsPortsBeforeStartingServices()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var manifest = await fixture.WriteLocalCommandPortPreflightManifestAsync(port);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest, SelectedRuntime: "dev"));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.StartAsync("com.example.local-preflight"));

        Assert.Equal("local_command_port_unavailable", error.Code);
        Assert.Null(fixture.LocalProcesses.Get("com.example.local-preflight", "first"));
        Assert.Null(fixture.LocalProcesses.Get("com.example.local-preflight", "second"));
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

    [Fact]
    public async Task InstallAsync_DenormalizesExternalMountSlotsAndSurfacesEmptyBindings()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: RequiredCatalogMountsJson);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var summary = (await fixture.Service.ListAppsAsync()).Single();
        var mount = Assert.Single(summary.Mounts);
        Assert.Equal("catalogRoots", mount.Key);
        Assert.Equal("rw", mount.Mode);
        Assert.True(mount.Multiple);
        Assert.True(mount.Required);
        Assert.Empty(mount.Bindings);
    }

    [Fact]
    public async Task ConfigureMountsAsync_PersistsBindingsAndExposesLabelStableContainerPaths()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: RequiredCatalogMountsJson);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var host = CreateExternalDirectory();

        await fixture.Service.ConfigureMountsAsync(
            "com.example.notes",
            new AppMountsRequest([new AppMountBindingInput("catalogRoots", "movies-4k", host)]));

        var summary = (await fixture.Service.ListAppsAsync()).Single();
        var binding = Assert.Single(summary.Mounts.Single().Bindings);
        Assert.Equal("movies-4k", binding.Label);
        Assert.Equal(Path.GetFullPath(host), binding.HostPath);
        Assert.Equal("/mnt/catalogRoots/movies-4k", binding.ContainerPath);
    }

    [Fact]
    public async Task ConfigureMountsAsync_RejectsHostPathInsideDataRoot()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: RequiredCatalogMountsJson);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var inside = Path.Combine(fixture.Paths.DataRoot, "stolen");
        Directory.CreateDirectory(inside);

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.ConfigureMountsAsync(
                "com.example.notes",
                new AppMountsRequest([new AppMountBindingInput("catalogRoots", "inside", inside)])));

        Assert.Equal("app_mount_path_in_data_root", error.Code);
    }

    [Fact]
    public async Task ConfigureMountsAsync_RejectsHostPathWithComma()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: RequiredCatalogMountsJson);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.ConfigureMountsAsync(
                "com.example.notes",
                new AppMountsRequest([new AppMountBindingInput("catalogRoots", "movies", "/srv/with,comma")])));

        Assert.Equal("app_mount_path_invalid", error.Code);
    }

    [Fact]
    public async Task StartAsync_ThrowsWhenConfiguredMountSymlinkRepointsIntoDataRoot()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: RequiredCatalogMountsJson);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var host = CreateExternalDirectory();
        await fixture.Service.ConfigureMountsAsync(
            "com.example.notes",
            new AppMountsRequest([new AppMountBindingInput("catalogRoots", "movies", host)]));

        // Repoint the already-validated host path at the Hosty data root after configuration (TOCTOU).
        var forbidden = Path.Combine(fixture.Paths.DataRoot, "secret");
        Directory.CreateDirectory(forbidden);
        Directory.Delete(host);
        Directory.CreateSymbolicLink(host, forbidden);

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.StartAsync("com.example.notes"));

        Assert.Equal("app_mount_path_in_data_root", error.Code);
    }

    [Theory]
    [InlineData("missing", "movies", "app_mount_slot_unknown")]
    [InlineData("catalogRoots", "Bad Label", "app_mount_label_invalid")]
    public async Task ConfigureMountsAsync_RejectsInvalidBindings(string key, string label, string expectedCode)
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: RequiredCatalogMountsJson);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.ConfigureMountsAsync(
                "com.example.notes",
                new AppMountsRequest([new AppMountBindingInput(key, label, CreateExternalDirectory())])));

        Assert.Equal(expectedCode, error.Code);
    }

    [Fact]
    public async Task ConfigureMountsAsync_RejectsSecondPathWhenSlotIsNotMultiple()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync(
            "1.0.0",
            externalMountsJson: """ "externalMounts": { "config": { "multiple": false, "mode": "ro" } },""");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.ConfigureMountsAsync(
                "com.example.notes",
                new AppMountsRequest(
                [
                    new AppMountBindingInput("config", "a", CreateExternalDirectory()),
                    new AppMountBindingInput("config", "b", CreateExternalDirectory()),
                ])));

        Assert.Equal("app_mount_multiple_not_allowed", error.Code);
    }

    [Fact]
    public async Task ConfigureMountsAsync_BindingsSurviveUpdate()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifestV1 = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: RequiredCatalogMountsJson);
        var manifestV2 = await fixture.WriteManifestAsync("2.0.0", externalMountsJson: RequiredCatalogMountsJson);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestV1));
        var host = CreateExternalDirectory();
        await fixture.Service.ConfigureMountsAsync(
            "com.example.notes",
            new AppMountsRequest([new AppMountBindingInput("catalogRoots", "movies", host)]));

        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(manifestV2));
        await fixture.Service.ApplyUpdateAsync("com.example.notes", new AppUpdateApplyRequest(plan.PlanDigest, manifestV2));

        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        var binding = Assert.Single(app!.Mounts!);
        Assert.Equal("movies", binding.Label);
        Assert.Equal(Path.GetFullPath(host), binding.HostPath);
    }

    [Fact]
    public async Task StartAsync_ThrowsWhenRequiredMountUnconfigured()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: RequiredCatalogMountsJson);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.StartAsync("com.example.notes"));

        Assert.Equal("app_mount_required_unconfigured", error.Code);
    }

    [Fact]
    public async Task StartAsync_ResolvesConfiguredMountsIntoRuntimeContext()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: RequiredCatalogMountsJson);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var host = CreateExternalDirectory();
        await fixture.Service.ConfigureMountsAsync(
            "com.example.notes",
            new AppMountsRequest([new AppMountBindingInput("catalogRoots", "movies", host)]));

        await fixture.Service.StartAsync("com.example.notes");

        var mount = Assert.Single(fixture.Adapter.LastContext!.Mounts);
        Assert.Equal("/mnt/catalogRoots/movies", mount.ContainerPath);
        Assert.Equal("app", mount.Service);
    }

    [Fact]
    public async Task StartAsync_ThrowsWhenConfiguredMountSourceMissing()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: RequiredCatalogMountsJson);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var host = CreateExternalDirectory();
        await fixture.Service.ConfigureMountsAsync(
            "com.example.notes",
            new AppMountsRequest([new AppMountBindingInput("catalogRoots", "movies", host)]));
        Directory.Delete(host, recursive: true);

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.StartAsync("com.example.notes"));

        Assert.Equal("app_mount_source_missing", error.Code);
    }

    private const string RequiredCatalogMountsJson =
        """ "externalMounts": { "catalogRoots": { "multiple": true, "required": true, "service": "app" } },""";

    private static string CreateExternalDirectory()
    {
        var path = Path.Combine(Path.GetTempPath(), $"hosty-mount-src-{Guid.NewGuid():N}");
        Directory.CreateDirectory(path);
        return path;
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

    private static string CreateRemoteLocalCommandManifestJson(string sourceRepository)
        => $$"""
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.remote-local",
              "name": "Remote Local App",
              "version": "1.0.0",
              "source": {
                "type": "git",
                "repository": "{{JsonEscape(sourceRepository)}}",
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
                    "workingDirectory": "apps/remote-app"
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
            """;

    private sealed class StubHttpMessageHandler(Func<HttpRequestMessage, HttpResponseMessage> handler) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(handler(request));
    }

    private static string ReservedPublicOriginSettingsJson()
        => """
                  "settings": [{
                    "key": "HOSTY_PUBLIC_ORIGIN_APP_HTTP",
                    "type": "url",
                    "default": "https://attacker.example.com"
                  }, {
                    "key": "APP_MODE",
                    "type": "string",
                    "default": "production"
                  }],
                """;

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

        public static async Task<LifecycleFixture> CreateAsync(AppManifestService? manifests = null, string? ingressBaseDomain = null)
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
                CorePort: 3001,
                ShellPort: 3000,
                ListenUrl: "http://127.0.0.1:3001",
                CorePublicOrigin: "http://127.0.0.1:3001",
                ShellPublicOrigin: null,
                RuntimePublicHost: "localhost",
                ShellManifestPath: null,
                ShellBootstrapRuntime: "docker",
                ShellSourceOverridePath: null,
                ShellBootstrapEnabled: false,
                ShellAutostart: false,
                IngressProvider: ingressBaseDomain is null ? "none" : "cloudflared",
                IngressBaseDomain: ingressBaseDomain,
                IngressConfigPath: Path.Combine(root, "core", "ingress", "config.yml"),
                IngressTunnelId: ingressBaseDomain is null ? null : "test-tunnel",
                IngressCredentialsFile: ingressBaseDomain is null ? null : Path.Combine(root, "creds.json"));
            var localProcesses = new LocalCommandProcessRegistry();
            var appServiceTokens = new AppServiceTokenService(new ControlSecret("test-control-secret"));
            var localAdapter = new LocalCommandRuntimeAdapter(runtimeConfig, localProcesses, appServiceTokens);
            IIngressController ingress = ingressBaseDomain is null
                ? new NoneIngressController()
                : new CloudflaredIngressController(runtimeConfig, Microsoft.Extensions.Logging.Abstractions.NullLogger<CloudflaredIngressController>.Instance);
            var service = new CoreLifecycleService(paths, apps, manifests, backups, sources, [adapter, localAdapter], ingress, Microsoft.Extensions.Logging.Abstractions.NullLogger<CoreLifecycleService>.Instance);
            return new LifecycleFixture(root, paths, apps, backups, manifests, sources, service, adapter, localProcesses, clock);
        }

        public async Task<string> WriteManifestAsync(
            string version,
            bool includeDependency = false,
            string? sourceRepository = null,
            string? settingsJson = null,
            string? externalMountsJson = null,
            string? networkJson = null)
        {
            var path = Path.Combine(Root, $"notes-{version}.json");
            var dependencyJson = includeDependency
                ? """
                  "dependencies": [{
                    "id": "com.example.cache",
                    "version": "1",
                    "required": true,
                    "endpoints": [{ "key": "default", "as": "cache" }]
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
            var manifestSettingsJson = settingsJson ?? """
                  "settings": [{
                    "key": "APP_MODE",
                    "type": "string",
                    "default": "production"
                  }],
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
                        {{networkJson ?? ""}}
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
                  {{manifestSettingsJson}}
                  {{dependencyJson}}
                  {{externalMountsJson ?? ""}}
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

        public async Task<string> WriteLocalCommandManifestAsync(int? localPort = null, string version = "1.0.0")
        {
            var path = Path.Combine(Root, "local-command.json");
            var localPortJson = localPort is null
                ? ""
                : $"\"localPort\": {localPort.Value},{Environment.NewLine}                          ";
            await File.WriteAllTextAsync(path, $$"""
                {
                  "schemaVersion": "app.0.1",
                  "id": "com.example.local",
                  "name": "Local App",
                  "version": "{{version}}",
                  "runtimeProfiles": [{ "key": "dev", "type": "localCommand", "default": true }],
                  "defaultRuntime": "dev",
                  "services": [{
                    "key": "app",
                    "runtimes": {
                      "dev": {
                        "type": "localCommand",
                        "command": "printf \"$APP_MODE|$HOSTY_APP_DATA_DIR|$HOSTY_DEPENDENCY_CACHE_URL|$PORT|$HOSTY_PORT_HTTP\" > \"$HOSTY_APP_DATA_DIR/local-output.txt\"; sleep 5",
                        "workingDirectory": ".",
                        "environment": {
                          "APP_MODE": "manifest"
                        },
                        "ports": [{
                          "key": "http",
                          "containerPort": 5173,
                          {{localPortJson}}"protocol": "http",
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
                    "required": true,
                    "endpoints": [{ "key": "default", "as": "cache" }]
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

        public async Task<string> WriteLocalCommandPortPreflightManifestAsync(int occupiedPort)
        {
            var path = Path.Combine(Root, "local-command-port-preflight.json");
            await File.WriteAllTextAsync(path, $$"""
                {
                  "schemaVersion": "app.0.1",
                  "id": "com.example.local-preflight",
                  "name": "Local Preflight App",
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
                          "workingDirectory": ".",
                          "ports": [{
                            "key": "http",
                            "containerPort": 5173,
                            "protocol": "http"
                          }]
                        }
                      }
                    },
                    {
                      "key": "second",
                      "runtimes": {
                        "dev": {
                          "type": "localCommand",
                          "command": "sleep 5",
                          "workingDirectory": ".",
                          "ports": [{
                            "key": "http",
                            "containerPort": 5174,
                            "localPort": {{occupiedPort}},
                            "protocol": "http"
                          }]
                        }
                      }
                    }
                  ]
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

    private sealed class RecordingRuntimeAdapter : IAppRuntimeAdapter, IImageDigestResolver
    {
        public string Type => "docker";

        public int StartCount { get; private set; }

        public int StopCount { get; private set; }

        public int? FailOnStartCount { get; set; }

        public Action? OnStarted { get; set; }

        public RuntimeLifecycleContext? LastContext { get; private set; }

        // Per-service artifact locks the fake docker runtime "resolves" on start; persisted by the
        // lifecycle service. Null (default) leaves the app's locks untouched, as a source runtime would.
        public IReadOnlyDictionary<string, ArtifactLock>? StartLocks { get; set; }

        // Digest the fake resolver returns for plan-time remote lookups; null = registry unreachable.
        public string? RemoteDigest { get; set; }

        public Task<AppRuntimeStartResult> StartAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
        {
            StartCount++;
            LastContext = context;
            if (FailOnStartCount == StartCount)
            {
                throw new AppLifecycleException("runtime_start_failed", "Runtime failed to start.");
            }

            OnStarted?.Invoke();
            return Task.FromResult(new AppRuntimeStartResult(
                "running",
                [new AppEndpointContract("app.http", "http", "http://localhost:3100", Public: true, Service: "app", Port: "http")],
                StartLocks));
        }

        public Task<string?> ResolveRemoteDigestAsync(RuntimeDockerImage image, CancellationToken cancellationToken = default)
            => Task.FromResult(RemoteDigest);

        public Task<AppRuntimeOperationResult> StopAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
        {
            StopCount++;
            return Task.FromResult(new AppRuntimeOperationResult("stopped"));
        }

        public Task<AppRuntimeOperationResult> RemoveAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
            => Task.FromResult(new AppRuntimeOperationResult("removed"));

        public Task<AppRuntimeLogsResult> GetLogsAsync(RuntimeLifecycleContext context, int tail, CancellationToken cancellationToken = default)
        {
            var services = context.Manifest.Services
                .Select(service => new AppRuntimeServiceLogs(service.Key, $"{service.Key} log line"))
                .ToList();
            var text = string.Join(Environment.NewLine, services.SelectMany(segment => new[] { $"== {segment.Service} ==", segment.Text }));
            return Task.FromResult(new AppRuntimeLogsResult(text, services));
        }

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

    private static async Task<string> CreateLocalCommandGitRepositoryAsync(string root)
    {
        var repository = Path.Combine(root, "local-command-repo");
        var appDirectory = Path.Combine(repository, "apps", "remote-app");
        Directory.CreateDirectory(appDirectory);
        _ = await RunGitAsync(repository, ["init", "-b", "main"]);
        await File.WriteAllTextAsync(Path.Combine(appDirectory, "README.md"), "remote local command app");
        _ = await RunGitAsync(repository, ["add", "apps/remote-app/README.md"]);
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
