using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData("healthy", "running")]
    [InlineData("degraded", "running")]
    [InlineData("starting", "running")]
    [InlineData("stopped", "stopped")]
    [InlineData("unhealthy", "unknown")]
    [InlineData("partial-weird", null)]
    public void ResolveRuntimeStateFromHealth_MapsAggregateToCoarseState(string status, string? expected)
        => Assert.Equal(expected, CoreLifecycleService.ResolveRuntimeStateFromHealth(new AppRuntimeHealthResult(status, [])));

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
    public async Task ApplyUpdateAsync_AppliesTheConfirmedPlan_IgnoringRequestManifestPath()
    {
        // The bug this closes: Shell sent the plan's *resolved* manifestPath on apply, so Core's rebuild
        // took a different branch than the plan (for a feed app, one that dropped the feed seed fields) and
        // the recomputed digest never matched. Apply must use the plan the operator confirmed regardless
        // of what the request carries — so a request pointing at a wholly different manifest still applies
        // the reviewed one.
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        var reviewed = await fixture.WriteManifestAsync("2.0.0");
        var decoy = await fixture.WriteManifestAsync("9.9.9");

        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(reviewed));
        var result = await fixture.Service.ApplyUpdateAsync(
            "com.example.notes",
            new AppUpdateApplyRequest(plan.PlanDigest, ManifestPath: decoy));

        Assert.Equal("2.0.0", result.App?.Version);
    }

    [Fact]
    public async Task ApplyUpdateAsync_DoesNotEvictAPlanReviewedBySomeoneElse()
    {
        // Plan creation runs outside the app lock (it resolves feeds and probes the registry; holding the
        // lock across that would stall start/stop), so a second operator can review a fresh plan while an
        // apply is in flight. Eviction must therefore be compare-and-remove: an unconditional one would
        // drop *their* plan and fail their apply with a phantom "no plan is pending".
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        var first = await fixture.WriteManifestAsync("2.0.0");
        var second = await fixture.WriteManifestAsync("3.0.0");

        var mine = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(first));
        // Someone else reviews a different target; their plan is now the pending one.
        var theirs = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(second));

        // My digest no longer matches the pending plan, so my apply is refused — and must leave theirs alone.
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.ApplyUpdateAsync("com.example.notes", new AppUpdateApplyRequest(mine.PlanDigest, first)));
        Assert.Equal("update_plan_digest_mismatch", error.Code);

        var applied = await fixture.Service.ApplyUpdateAsync("com.example.notes", new AppUpdateApplyRequest(theirs.PlanDigest, second));
        Assert.Equal("3.0.0", applied.App?.Version);
    }

    [Fact]
    public async Task ApplyUpdateAsync_RejectsWhenNoPlanWasReviewed()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));

        // A digest the operator never reviewed through this Core (a stale client, a scripted caller, or a
        // plan that expired) cannot be applied — Core has nothing to apply, and must not fabricate one.
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.ApplyUpdateAsync("com.example.notes", new AppUpdateApplyRequest("sha256:deadbeef")));

        Assert.Equal("update_plan_expired", error.Code);
    }

    [Fact]
    public async Task ApplyUpdateAsync_RejectsWhenTheBaseMovedSinceReview()
    {
        // The plan was reviewed against 1.0.0; the installed app moves out from under it before apply.
        // Applying the cached plan now would act against a base the operator never saw — the guard is what
        // stops a stale plan silently *downgrading* an app that advanced past the reviewed target. Here the
        // drift is injected straight into the record (a concurrent apply would instead evict the cache),
        // which is the point: even an out-of-band base change is caught rather than silently applied.
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        var target = await fixture.WriteManifestAsync("2.0.0");

        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(target));
        await fixture.Apps.UpdateAppAsync("com.example.notes", app => app with { Version = "5.0.0" });

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.ApplyUpdateAsync("com.example.notes", new AppUpdateApplyRequest(plan.PlanDigest, target)));

        Assert.Equal("update_plan_stale", error.Code);
    }

    [Fact]
    public async Task InstallAsync_RejectsASecondInstallAndLeavesTheRecordUntouched()
    {
        // Planning has always reported "already-installed"; this is the enforcement (C-H2). A repeat
        // install used to rebuild the record from scratch — resetting settings and dropping port
        // reservations while the old runtime kept running and kept holding those ports.
        var fixture = await LifecycleFixture.CreateAsync(withPortAllocator: true);
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        await fixture.Service.ConfigureAsync(
            "com.example.notes",
            new AppConfigureRequest(Settings: new Dictionary<string, string?> { ["APP_MODE"] = "staging" }));
        var before = await fixture.Apps.GetAppAsync("com.example.notes");
        var reservedPort = Assert.Single(before!.PortAssignments!).HostPort;

        var laterManifest = await fixture.WriteManifestAsync("2.0.0");
        var ex = await Assert.ThrowsAsync<AppLifecycleException>(
            () => fixture.Service.InstallAsync(new AppInstallRequest(laterManifest)));

        Assert.Equal("already_installed", ex.Code);
        var after = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal("1.0.0", after!.Version);
        Assert.Equal("staging", after.Settings["APP_MODE"].Value);
        Assert.Equal(reservedPort, Assert.Single(after.PortAssignments!).HostPort);
        // The guard runs before the manifest copy and asset vendoring touch the app root, so the
        // reviewed copy on disk still matches the installed version.
        Assert.Contains(
            "\"version\": \"1.0.0\"",
            await File.ReadAllTextAsync(Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "manifest.json")));
    }

    [Fact]
    public async Task InstallAsync_StartsAppImmediatelyWhenStartOnInstallAndAutostartEnabled()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");

        var install = await fixture.Service.InstallAsync(new AppInstallRequest(manifest, StartOnInstall: true));

        Assert.Equal("installed", install.Status);
        Assert.Equal("running", install.App?.RuntimeState);
        Assert.Equal(1, fixture.Adapter.StartCount);
        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal("running", app!.RuntimeState);
    }

    [Fact]
    public async Task InstallAsync_DoesNotStartWhenAutostartDisabled()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");

        // Autostart off means "this app should not be running", so a start-on-install request is a no-op.
        var install = await fixture.Service.InstallAsync(new AppInstallRequest(manifest, Autostart: false, StartOnInstall: true));

        Assert.Equal("stopped", install.App?.RuntimeState);
        Assert.Equal(0, fixture.Adapter.StartCount);
    }

    [Fact]
    public async Task InstallAsync_DoesNotStartWhenStartOnInstallNotRequested()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");

        // The default (StartOnInstall null) preserves install-then-stopped for callers that reconcile
        // starts separately, e.g. the boot bootstraps deferring to StartAutostartAppsAsync.
        var install = await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        Assert.Equal("stopped", install.App?.RuntimeState);
        Assert.Equal(0, fixture.Adapter.StartCount);
    }

    [Fact]
    public async Task InstallAsync_NormalizesDeclaredCapabilitiesToOptionalFeatures()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        // The vocabulary a real pre-existing manifest declares: lifecycle verbs plus `open`. None of
        // those are the app's to grant — Core authorizes lifecycle on the admin session — so only the
        // optional feature survives. This is what unwedged an app whose manifest predated "update":
        // gating the Update affordance on this list made the update that adds the token unreachable.
        var manifest = await fixture.WriteManifestAsync(
            "1.0.0",
            capabilitiesJson: """ "capabilities": ["restart", "stop", "logs", "open", "update"], """);

        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal(["logs"], app!.Capabilities);
    }

    [Fact]
    public async Task InstallAsync_DefaultsCapabilitiesToOptionalFeaturesWhenManifestDeclaresNone()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");

        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        // Omitting the field means "whatever optional features this app has", not the old all-verbs set.
        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal(["backup", "logs"], app!.Capabilities);
    }

    [Fact]
    public async Task CreateUpdatePlanAsync_DoesNotReportRetiredCapabilityTokensAsRemoved()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifestV1 = await fixture.WriteManifestAsync(
            "1.0.0",
            capabilitiesJson: """ "capabilities": ["logs"], """);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestV1));

        // Simulate a record persisted under the old vocabulary, before normalization existed. Diffing
        // it raw against a normalized target would report every retired token as freshly "removed".
        await fixture.Apps.UpdateAppAsync(
            "com.example.notes",
            app => app with { Capabilities = ["open", "update", "restart", "stop", "logs"] });

        var manifestV2 = await fixture.WriteManifestAsync(
            "1.0.1",
            capabilitiesJson: """ "capabilities": ["logs"], """);
        var plan = await fixture.Service.CreateUpdatePlanAsync(
            "com.example.notes",
            new AppUpdatePlanRequest(manifestV2));

        Assert.DoesNotContain(plan.Changes, change => change.StartsWith("capability:", StringComparison.Ordinal));
    }

    [Fact]
    public async Task CreateUpdatePlanAsync_ToleratesARecordWithNoCapabilitiesCollection()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifestV1 = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestV1));

        // AppRecord.Capabilities is a positional record parameter read straight out of state.json, and
        // nothing enforces its non-null contract at runtime — a hand-edited or truncated file yields
        // null. Planning an update must still work rather than throw out of the diff.
        await fixture.Apps.UpdateAppAsync("com.example.notes", app => app with { Capabilities = null! });

        var manifestV2 = await fixture.WriteManifestAsync("1.0.1");
        var plan = await fixture.Service.CreateUpdatePlanAsync(
            "com.example.notes",
            new AppUpdatePlanRequest(manifestV2));

        // The absent list reads as "no optional features", so the target's defaults arrive as additions.
        Assert.Contains("capability:backup:added", plan.Changes);
        Assert.Contains("capability:logs:added", plan.Changes);
    }

    [Fact]
    public async Task InstallAsync_StillSucceedsWhenStartOnInstallStartFails()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        fixture.Adapter.FailOnStartCount = 1;

        // A start failure is recorded on the app but must not fail the install itself.
        var install = await fixture.Service.InstallAsync(new AppInstallRequest(manifest, StartOnInstall: true));

        Assert.Equal("installed", install.Status);
        Assert.Equal("stopped", install.App?.RuntimeState);
        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal("stopped", app!.RuntimeState);
        Assert.False(string.IsNullOrEmpty(app.LastError));
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
    public async Task GetSettingValueAsync_RevealsAStoredSecretOnExplicitDemand()
    {
        // The admin owns these values and can already read them off the container env; masking them
        // in the UI with no way back turns a wrong paste into an invisible misconfiguration. The
        // summary still never carries the value -- only this per-key call does.
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", settingsJson: """
              "settings": [{
                "key": "API_TOKEN",
                "type": "string",
                "secret": true
              }],
            """);
        var install = await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        await fixture.Service.ConfigureAsync(
            "com.example.notes",
            new AppConfigureRequest(Settings: new Dictionary<string, string?> { ["API_TOKEN"] = "s3cr3t-value" }));

        var revealed = await fixture.Service.GetSettingValueAsync("com.example.notes", "API_TOKEN");

        Assert.Equal("API_TOKEN", revealed.Key);
        Assert.Equal("s3cr3t-value", revealed.Value);

        // The summary keeps masking the value but now says one is set, so the Shell can render
        // "Unchanged" vs "Not set" honestly.
        var summary = Assert.Single(
            (await fixture.Service.ListAppsAsync()).Single().Settings, setting => setting.Key == "API_TOKEN");
        Assert.Null(summary.Value);
        Assert.True(summary.HasValue);

        // Unconfigured at install time: no value yet, and the flag says so.
        var installSetting = Assert.Single(install.App!.Settings, setting => setting.Key == "API_TOKEN");
        Assert.False(installSetting.HasValue);

        // Whitespace is "unset", matching the required-setting check -- otherwise the Shell would
        // show "Unchanged" for a value Core itself refuses to count.
        await fixture.Service.ConfigureAsync(
            "com.example.notes",
            new AppConfigureRequest(Settings: new Dictionary<string, string?> { ["API_TOKEN"] = "   " }));
        var blanked = Assert.Single(
            (await fixture.Service.ListAppsAsync()).Single().Settings, setting => setting.Key == "API_TOKEN");
        Assert.False(blanked.HasValue);
    }

    [Fact]
    public async Task GetSettingValueAsync_RejectsAKeyTheAppDoesNotDeclare()
    {
        // A typo'd key must be an error, not a null that reads as "the secret is empty".
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));

        var ex = await Assert.ThrowsAsync<AppLifecycleException>(
            () => fixture.Service.GetSettingValueAsync("com.example.notes", "NO_SUCH_KEY"));

        Assert.Equal("app_setting_unknown", ex.Code);
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
    public async Task CreateInstallPlanAsync_CarriesSettingLabelAndDescription()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", settingsJson: """
              "settings": [{
                "key": "APP_MODE",
                "type": "string",
                "label": "Operating mode",
                "description": "Controls how the app runs."
              }],
            """);

        var plan = await fixture.Service.CreateInstallPlanAsync(new AppInstallPlanRequest(manifest));
        var install = await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var planSetting = Assert.Single(plan.Settings);
        Assert.Equal("Operating mode", planSetting.Label);
        Assert.Equal("Controls how the app runs.", planSetting.Description);

        // Label/Description survive the manifest -> persisted AppSettingValue -> AppSettingSummary chain.
        var appSetting = Assert.Single(install.App!.Settings, setting => setting.Key == "APP_MODE");
        Assert.Equal("Operating mode", appSetting.Label);
        Assert.Equal("Controls how the app runs.", appSetting.Description);
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
    public async Task PerAppLock_SerializesConcurrentVerbsOnSameApp()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", settingsJson: """
              "settings": [{ "key": "APP_MODE", "type": "string" }],
            """);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        using var startEntered = new ManualResetEventSlim(false);
        using var releaseStart = new ManualResetEventSlim(false);
        fixture.Adapter.OnStarted = () =>
        {
            startEntered.Set();
            // Hold the app's operation lock open (inside StartCoreAsync) until the test releases it.
            releaseStart.Wait(TimeSpan.FromSeconds(5));
        };

        var startTask = fixture.Service.StartAsync("com.example.notes");
        Assert.True(startEntered.Wait(TimeSpan.FromSeconds(5)), "start never reached the adapter");

        // A concurrent verb on the same app must block on the per-app lock until Start releases it —
        // this is what stops a Configure from committing mid-operation and being silently reverted.
        var configureTask = fixture.Service.ConfigureAsync(
            "com.example.notes",
            new AppConfigureRequest(Settings: new Dictionary<string, string?> { ["APP_MODE"] = "staging" }));
        await Task.Delay(200);
        Assert.False(configureTask.IsCompleted, "configure ran while start held the per-app lock");

        releaseStart.Set();
        var startResult = await startTask;
        await configureTask;

        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal("running", startResult.App?.RuntimeState);
        Assert.Equal("staging", app!.Settings["APP_MODE"].Value);
    }

    [Fact]
    public async Task ObserveRuntimeHealth_DockerContainerRunningButRecordStopped_ReconcilesToRunning()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        // Record says stopped (fresh install) but a labelled container is actually running — the exact
        // "stopped but running" drift per-app observation cannot see (C-M1).
        fixture.Adapter.RunningAppIds.Add("com.example.notes");

        await fixture.Service.ObserveRuntimeHealthAsync(new HashSet<string>(StringComparer.Ordinal));

        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal("running", app!.RuntimeState);
    }

    [Fact]
    public async Task ObserveRuntimeHealth_SkipsReconcileWhileAppVerbHoldsLock()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        fixture.Adapter.RunningAppIds.Add("com.example.notes");

        using var startEntered = new ManualResetEventSlim(false);
        using var releaseStart = new ManualResetEventSlim(false);
        fixture.Adapter.OnStarted = () =>
        {
            startEntered.Set();
            releaseStart.Wait(TimeSpan.FromSeconds(5));
        };

        // Hold the per-app operation lock via an in-flight StartAsync.
        var startTask = fixture.Service.StartAsync("com.example.notes");
        Assert.True(startEntered.Wait(TimeSpan.FromSeconds(5)), "start never reached the adapter");

        // The sweep must NOT flip the record while a lifecycle verb owns the lock — otherwise it could
        // race a concurrent Stop and overwrite its "stopped" back to "running". The held verb owns the
        // record meanwhile, so what survives is its own transitional stamp, untouched by the sweep.
        await fixture.Service.ObserveRuntimeHealthAsync(new HashSet<string>(StringComparer.Ordinal));
        var duringHold = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal(AppRuntimeStates.Starting, duringHold!.RuntimeState);
        Assert.NotEqual(AppRuntimeStates.Running, duringHold.RuntimeState);

        releaseStart.Set();
        await startTask;
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
    public async Task InstallAndRemove_CacheDirectoryFollowsData()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", cacheJson: """
            "cache": { "enabled": true },
            """);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var appRoot = Path.Combine(fixture.Paths.AppsRoot, "com.example.notes");
        var cachePath = Path.Combine(appRoot, "cache");
        Assert.True(Directory.Exists(cachePath));
        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        var mapping = Assert.Single(app!.StorageMappings, candidate => candidate.Key == "cache");
        // No explicit target in the manifest, so the docker default is synthesized.
        Assert.Equal("/app/cache", mapping.TargetPath);
        Assert.Equal(cachePath, mapping.HostPath);

        // Kept when data is kept: the cache is keyed by identities in the app's database.
        await File.WriteAllTextAsync(Path.Combine(cachePath, "entry.idx"), "derived");
        await fixture.Service.RemoveAsync("com.example.notes", new AppRemoveRequest(DeleteData: false));
        Assert.Equal("derived", await File.ReadAllTextAsync(Path.Combine(cachePath, "entry.idx")));

        // Deleted with data.
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        await fixture.Service.RemoveAsync("com.example.notes", new AppRemoveRequest(DeleteData: true));
        Assert.False(Directory.Exists(cachePath));
    }

    [Fact]
    public async Task Install_RecordsCacheMappingForTargetlessLocalRuntime()
    {
        // The `enabled`-only localCommand form resolves no CacheTarget, yet the adapter still
        // creates and injects the cache — the record must reflect that, or update/switch plans
        // diff against a missing mapping and report false cache transitions.
        var fixture = await LifecycleFixture.CreateAsync();
        var manifestPath = Path.Combine(Path.GetTempPath(), $"hosty-local-cache-{Guid.NewGuid():N}.json");
        await File.WriteAllTextAsync(manifestPath, """
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
            """);
        try
        {
            await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath));

            var app = await fixture.Apps.GetAppAsync("com.example.notes");
            var mapping = Assert.Single(app!.StorageMappings, candidate => candidate.Key == "cache");
            var cachePath = Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "cache");
            // No container anywhere in a localCommand profile, so the target is the host path itself.
            Assert.Equal(cachePath, mapping.HostPath);
            Assert.Equal(cachePath, mapping.TargetPath);
            Assert.True(Directory.Exists(cachePath));
        }
        finally
        {
            File.Delete(manifestPath);
        }
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
    public async Task RemoveAsync_DeletesStoredSecretsWithData()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var secrets = new AppSecretsStore(fixture.Apps, fixture.Paths);
        Assert.Equal(AppSecretsStatus.Ok, await secrets.SetAsync("com.example.notes", "provider.tokens", "credential"));

        await fixture.Service.RemoveAsync("com.example.notes", new AppRemoveRequest(DeleteData: true));

        Assert.False(File.Exists(Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "secrets.json")));
        // The fence holds after removal: a late write refuses instead of recreating the app root.
        Assert.Equal(AppSecretsStatus.AppNotFound, await secrets.SetAsync("com.example.notes", "provider.tokens", "late"));
    }

    [Fact]
    public async Task RemoveAsync_DeletesStoredSecretsWithData_EvenWhenRuntimeStateIsKept()
    {
        // `hosty apps remove --delete-data --keep-state`: state.json survives, so the store's
        // existence fence cannot be what protects the deleted credentials here.
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var secrets = new AppSecretsStore(fixture.Apps, fixture.Paths);
        Assert.Equal(AppSecretsStatus.Ok, await secrets.SetAsync("com.example.notes", "provider.tokens", "credential"));

        await fixture.Service.RemoveAsync(
            "com.example.notes",
            new AppRemoveRequest(DeleteRuntimeState: false, DeleteData: true));

        Assert.True(File.Exists(Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "state.json")));
        Assert.False(File.Exists(Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "secrets.json")));
    }

    [Fact]
    public async Task RemoveAsync_RetainsStoredSecretsWhenDataKept_ReadableAfterReinstall()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var secrets = new AppSecretsStore(fixture.Apps, fixture.Paths);
        Assert.Equal(AppSecretsStatus.Ok, await secrets.SetAsync("com.example.notes", "provider.tokens", "credential"));

        await fixture.Service.RemoveAsync("com.example.notes", new AppRemoveRequest(DeleteData: false));
        Assert.True(File.Exists(Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "secrets.json")));

        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var restored = await secrets.GetAsync("com.example.notes", "provider.tokens");
        Assert.Equal(AppSecretsStatus.Ok, restored.Status);
        Assert.Equal("credential", restored.Value);
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

    [Fact]
    public async Task LiveSourceRuntime_MarksSummaryLive_AndRefusesReviewedUpdate()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var folder = Path.Combine(fixture.Root, "live-app");
        Directory.CreateDirectory(folder);
        var manifestPath = Path.Combine(folder, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, """
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.live",
              "name": "Live App",
              "version": "1.0.0",
              "runtimeProfiles": [
                { "key": "docker", "type": "docker", "default": true },
                { "key": "local", "type": "localCommand", "development": true }
              ],
              "defaultRuntime": "docker",
              "services": [{
                "key": "app",
                "runtimes": {
                  "docker": { "type": "docker", "image": "ghcr.io/example/live:1.0.0" },
                  "local": { "type": "localCommand", "command": "sleep 5", "workingDirectory": "." }
                }
              }]
            }
            """);

        // Installed on the compiled docker runtime: the runtime is not live and the reviewed-update
        // path applies (this is the case that "works" in the reported bug).
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath, SelectedRuntime: "docker"));

        var dockerSummary = Assert.Single(await fixture.Service.ListAppsAsync());
        Assert.False(dockerSummary.Live);
        var dockerPlan = await fixture.Service.CreateUpdatePlanAsync("com.example.live", new AppUpdatePlanRequest());
        Assert.Equal("docker", dockerPlan.TargetRuntime);

        // Switching the selected runtime to the operator-owned localCommand profile makes it live
        // source: the contract is adopted on restart, so the summary flags the runtime live (clients
        // hide Update + show the "Live" badge) and a blank reviewed-update plan is refused with a clear
        // error instead of the confusing "manifest failed validation" from the reported bug.
        var app = await fixture.Apps.GetAppAsync("com.example.live");
        await fixture.Apps.UpsertAppAsync(app! with { SelectedRuntime = "local" });

        var liveSummary = Assert.Single(await fixture.Service.ListAppsAsync());
        Assert.True(liveSummary.Live);

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.CreateUpdatePlanAsync("com.example.live", new AppUpdatePlanRequest()));
        Assert.Equal("update_live_source_runtime", error.Code);

        // Legacy/partially-populated record that never persisted RuntimeProfiles must still classify as
        // live source: both the summary flag and the update-plan guard fall back to loading profiles
        // from the reviewed internal manifest rather than silently treating the runtime as non-live.
        var live = await fixture.Apps.GetAppAsync("com.example.live");
        await fixture.Apps.UpsertAppAsync(live! with { RuntimeProfiles = null });

        var legacySummary = Assert.Single(await fixture.Service.ListAppsAsync());
        Assert.True(legacySummary.Live);

        var legacyError = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.CreateUpdatePlanAsync("com.example.live", new AppUpdatePlanRequest()));
        Assert.Equal("update_live_source_runtime", legacyError.Code);
    }

    [Fact]
    public async Task InstallAsync_ManifestSystemRole_MarksRecordAndPlanSystem()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifestPath = Path.Combine(fixture.Root, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, CreateRoleManifestJson("1.0.0", system: true));

        var plan = await fixture.Service.CreateInstallPlanAsync(new AppInstallPlanRequest(manifestPath));
        Assert.True(plan.System);

        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath));
        var app = await fixture.Apps.GetAppAsync("com.example.roleapp");
        Assert.True(app!.System);
    }

    [Fact]
    public async Task UpdateAsync_ManifestAddingSystemRole_SurfacesRoleChangeAndEscalates()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifestPath = Path.Combine(fixture.Root, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, CreateRoleManifestJson("1.0.0", system: false));
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath));
        Assert.False((await fixture.Apps.GetAppAsync("com.example.roleapp"))!.System);

        await File.WriteAllTextAsync(manifestPath, CreateRoleManifestJson("1.1.0", system: true));
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.roleapp", new AppUpdatePlanRequest());
        Assert.Contains("role:runtime->system", plan.Changes);

        await fixture.Service.ApplyUpdateAsync("com.example.roleapp", new AppUpdateApplyRequest(plan.PlanDigest));
        Assert.True((await fixture.Apps.GetAppAsync("com.example.roleapp"))!.System);
    }

    [Fact]
    public async Task UpdateAsync_SystemAppManifestWithoutRole_KeepsSystemWithoutRoleChange()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifestPath = Path.Combine(fixture.Root, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, CreateRoleManifestJson("1.0.0", system: true));
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath));

        // System is sticky: dropping the role from a later manifest must not silently expose an
        // installed system app to ordinary users, and no misleading "role" change is reported.
        await File.WriteAllTextAsync(manifestPath, CreateRoleManifestJson("1.1.0", system: false));
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.roleapp", new AppUpdatePlanRequest());
        Assert.DoesNotContain("role:runtime->system", plan.Changes);

        await fixture.Service.ApplyUpdateAsync("com.example.roleapp", new AppUpdateApplyRequest(plan.PlanDigest));
        Assert.True((await fixture.Apps.GetAppAsync("com.example.roleapp"))!.System);
    }

    [Fact]
    public async Task RemoveAsync_SystemApp_RemovesLikeAnyOtherApp()
    {
        // "system" governs who may see and reach an app, never whether it can be uninstalled — and the
        // surface making the call makes no difference either.
        var fixture = await LifecycleFixture.CreateAsync();
        var manifestPath = Path.Combine(fixture.Root, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, CreateRoleManifestJson("1.0.0", system: true));
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath));
        Assert.True((await fixture.Apps.GetAppAsync("com.example.roleapp"))!.System);

        await fixture.Service.RemoveAsync("com.example.roleapp", new AppRemoveRequest());

        Assert.Null(await fixture.Apps.GetAppAsync("com.example.roleapp"));
    }

    [Fact]
    public async Task GetRemovalImpactAsync_ReportsDeclaredDependents()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var providerPath = Path.Combine(fixture.Root, "provider.json");
        await File.WriteAllTextAsync(providerPath, CreateRoleManifestJson("1.0.0", system: true));
        await fixture.Service.InstallAsync(new AppInstallRequest(providerPath));
        var dependentPath = Path.Combine(fixture.Root, "dependent.json");
        await File.WriteAllTextAsync(dependentPath, CreateDependentManifestJson("com.example.roleapp"));
        await fixture.Service.InstallAsync(new AppInstallRequest(dependentPath));

        var impact = await fixture.Service.GetRemovalImpactAsync("com.example.roleapp");

        Assert.True(impact.System);
        var dependent = Assert.Single(impact.Dependents);
        Assert.Equal("com.example.dependent", dependent.AppId);
        Assert.True(dependent.Required);
        Assert.Contains("provider", dependent.Aliases);
    }

    [Fact]
    public async Task GetRemovalImpactAsync_AppNothingDeclaresAgainst_IsEmpty()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifestPath = Path.Combine(fixture.Root, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, CreateRoleManifestJson("1.0.0", system: false));
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath));

        var impact = await fixture.Service.GetRemovalImpactAsync("com.example.roleapp");

        Assert.False(impact.System);
        Assert.Empty(impact.Dependents);
        Assert.Empty(impact.Capabilities);
    }

    private static string CreateDependentManifestJson(string dependencyId)
        => $$"""
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.dependent",
              "name": "Dependent App",
              "version": "1.0.0",
              "dependencies": [{
                "id": "{{dependencyId}}",
                "required": true,
                "endpoints": [{ "key": "web", "as": "provider" }]
              }],
              "runtimeProfiles": [{ "key": "docker", "type": "docker", "default": true }],
              "services": [{
                "key": "app",
                "runtimes": {
                  "docker": { "type": "docker", "image": "ghcr.io/example/dependent:1.0.0" }
                }
              }]
            }
            """;

    private static string CreateRoleManifestJson(string version, bool system)
        => $$"""
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.roleapp",
              "name": "Role App",
              "version": "{{version}}",{{(system ? "\n  \"role\": \"system\"," : "")}}
              "runtimeProfiles": [{ "key": "docker", "type": "docker", "default": true }],
              "services": [{
                "key": "app",
                "runtimes": {
                  "docker": { "type": "docker", "image": "ghcr.io/example/roleapp:1.0.0" }
                }
              }]
            }
            """;

    [Fact]
    public async Task SummarySupportsSource_ReflectsLocalCommandProfile_AndSurfacesOverridePath()
    {
        var fixture = await LifecycleFixture.CreateAsync();

        // A docker-only app cannot run from a local source folder: no Source tab in the Shell.
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        var dockerSummary = Assert.Single(await fixture.Service.ListAppsAsync());
        Assert.False(dockerSummary.SupportsSource);
        Assert.Null(dockerSummary.SourceOverridePath);

        // A non-URL install that declares a development runtime (localCommand + development: true) is
        // source-capable even before any override is set, so the Shell can offer the Source tab to
        // point it at a folder. A non-development localCommand profile would not qualify.
        var folder = Path.Combine(fixture.Root, "src-app");
        Directory.CreateDirectory(folder);
        var manifestPath = Path.Combine(folder, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, """
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.src",
              "name": "Src App",
              "version": "1.0.0",
              "runtimeProfiles": [
                { "key": "docker", "type": "docker", "default": true },
                { "key": "local", "type": "localCommand", "development": true }
              ],
              "defaultRuntime": "docker",
              "services": [{
                "key": "app",
                "runtimes": {
                  "docker": { "type": "docker", "image": "ghcr.io/example/src:1.0.0" },
                  "local": { "type": "localCommand", "command": "sleep 5", "workingDirectory": "." }
                }
              }]
            }
            """);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath, SelectedRuntime: "docker"));

        var srcSummary = (await fixture.Service.ListAppsAsync()).Single(summary => summary.Id == "com.example.src");
        Assert.True(srcSummary.SupportsSource);
        Assert.Null(srcSummary.SourceOverridePath);

        // Setting a local override surfaces the folder plus the managed checkout path on the summary.
        var overrideFolder = Path.Combine(fixture.Root, "override-src");
        Directory.CreateDirectory(overrideFolder);
        await fixture.Sources.SetLocalOverrideAsync("com.example.src", new AppSourceOverrideRequest(overrideFolder));

        var overridden = (await fixture.Service.ListAppsAsync()).Single(summary => summary.Id == "com.example.src");
        Assert.True(overridden.SupportsSource);
        Assert.Equal(Path.GetFullPath(overrideFolder), overridden.SourceOverridePath);
        Assert.Equal(Path.Combine(fixture.Paths.AppsRoot, "com.example.src", "source"), overridden.SourceManagedPath);
        // Still on the docker runtime, so it is not running live and no live source path is surfaced.
        Assert.Null(overridden.SourceLivePath);

        // Selecting the localCommand runtime makes it live; SourceLivePath (the badge tooltip path)
        // resolves to the override folder.
        var record = await fixture.Apps.GetAppAsync("com.example.src");
        await fixture.Apps.UpsertAppAsync(record! with { SelectedRuntime = "local" });
        var liveSrc = (await fixture.Service.ListAppsAsync()).Single(summary => summary.Id == "com.example.src");
        Assert.True(liveSrc.Live);
        Assert.Equal(Path.GetFullPath(overrideFolder), liveSrc.SourceLivePath);
    }

    [Fact]
    public async Task NonDevelopmentLocalCommandRuntime_IsSourceCapableButNotLiveByDefault()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var folder = Path.Combine(fixture.Root, "prod-src-app");
        Directory.CreateDirectory(folder);
        var manifestPath = Path.Combine(folder, "manifest.json");
        // A localCommand runtime WITHOUT development: it is source-capable (the operator may override it
        // and toggle Development Mode on), but its Development Mode defaults OFF, so it is not live until
        // the operator flips it. See the Development Mode operator toggle (runtime-artifact-model.md).
        await File.WriteAllTextAsync(manifestPath, """
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.prodsrc",
              "name": "Prod Src",
              "version": "1.0.0",
              "runtimeProfiles": [
                { "key": "docker", "type": "docker", "default": true },
                { "key": "release", "type": "localCommand" }
              ],
              "defaultRuntime": "docker",
              "services": [{
                "key": "app",
                "runtimes": {
                  "docker": { "type": "docker", "image": "ghcr.io/example/prodsrc:1.0.0" },
                  "release": { "type": "localCommand", "command": "npm run start", "workingDirectory": "." }
                }
              }]
            }
            """);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath, SelectedRuntime: "docker"));

        var summary = (await fixture.Service.ListAppsAsync()).Single(item => item.Id == "com.example.prodsrc");
        // Source-capable: a localCommand runtime exists, so the operator can override + toggle it.
        Assert.True(summary.SupportsSource);

        // Selecting the non-development localCommand runtime does not make it live: Development Mode
        // defaults OFF (its manifest declares no development flag), so the reviewed path still applies.
        var record = await fixture.Apps.GetAppAsync("com.example.prodsrc");
        await fixture.Apps.UpsertAppAsync(record! with { SelectedRuntime = "release" });
        var selected = (await fixture.Service.ListAppsAsync()).Single(item => item.Id == "com.example.prodsrc");
        Assert.False(selected.Live);
        Assert.True(selected.SupportsSource);
    }

    [Fact]
    public async Task UrlInstallWithDevelopmentRuntime_IsSourceCapable_AndOverrideMakesItLive()
    {
        const string manifestUrl = "https://apps.example.test/url-dev/manifest.json";
        var manifests = new AppManifestService(new HttpClient(new StubHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("""
                {
                  "schemaVersion": "app.0.1",
                  "id": "com.example.url-dev",
                  "name": "Url Dev App",
                  "version": "1.0.0",
                  "runtimeProfiles": [
                    { "key": "docker", "type": "docker", "default": true },
                    { "key": "dev", "type": "localCommand", "development": true }
                  ],
                  "defaultRuntime": "docker",
                  "services": [{
                    "key": "app",
                    "runtimes": {
                      "docker": { "type": "docker", "image": "ghcr.io/example/url-dev:1.0.0" },
                      "dev": { "type": "localCommand", "command": "sleep 5", "workingDirectory": "." }
                    }
                  }]
                }
                """, Encoding.UTF8, "application/json"),
        })));
        var fixture = await LifecycleFixture.CreateAsync(manifests);

        // A URL install may select the compiled docker runtime; the development localCommand profile it
        // also declares is not selected, so the remote-local-command guard does not trip.
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestUrl, SelectedRuntime: "docker"));

        // Source-capability follows the presence of a development runtime, not the install channel: the
        // Shell offers the Source tab even for a URL install so the operator can point it at a folder.
        var installed = (await fixture.Service.ListAppsAsync()).Single(summary => summary.Id == "com.example.url-dev");
        Assert.Equal(manifestUrl, (await fixture.Apps.GetAppAsync("com.example.url-dev"))?.ManifestUrl);
        Assert.True(installed.SupportsSource);
        Assert.False(installed.Live);

        // Setting an override then selecting the development runtime runs it live from the operator's
        // folder — the explicit override supersedes the URL install's reviewed contract.
        var overrideFolder = Path.Combine(fixture.Root, "url-dev-override");
        Directory.CreateDirectory(overrideFolder);
        await fixture.Sources.SetLocalOverrideAsync("com.example.url-dev", new AppSourceOverrideRequest(overrideFolder));

        var record = await fixture.Apps.GetAppAsync("com.example.url-dev");
        await fixture.Apps.UpsertAppAsync(record! with { SelectedRuntime = "dev" });

        var live = (await fixture.Service.ListAppsAsync()).Single(summary => summary.Id == "com.example.url-dev");
        Assert.True(live.SupportsSource);
        Assert.Equal(Path.GetFullPath(overrideFolder), live.SourceOverridePath);
        Assert.True(live.Live);
        Assert.Equal(Path.GetFullPath(overrideFolder), live.SourceLivePath);

        // While it runs live from the operator's folder, the reviewed-update path no longer applies.
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.CreateUpdatePlanAsync("com.example.url-dev", new AppUpdatePlanRequest()));
        Assert.Equal("update_live_source_runtime", error.Code);
    }

    [Fact]
    public async Task ConfigureDevelopmentMode_TogglesLivenessOnANonDevelopmentRuntime()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var folder = Path.Combine(fixture.Root, "toggle-app");
        Directory.CreateDirectory(folder);
        var manifestPath = Path.Combine(folder, "manifest.json");
        // A source runtime with no development flag: Development Mode defaults OFF.
        await File.WriteAllTextAsync(manifestPath, """
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.toggle",
              "name": "Toggle",
              "version": "1.0.0",
              "runtimeProfiles": [{ "key": "release", "type": "localCommand", "default": true }],
              "defaultRuntime": "release",
              "services": [{ "key": "app", "runtimes": { "release": { "type": "localCommand", "command": "echo hi" } } }]
            }
            """);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath));

        var off = (await fixture.Service.ListAppsAsync()).Single(item => item.Id == "com.example.toggle");
        Assert.False(off.Live);
        Assert.False(off.RuntimeProfiles.Single().DevelopmentMode);
        Assert.True(off.SupportsSource);

        // The operator flips Development Mode ON for the release runtime → it runs live from its source.
        await fixture.Service.ConfigureDevelopmentModeAsync("com.example.toggle", new AppDevelopmentModeRequest("release", Enabled: true));
        var on = (await fixture.Service.ListAppsAsync()).Single(item => item.Id == "com.example.toggle");
        Assert.True(on.Live);
        Assert.True(on.RuntimeProfiles.Single().DevelopmentMode);

        // And back OFF, restoring the locked/reviewed behavior.
        await fixture.Service.ConfigureDevelopmentModeAsync("com.example.toggle", new AppDevelopmentModeRequest("release", Enabled: false));
        var backOff = (await fixture.Service.ListAppsAsync()).Single(item => item.Id == "com.example.toggle");
        Assert.False(backOff.Live);
        Assert.False(backOff.RuntimeProfiles.Single().DevelopmentMode);
    }

    [Fact]
    public async Task ConfigureDevelopmentMode_RejectsNonSourceRuntime()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.ConfigureDevelopmentModeAsync("com.example.notes", new AppDevelopmentModeRequest("docker", Enabled: true)));

        Assert.Equal("development_mode_unsupported_runtime", error.Code);
    }

    [Fact]
    public async Task ConfigureDevelopmentMode_Enable_SnapshotsDataAndRecordsBaseline()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var id = await InstallToggleSourceAppAsync(fixture);
        var dataPath = Path.Combine(fixture.Paths.AppsRoot, id, "data");
        Directory.CreateDirectory(dataPath);
        await File.WriteAllTextAsync(Path.Combine(dataPath, "notes.db"), "v1-data");

        var enabled = await fixture.Service.ConfigureDevelopmentModeAsync(id, new AppDevelopmentModeRequest("release", Enabled: true));
        // Enabling is not risky (nothing to roll back to yet).
        Assert.Null(enabled.DevelopmentModeRestore);

        var snapshot = (await fixture.Backups.ListBackupsAsync(id)).Single(backup => backup.Reason == "pre-development-mode");
        var app = await fixture.Apps.GetAppAsync(id);
        Assert.NotNull(app!.DevelopmentModeBaselines);
        var baseline = app.DevelopmentModeBaselines!["release"];
        Assert.Equal("1.0.0", baseline.Version);
        Assert.Equal(snapshot.BackupId, baseline.BackupId);
    }

    [Fact]
    public async Task ConfigureDevelopmentMode_Enable_WithoutDataDirectory_TakesNoSnapshot()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var id = await InstallToggleSourceAppAsync(fixture);
        var dataPath = Path.Combine(fixture.Paths.AppsRoot, id, "data");
        if (Directory.Exists(dataPath))
        {
            Directory.Delete(dataPath, recursive: true);
        }

        await fixture.Service.ConfigureDevelopmentModeAsync(id, new AppDevelopmentModeRequest("release", Enabled: true));

        var backups = await fixture.Backups.ListBackupsAsync(id);
        Assert.DoesNotContain(backups, backup => backup.Reason == "pre-development-mode");
        // The baseline is still recorded so a later disable can compare versions; it just has no snapshot.
        var app = await fixture.Apps.GetAppAsync(id);
        Assert.Null(app!.DevelopmentModeBaselines!["release"].BackupId);
    }

    [Fact]
    public async Task ConfigureDevelopmentMode_Disable_RecommendsRestoreWhenVersionDriftedInDevMode()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var id = await InstallToggleSourceAppAsync(fixture);
        var dataPath = Path.Combine(fixture.Paths.AppsRoot, id, "data");
        Directory.CreateDirectory(dataPath);
        await File.WriteAllTextAsync(Path.Combine(dataPath, "notes.db"), "v1-data");

        await fixture.Service.ConfigureDevelopmentModeAsync(id, new AppDevelopmentModeRequest("release", Enabled: true));
        var snapshotId = (await fixture.Backups.ListBackupsAsync(id)).Single(backup => backup.Reason == "pre-development-mode").BackupId;

        // Simulate the dev-mode runtime having adopted a newer manifest version while running live.
        _ = await fixture.Apps.UpdateAppAsync(id, current => current with { Version = "1.1.0" });

        var disabled = await fixture.Service.ConfigureDevelopmentModeAsync(id, new AppDevelopmentModeRequest("release", Enabled: false));

        Assert.NotNull(disabled.DevelopmentModeRestore);
        Assert.True(disabled.DevelopmentModeRestore!.Recommended);
        Assert.Equal("release", disabled.DevelopmentModeRestore.Runtime);
        Assert.Equal(snapshotId, disabled.DevelopmentModeRestore.BackupId);
        Assert.Equal("1.0.0", disabled.DevelopmentModeRestore.BaselineVersion);
        Assert.Equal("1.1.0", disabled.DevelopmentModeRestore.CurrentVersion);

        // The baseline is cleared on disable so a re-enable captures a fresh one.
        var app = await fixture.Apps.GetAppAsync(id);
        Assert.True(app!.DevelopmentModeBaselines is null || !app.DevelopmentModeBaselines.ContainsKey("release"));
    }

    [Fact]
    public async Task ConfigureDevelopmentMode_Disable_NoRestoreHintWhenVersionUnchanged()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var id = await InstallToggleSourceAppAsync(fixture);
        var dataPath = Path.Combine(fixture.Paths.AppsRoot, id, "data");
        Directory.CreateDirectory(dataPath);
        await File.WriteAllTextAsync(Path.Combine(dataPath, "notes.db"), "v1-data");

        await fixture.Service.ConfigureDevelopmentModeAsync(id, new AppDevelopmentModeRequest("release", Enabled: true));
        var disabled = await fixture.Service.ConfigureDevelopmentModeAsync(id, new AppDevelopmentModeRequest("release", Enabled: false));

        Assert.Null(disabled.DevelopmentModeRestore);
    }

    [Fact]
    public async Task ConfigureDevelopmentMode_Disable_NoRestoreHintWhenEnableTookNoSnapshot()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var id = await InstallToggleSourceAppAsync(fixture);
        var dataPath = Path.Combine(fixture.Paths.AppsRoot, id, "data");
        if (Directory.Exists(dataPath))
        {
            Directory.Delete(dataPath, recursive: true);
        }

        // Enable with no data directory → a baseline is recorded but its BackupId is null.
        await fixture.Service.ConfigureDevelopmentModeAsync(id, new AppDevelopmentModeRequest("release", Enabled: true));

        // Even with version drift there is no snapshot to restore, so a disable must not recommend a
        // rollback (and must not leave the app stranded stopped with no rollback path).
        _ = await fixture.Apps.UpdateAppAsync(id, current => current with { Version = "1.1.0" });
        var disabled = await fixture.Service.ConfigureDevelopmentModeAsync(id, new AppDevelopmentModeRequest("release", Enabled: false));

        Assert.Null(disabled.DevelopmentModeRestore);
    }

    // A source (localCommand) app with Development Mode defaulting OFF, plus a data directory the
    // pre-development-mode snapshot can capture. Mirrors the manifest of the toggle test above.
    private static async Task<string> InstallToggleSourceAppAsync(LifecycleFixture fixture)
    {
        var folder = Path.Combine(fixture.Root, $"toggle-{Guid.NewGuid():N}");
        Directory.CreateDirectory(folder);
        var manifestPath = Path.Combine(folder, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, """
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.toggle",
              "name": "Toggle",
              "version": "1.0.0",
              "runtimeProfiles": [{ "key": "release", "type": "localCommand", "default": true }],
              "defaultRuntime": "release",
              "services": [{ "key": "app", "runtimes": { "release": { "type": "localCommand", "command": "echo hi" } } }]
            }
            """);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath));
        return "com.example.toggle";
    }

    [Theory]
    [InlineData("pre-update")]
    [InlineData("pre-restore")]
    [InlineData("pre-runtime-switch")]
    [InlineData("pre-development-mode")]
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
    public async Task ApplyRuntimeSwitchAsync_PreservesAssignedHostPortOverride()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteSwitchableDockerManifestAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        // An assigned host-port override (e.g. the Shell's config.ShellPort, set by the bootstrap) is a
        // Core-reserved setting, not a manifest-declared one.
        await fixture.Service.ConfigureAsync(
            "com.example.notes",
            new AppConfigureRequest(new Dictionary<string, string?>(StringComparer.Ordinal) { ["HOSTY_PORT_HTTP"] = "7171" }));
        Assert.Equal("7171", (await fixture.Apps.GetAppAsync("com.example.notes"))?.Settings.GetValueOrDefault("HOSTY_PORT_HTTP")?.Value);

        var plan = await fixture.Service.CreateRuntimeSwitchPlanAsync(
            "com.example.notes",
            new AppRuntimeSwitchPlanRequest("docker-alt"));
        _ = await fixture.Service.ApplyRuntimeSwitchAsync(
            "com.example.notes",
            new AppRuntimeSwitchApplyRequest("docker-alt", plan.PlanDigest));

        // The override survives the switch — the app's assigned port does not silently revert to the
        // manifest default.
        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal("docker-alt", app?.SelectedRuntime);
        Assert.Equal("7171", app?.Settings.GetValueOrDefault("HOSTY_PORT_HTTP")?.Value);
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
            new AppConfigureRequest(UpdatePolicy: "Pinned"));

        Assert.Equal("pinned", configured.App?.UpdatePolicy);
        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal("pinned", app!.UpdatePolicy);
    }

    [Fact]
    public async Task ConfigureAsync_RejectsTheRemovedRollingPolicy()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var ex = await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Service.ConfigureAsync(
            "com.example.notes",
            new AppConfigureRequest(UpdatePolicy: "rolling")));

        Assert.Equal("app_update_policy_invalid", ex.Code);
    }

    [Fact]
    public async Task ListAppsAsync_SurfacesALegacyRollingRecordAsPinned()
    {
        // Records written before the removal may still persist "rolling"; the projection normalizes
        // so clients never see semantics that no longer exist.
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        await fixture.Apps.UpdateAppAsync("com.example.notes", app => app with { UpdatePolicy = "rolling" });

        var summaries = await fixture.Apps.ListAppsAsync();

        Assert.Equal("pinned", Assert.Single(summaries).UpdatePolicy);
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

    // A URL-installed app without a feed compares against the *refetched* external manifest, not the
    // installed internal copy. This is what makes a candidate that moves to new versioned image tags
    // visible at all (system apps installed from the distribution list are the primary case).
    [Fact]
    public async Task GetUpdateStatusAsync_RefetchesManifestUrlCandidate_ReportsManifestMovement()
    {
        const string manifestUrl = "https://example.test/web/manifest.json";
        var currentManifest = WebManifest("1.0.0");
        var manifests = new AppManifestService(new HttpClient(new StubHttpMessageHandler(_ =>
            currentManifest is null
                ? throw new HttpRequestException("remote unavailable")
                : new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(currentManifest, Encoding.UTF8, "application/json"),
                })));
        var fixture = await LifecycleFixture.CreateAsync(manifests);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestUrl, SelectedRuntime: "docker"));

        // The remote manifest moves to a new version with a new versioned image tag.
        currentManifest = WebManifest("1.1.0");

        var status = await fixture.Service.GetUpdateStatusAsync("com.example.web");

        Assert.True(status.ManifestUpdateAvailable);
        Assert.True(status.UpdateAvailable);
        Assert.False(status.ManifestUnknown);
    }

    [Fact]
    public async Task GetUpdateStatusAsync_ManifestUrlUnreachable_ReportsManifestUnknown()
    {
        const string manifestUrl = "https://example.test/web/manifest.json";
        var currentManifest = WebManifest("1.0.0");
        var manifests = new AppManifestService(new HttpClient(new StubHttpMessageHandler(_ =>
            currentManifest is null
                ? throw new HttpRequestException("remote unavailable")
                : new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(currentManifest, Encoding.UTF8, "application/json"),
                })));
        var fixture = await LifecycleFixture.CreateAsync(manifests);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestUrl, SelectedRuntime: "docker"));

        // The remote goes dark: the read-only status check must degrade to "unknown", never fail.
        currentManifest = null;

        var status = await fixture.Service.GetUpdateStatusAsync("com.example.web");

        Assert.True(status.ManifestUnknown);
        Assert.False(status.ManifestUpdateAvailable);
        Assert.False(status.UpdateAvailable);
    }

    private static string WebManifest(string version) => $$"""
        {
          "schemaVersion": "app.0.1",
          "id": "com.example.web",
          "name": "Web App",
          "version": "{{version}}",
          "runtimeProfiles": [{ "key": "docker", "type": "docker", "default": true }],
          "defaultRuntime": "docker",
          "services": [{ "key": "app", "runtimes": { "docker": { "type": "docker", "image": "ghcr.io/acme/web:{{version}}" } } }]
        }
        """;

    // Plan-first updates: the classification allow-list. Routine = version bump, manifest-body delta,
    // resolved artifact move, image tag advancing inside its own repository. Everything else —
    // including change kinds the classifier has never seen — is review-class by default.
    [Theory]
    [InlineData("version:1.0.0->1.1.0", false)]
    [InlineData("manifest", false)]
    [InlineData("artifact:app:sha256:aaa->sha256:bbb", false)]
    [InlineData("artifact:app:sha256:aaa->unknown", true)]
    [InlineData("image:app:ghcr.io/example/notes:1.0.0->ghcr.io/example/notes:1.1.0", false)]
    [InlineData("image:app:registry:5000/notes:1.0.0->registry:5000/notes:1.1.0", false)]
    [InlineData("image:app:ghcr.io/example/notes@sha256:aaa->ghcr.io/example/notes@sha256:bbb", false)]
    [InlineData("image:app:ghcr.io/example/notes:1.0.0->ghcr.io/elsewhere/notes:1.1.0", true)]
    [InlineData("image:app:none->ghcr.io/example/notes:1.1.0", true)]
    [InlineData("runtime:docker->docker-alt", true)]
    [InlineData("role:runtime->system", true)]
    [InlineData("service:worker:added:docker", true)]
    [InlineData("setting:APP_MODE:added", true)]
    [InlineData("dependency:com.example.cache:added", true)]
    [InlineData("endpoint:app.http:removed:http", true)]
    [InlineData("network:app:bridge->host", true)]
    [InlineData("capabilities:app:none->NET_ADMIN", true)]
    [InlineData("port:app.http:added:3000/http", true)]
    [InlineData("environment:app.DEBUG:added", true)]
    [InlineData("command:app:changed", true)]
    [InlineData("some-future-change-kind", true)]
    public void PlanRequiresReview_ClassifiesChangeKinds(string change, bool requiresReview)
        => Assert.Equal(requiresReview, CoreLifecycleService.PlanRequiresReview([change]));

    [Fact]
    public void PlanRequiresReview_EmptyChangesAreRoutine()
        => Assert.False(CoreLifecycleService.PlanRequiresReview([]));

    [Fact]
    public async Task CreateUpdatePlanAsync_RoutineVersionBumpDoesNotRequireReview()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var manifestV2 = await fixture.WriteManifestAsync("1.1.0");

        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(manifestV2));

        // The ordinary release shape: version bump + the image tag advancing in the same repository.
        Assert.Contains(plan.Changes, change => change.StartsWith("version:", StringComparison.Ordinal));
        Assert.Contains(plan.Changes, change => change.StartsWith("image:", StringComparison.Ordinal));
        Assert.False(plan.RequiresReview);
    }

    [Fact]
    public async Task CreateUpdatePlanAsync_ResolvedArtifactMoveDoesNotRequireReview()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        fixture.Adapter.StartLocks = new Dictionary<string, ArtifactLock>
        {
            ["app"] = new("image", "sha256:" + new string('a', 64), "ghcr.io/example/notes:1.0.0", null, null, DateTimeOffset.UtcNow),
        };
        await fixture.Service.StartAsync("com.example.notes");
        fixture.Adapter.RemoteDigest = "sha256:" + new string('b', 64);

        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest());

        Assert.Contains(plan.Changes, change => change.StartsWith("artifact:app:", StringComparison.Ordinal));
        Assert.False(plan.RequiresReview);
    }

    [Fact]
    public async Task CreateUpdatePlanAsync_UnknownArtifactTargetRequiresReview()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        fixture.Adapter.StartLocks = new Dictionary<string, ArtifactLock>
        {
            ["app"] = new("image", "sha256:" + new string('c', 64), "ghcr.io/example/notes:1.0.0", null, null, DateTimeOffset.UtcNow),
        };
        await fixture.Service.StartAsync("com.example.notes");
        // Registry unreachable: applying would pull an image nobody could resolve even as a digest.
        fixture.Adapter.RemoteDigest = null;

        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest());

        Assert.Contains(plan.Changes, change => change.EndsWith("->unknown", StringComparison.Ordinal));
        Assert.True(plan.RequiresReview);
    }

    [Fact]
    public async Task CreateUpdatePlanAsync_ImageRepositoryChangeRequiresReview()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var movedRepository = Path.Combine(fixture.Root, "notes-moved-repo.json");
        await File.WriteAllTextAsync(movedRepository, NotesManifestWithImageRepository("1.1.0", "ghcr.io/elsewhere/notes"));

        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(movedRepository));

        // The bytes now come from a different repository: reviewable even though the version bump and
        // tag shape look like an ordinary release.
        Assert.Contains(plan.Changes, change => change.StartsWith("image:", StringComparison.Ordinal));
        Assert.True(plan.RequiresReview);
    }

    [Fact]
    public async Task CreateUpdatePlanAsync_CarriedPortOverrideIsNotAPhantomRemovedSetting()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        // Legacy Core-reserved port override on the record (never manifest-declared); the update
        // carries it forward rather than removing it, so the plan must not report it "removed" —
        // that phantom made the same-version plan review-class forever (apply preserves the key, the
        // next check rebuilds the identical plan, and the Review affordance never converges).
        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        var settings = new Dictionary<string, AppSettingValue>(app!.Settings, StringComparer.Ordinal)
        {
            ["HOSTY_PORT_HTTP"] = new("HOSTY_PORT_HTTP", "number", "7171", Secret: false),
        };
        await fixture.Apps.UpsertAppAsync(app with { Settings = settings });

        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest());

        Assert.Empty(plan.Changes);
        Assert.False(plan.RequiresReview);

        // And the availability verdict agrees: nothing to update, no Review affordance.
        var summary = Assert.Single(await fixture.Service.ListAppsAsync());
        Assert.False(summary.UpdateCheck!.UpdateAvailable);
    }

    [Fact]
    public async Task GetPendingUpdatePlanAsync_ReturnsCachedPlanUntilExpiry()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        Assert.Null((await fixture.Service.GetPendingUpdatePlanAsync("com.example.notes")).Plan);

        var manifestV2 = await fixture.WriteManifestAsync("1.1.0");
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(manifestV2));
        var pending = (await fixture.Service.GetPendingUpdatePlanAsync("com.example.notes")).Plan;
        Assert.Equal(plan.PlanDigest, pending?.PlanDigest);

        // Past the TTL the slot is evicted: clients see "nothing pending" and request a fresh plan.
        fixture.Clock.UtcNow = fixture.Clock.UtcNow.AddHours(2);
        Assert.Null((await fixture.Service.GetPendingUpdatePlanAsync("com.example.notes")).Plan);
    }

    [Fact]
    public async Task GetPendingUpdatePlanAsync_UnknownAppThrows()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.GetPendingUpdatePlanAsync("com.example.missing"));
        Assert.Equal("app_not_found", error.Code);
    }

    [Fact]
    public async Task GetUpdateStatusAsync_ProjectsCachedPlanWithoutReprobing()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        fixture.Adapter.StartLocks = new Dictionary<string, ArtifactLock>
        {
            ["app"] = new("image", "sha256:" + new string('a', 64), "ghcr.io/example/notes:1.0.0", null, null, DateTimeOffset.UtcNow),
        };
        await fixture.Service.StartAsync("com.example.notes");
        var plannedCandidate = "sha256:" + new string('b', 64);
        fixture.Adapter.RemoteDigest = plannedCandidate;
        _ = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest());

        // The registry moves again after the plan was cached: the projection must keep reporting the
        // plan's probe (no network re-check), while refresh=true rebuilds and sees the new candidate.
        var laterCandidate = "sha256:" + new string('e', 64);
        fixture.Adapter.RemoteDigest = laterCandidate;

        var projected = await fixture.Service.GetUpdateStatusAsync("com.example.notes");
        Assert.Equal(plannedCandidate, Assert.Single(projected.Services).CandidateDigest);
        Assert.True(projected.UpdateAvailable);

        var refreshed = await fixture.Service.GetUpdateStatusAsync("com.example.notes", refresh: true);
        Assert.Equal(laterCandidate, Assert.Single(refreshed.Services).CandidateDigest);
    }

    [Fact]
    public async Task GetUpdateStatusAsync_CachesThePlanItBuilds()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        fixture.Adapter.StartLocks = new Dictionary<string, ArtifactLock>
        {
            ["app"] = new("image", "sha256:" + new string('a', 64), "ghcr.io/example/notes:1.0.0", null, null, DateTimeOffset.UtcNow),
        };
        await fixture.Service.StartAsync("com.example.notes");
        fixture.Adapter.RemoteDigest = "sha256:" + new string('b', 64);

        var status = await fixture.Service.GetUpdateStatusAsync("com.example.notes");
        Assert.True(status.UpdateAvailable);

        // The probe built (and cached) the plan a one-click apply consumes by digest.
        var pending = (await fixture.Service.GetPendingUpdatePlanAsync("com.example.notes")).Plan;
        Assert.NotNull(pending);
        Assert.False(pending!.RequiresReview);
    }

    [Fact]
    public async Task GetUpdateStatusAsync_LiveSourceAppFallsBackToLiveProbe()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifestPath = Path.Combine(fixture.Root, "live-app.json");
        await File.WriteAllTextAsync(manifestPath, """
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.live",
              "name": "Live App",
              "version": "1.0.0",
              "runtimeProfiles": [
                { "key": "docker", "type": "docker", "default": true },
                { "key": "local", "type": "localCommand", "development": true }
              ],
              "defaultRuntime": "docker",
              "services": [{
                "key": "app",
                "runtimes": {
                  "docker": { "type": "docker", "image": "ghcr.io/example/live:1.0.0" },
                  "local": { "type": "localCommand", "command": "sleep 5", "workingDirectory": "." }
                }
              }]
            }
            """);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath, SelectedRuntime: "docker"));
        var app = await fixture.Apps.GetAppAsync("com.example.live");
        await fixture.Apps.UpsertAppAsync(app! with { SelectedRuntime = "local" });

        // Plan building refuses live-source apps; the status probe must degrade to the live
        // computation instead of surfacing that refusal.
        var status = await fixture.Service.GetUpdateStatusAsync("com.example.live");

        Assert.Equal("local", status.Runtime);
        Assert.False(status.UpdateAvailable);
        Assert.Null((await fixture.Service.GetPendingUpdatePlanAsync("com.example.live")).Plan);
    }

    [Fact]
    public async Task EnqueueUpdateAsync_ReturnsUpdatingThenFlipsToUpdated()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        // The install source moves to 1.1.0 in place, like a real folder/URL source would.
        File.Copy(await fixture.WriteManifestAsync("1.1.0"), manifest, overwrite: true);
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest());

        var response = await fixture.Service.EnqueueUpdateAsync(
            "com.example.notes",
            new AppUpdateApplyRequest(plan.PlanDigest));

        // The enqueue answers immediately with the persisted in-progress marker.
        Assert.Equal("updating", response.Status);
        Assert.Equal("updating", response.App?.OperationStatus);

        // Awaiting the detached run (test seam) lands the real outcome on the record.
        if (fixture.Service.TryGetRunningBackgroundUpdate("com.example.notes") is { } run)
        {
            await run;
        }

        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal("updated", app!.OperationStatus);
        Assert.Equal("1.1.0", app.Version);
        Assert.Null(app.LastError);

        // The post-apply re-plan settled the row: a fresh verdict against the new base, no update.
        var summary = Assert.Single(await fixture.Service.ListAppsAsync());
        Assert.NotNull(summary.UpdateCheck);
        Assert.False(summary.UpdateCheck!.UpdateAvailable);
    }

    [Fact]
    public async Task EnqueueUpdateAsync_RejectsASecondEnqueueWhileApplying()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        await fixture.Service.StartAsync("com.example.notes");
        var manifestV2 = await fixture.WriteManifestAsync("1.1.0");
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(manifestV2));

        // Hold the apply inside the runtime stop so it is deterministically in flight.
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        fixture.Adapter.StopGate = gate.Task;

        var accepted = await fixture.Service.EnqueueUpdateAsync(
            "com.example.notes",
            new AppUpdateApplyRequest(plan.PlanDigest, manifestV2));
        Assert.Equal("updating", accepted.Status);

        var rejected = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.EnqueueUpdateAsync("com.example.notes", new AppUpdateApplyRequest(plan.PlanDigest, manifestV2)));
        Assert.Equal("update_in_progress", rejected.Code);

        gate.SetResult();
        fixture.Adapter.StopGate = null;
        if (fixture.Service.TryGetRunningBackgroundUpdate("com.example.notes") is { } run)
        {
            await run;
        }

        // The app was running, so the apply restarted it — the post-update start is the last
        // operation on the record; the version proves the update landed.
        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal("started", app!.OperationStatus);
        Assert.Equal("1.1.0", app.Version);
    }

    [Fact]
    public async Task EnqueueUpdateAsync_ValidationErrorsAnswerImmediatelyWithoutMarkingTheRecord()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        // No pending plan at all: the enqueue must not touch the record.
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.EnqueueUpdateAsync("com.example.notes", new AppUpdateApplyRequest("sha256:nope")));
        Assert.Equal("update_plan_expired", error.Code);

        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal("installed", app!.OperationStatus);
        Assert.Null(fixture.Service.TryGetRunningBackgroundUpdate("com.example.notes"));
    }

    [Fact]
    public async Task EnqueueUpdateAsync_BackgroundFailureLandsOnTheRecord()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        await fixture.Service.StartAsync("com.example.notes");
        var manifestV2 = await fixture.WriteManifestAsync("1.1.0");
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(manifestV2));

        // The post-update restart fails (StartCount 1 was the initial start, 2 is the re-start).
        fixture.Adapter.FailOnStartCount = 2;

        _ = await fixture.Service.EnqueueUpdateAsync(
            "com.example.notes",
            new AppUpdateApplyRequest(plan.PlanDigest, manifestV2));
        if (fixture.Service.TryGetRunningBackgroundUpdate("com.example.notes") is { } run)
        {
            await run;
        }

        // With no request left to answer, the outcome lives on the record.
        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal("failed", app!.OperationStatus);
        Assert.Equal("update", app.LastOperation);
        Assert.NotNull(app.LastError);
    }

    [Fact]
    public async Task RecoverInterruptedUpdatesAsync_FlipsStuckUpdatingRecords()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var healthy = await fixture.WriteManifestAsync("1.0.0", id: "com.example.other", name: "Other");
        await fixture.Service.InstallAsync(new AppInstallRequest(healthy));

        // Simulate a Core stop mid-apply: the record was left marked "updating".
        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        await fixture.Apps.UpsertAppAsync(app! with { OperationStatus = "updating", LastOperation = "update" });

        var recovered = await fixture.Service.RecoverInterruptedUpdatesAsync();

        Assert.Equal(1, recovered);
        var flipped = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal("failed", flipped!.OperationStatus);
        Assert.Contains("interrupted", flipped.LastError, StringComparison.OrdinalIgnoreCase);

        // The untouched app is left alone, and a second sweep finds nothing.
        Assert.Equal("installed", (await fixture.Apps.GetAppAsync("com.example.other"))!.OperationStatus);
        Assert.Equal(0, await fixture.Service.RecoverInterruptedUpdatesAsync());
    }

    [Fact]
    public async Task RecoverInterruptedUpdatesAsync_LeavesAnInFlightBackgroundUpdateAlone()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        await fixture.Service.StartAsync("com.example.notes");
        File.Copy(await fixture.WriteManifestAsync("1.1.0"), manifest, overwrite: true);
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest());

        // A legitimate background apply is in flight (held inside the runtime stop) — its record is
        // marked "updating", but its single-flight slot must shield it from the boot sweep.
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        fixture.Adapter.StopGate = gate.Task;
        _ = await fixture.Service.EnqueueUpdateAsync("com.example.notes", new AppUpdateApplyRequest(plan.PlanDigest));

        Assert.Equal(0, await fixture.Service.RecoverInterruptedUpdatesAsync());
        Assert.Equal("updating", (await fixture.Apps.GetAppAsync("com.example.notes"))!.OperationStatus);

        gate.SetResult();
        fixture.Adapter.StopGate = null;
        if (fixture.Service.TryGetRunningBackgroundUpdate("com.example.notes") is { } run)
        {
            await run;
        }

        Assert.Equal("1.1.0", (await fixture.Apps.GetAppAsync("com.example.notes"))!.Version);
    }

    [Fact]
    public async Task UpdateAvailabilityProjection_FollowsPlanBuildAndApply()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        // No check has run yet: the summary carries no verdict.
        Assert.Null(Assert.Single(await fixture.Service.ListAppsAsync()).UpdateCheck);

        var manifestV2 = await fixture.WriteManifestAsync("1.1.0");
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(manifestV2));

        // Any successful plan build refreshes the projection the apps list renders from.
        var checkedSummary = Assert.Single(await fixture.Service.ListAppsAsync());
        Assert.NotNull(checkedSummary.UpdateCheck);
        Assert.True(checkedSummary.UpdateCheck!.UpdateAvailable);
        Assert.False(checkedSummary.UpdateCheck.RequiresReview);
        Assert.Equal(plan.PlanDigest, checkedSummary.UpdateCheck.PlanDigest);

        await fixture.Service.ApplyUpdateAsync(
            "com.example.notes",
            new AppUpdateApplyRequest(plan.PlanDigest, manifestV2));

        // The apply consumed the plan: the verdict is cleared until the next check re-establishes it.
        Assert.Null(Assert.Single(await fixture.Service.ListAppsAsync()).UpdateCheck);
    }

    private static string NotesManifestWithImageRepository(string version, string imageRepository) => $$"""
        {
          "schemaVersion": "app.0.1",
          "id": "com.example.notes",
          "name": "Notes",
          "description": "Personal notes.",
          "version": "{{version}}",
          "runtimeProfiles": [{ "key": "docker", "type": "docker", "default": true }],
          "defaultRuntime": "docker",
          "services": [{
            "key": "app",
            "runtimes": {
              "docker": {
                "type": "docker",
                "image": "{{imageRepository}}:{{version}}",
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
        """;

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
        // Both checkout locations: the current default inside the app root and the legacy
        // top-level sources tree a pre-move install may still occupy.
        var sourcePath = Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "source");
        Directory.CreateDirectory(sourcePath);
        await File.WriteAllTextAsync(Path.Combine(sourcePath, "README.md"), "source");
        var legacySourcePath = Path.Combine(fixture.Paths.SourcesRoot, "com.example.notes");
        Directory.CreateDirectory(legacySourcePath);
        await File.WriteAllTextAsync(Path.Combine(legacySourcePath, "README.md"), "legacy-source");
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
        Assert.False(Directory.Exists(legacySourcePath));
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
        Assert.True(Directory.Exists(Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "source", ".git")));
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
        // The folder's commit is recorded as the override's own, never as the reviewed pin.
        Assert.Equal("abc123", app?.SourceState?.OverrideCommit);
        Assert.Null(app?.SourceState?.Commit);
        Assert.Equal(repository, app?.SourceState?.Repository);
    }

    [Fact]
    public async Task EnsurePinnedCommit_ChecksOutCommitAndHoldsWhenTheBranchAdvances()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var repository = await CreateLocalCommandGitRepositoryAsync(fixture.Root);
        var commit1 = await RunGitAsync(repository, ["rev-parse", "HEAD"]);
        var manifest = await fixture.WriteManifestAsync("1.0.0", sourceRepository: repository);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        // A locked (Development Mode off) source runtime pins the reviewed commit into the managed
        // checkout (detached), so the working tree is the exact reviewed source, not the branch tip.
        var pinned = await fixture.Sources.EnsurePinnedCommitAsync("com.example.notes");
        var checkout = Assert.IsType<string>(pinned.Source?.ManagedCheckoutPath);
        Assert.Equal(commit1, pinned.Source?.Commit);
        Assert.Equal(commit1, await RunGitAsync(checkout, ["rev-parse", "HEAD"]));

        // The upstream branch advances; the lock must hold — a re-pin keeps the same commit checked out
        // until a reviewed source-resolve/update advances it.
        await File.WriteAllTextAsync(Path.Combine(repository, "advance.txt"), "v2");
        _ = await RunGitAsync(repository, ["add", "advance.txt"]);
        _ = await RunGitAsync(repository, ["-c", "user.name=Hosty Test", "-c", "user.email=hosty@example.test", "commit", "-m", "Advance"]);
        var commit2 = await RunGitAsync(repository, ["rev-parse", "HEAD"]);
        Assert.NotEqual(commit1, commit2);

        var repinned = await fixture.Sources.EnsurePinnedCommitAsync("com.example.notes");
        Assert.Equal(commit1, repinned.Source?.Commit);
        Assert.Equal(commit1, await RunGitAsync(checkout, ["rev-parse", "HEAD"]));
    }

    [Fact]
    public async Task EnsurePinnedCommit_ForcesCleanWorkingTreeAndIgnoresOverrideCommit()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var repository = await CreateLocalCommandGitRepositoryAsync(fixture.Root);
        var reviewedCommit = await RunGitAsync(repository, ["rev-parse", "HEAD"]);
        var manifest = await fixture.WriteManifestAsync("1.0.0", sourceRepository: repository);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var pinned = await fixture.Sources.EnsurePinnedCommitAsync("com.example.notes");
        var checkout = Assert.IsType<string>(pinned.Source?.ManagedCheckoutPath);

        // Simulate a prior live run leaving the checkout dirty: an edited tracked file and a stray untracked
        // file.
        var trackedFile = Path.Combine(checkout, "apps", "remote-app", "README.md");
        await File.WriteAllTextAsync(trackedFile, "locally edited");
        await File.WriteAllTextAsync(Path.Combine(checkout, "stray.txt"), "untracked");

        // The operator configures a live override, which records that folder's commit as the override's
        // own — the reviewed pin must not move.
        var overrideRepository = await CreateGitRepositoryAsync(fixture.Root);
        await fixture.Sources.SetLocalOverrideAsync("com.example.notes", new AppSourceOverrideRequest(overrideRepository));
        var afterOverride = (await fixture.Apps.GetAppAsync("com.example.notes"))?.SourceState;
        Assert.NotEqual(reviewedCommit, afterOverride?.OverrideCommit);
        Assert.Equal(reviewedCommit, afterOverride?.Commit);

        // Re-pin (Dev Mode off): the reviewed commit is restored with a clean working tree, ignoring the
        // override's commit.
        var repinned = await fixture.Sources.EnsurePinnedCommitAsync("com.example.notes");
        Assert.Equal(reviewedCommit, repinned.Source?.Commit);
        Assert.Equal(reviewedCommit, await RunGitAsync(checkout, ["rev-parse", "HEAD"]));
        Assert.Equal("remote local command app", (await File.ReadAllTextAsync(trackedFile)).Trim());
        Assert.False(File.Exists(Path.Combine(checkout, "stray.txt")));
    }

    [Fact]
    public async Task EnsurePinnedCommit_KeepsAReviewedUpdatesCommitWhenAnOverrideIsConfigured()
    {
        // A configured override used to force a re-resolve of the recorded ref on every pinned start,
        // which threw away the commit a reviewed update had just stamped and re-pinned the checkout to
        // `origin/{ref}` as of its last fetch. The app then ran the old code while the update check kept
        // re-offering the same update — an "update available" badge that survived its own update.
        var fixture = await LifecycleFixture.CreateAsync();
        var repository = await CreateLocalCommandGitRepositoryAsync(fixture.Root);
        var manifest = await fixture.WriteManifestAsync("1.0.0", sourceRepository: repository);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var first = await fixture.Sources.EnsurePinnedCommitAsync("com.example.notes");
        var checkout = Assert.IsType<string>(first.Source?.ManagedCheckoutPath);
        var overrideRepository = await CreateGitRepositoryAsync(fixture.Root);
        await fixture.Sources.SetLocalOverrideAsync("com.example.notes", new AppSourceOverrideRequest(overrideRepository));

        // Upstream advances and a reviewed update stamps the new commit (the checkout has not fetched it).
        await File.WriteAllTextAsync(Path.Combine(repository, "advance.txt"), "v2");
        _ = await RunGitAsync(repository, ["add", "advance.txt"]);
        _ = await RunGitAsync(repository, ["-c", "user.name=Hosty Test", "-c", "user.email=hosty@example.test", "commit", "-m", "Advance"]);
        var commit2 = await RunGitAsync(repository, ["rev-parse", "HEAD"]);
        var record = await fixture.Apps.GetAppAsync("com.example.notes");
        await fixture.Apps.UpsertAppAsync(record! with { SourceState = record.SourceState! with { Commit = commit2 } });

        var repinned = await fixture.Sources.EnsurePinnedCommitAsync("com.example.notes");

        Assert.Equal(commit2, repinned.Source?.Commit);
        Assert.Equal(commit2, await RunGitAsync(checkout, ["rev-parse", "HEAD"]));
    }

    [Fact]
    public async Task EnsurePinnedCommit_FallsBackToTheReviewedRefWhenTheRecordedCommitIsUnreachable()
    {
        // Records written before the override kept its own commit field carry a foreign repository's
        // commit in the pin; a force-pushed branch can also drop one upstream. Neither may wedge every
        // start of the app: the pin falls back to the reviewed ref and the record self-heals.
        var fixture = await LifecycleFixture.CreateAsync();
        var repository = await CreateLocalCommandGitRepositoryAsync(fixture.Root);
        var manifest = await fixture.WriteManifestAsync("1.0.0", sourceRepository: repository);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var first = await fixture.Sources.EnsurePinnedCommitAsync("com.example.notes");
        var checkout = Assert.IsType<string>(first.Source?.ManagedCheckoutPath);
        var reviewedCommit = Assert.IsType<string>(first.Source?.Commit);

        var foreignRepository = await CreateGitRepositoryAsync(fixture.Root);
        var foreignCommit = await RunGitAsync(foreignRepository, ["rev-parse", "HEAD"]);
        var record = await fixture.Apps.GetAppAsync("com.example.notes");
        await fixture.Apps.UpsertAppAsync(record! with { SourceState = record.SourceState! with { Commit = foreignCommit } });

        var repinned = await fixture.Sources.EnsurePinnedCommitAsync("com.example.notes");

        Assert.Equal(reviewedCommit, repinned.Source?.Commit);
        Assert.Equal(reviewedCommit, await RunGitAsync(checkout, ["rev-parse", "HEAD"]));
    }

    [Fact]
    public async Task EnsurePinnedCommit_FetchesWhenReviewedUpdateAdvancesToAnUnfetchedCommit()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var repository = await CreateLocalCommandGitRepositoryAsync(fixture.Root);
        var manifest = await fixture.WriteManifestAsync("1.0.0", sourceRepository: repository);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        // First pin clones the checkout at commit1 (the branch tip at clone time).
        var first = await fixture.Sources.EnsurePinnedCommitAsync("com.example.notes");
        var checkout = Assert.IsType<string>(first.Source?.ManagedCheckoutPath);

        // The upstream repo advances and a reviewed update records the new commit, which is not yet in the
        // local clone (the checkout was never fetched).
        await File.WriteAllTextAsync(Path.Combine(repository, "advance.txt"), "v2");
        _ = await RunGitAsync(repository, ["add", "advance.txt"]);
        _ = await RunGitAsync(repository, ["-c", "user.name=Hosty Test", "-c", "user.email=hosty@example.test", "commit", "-m", "Advance"]);
        var commit2 = await RunGitAsync(repository, ["rev-parse", "HEAD"]);
        // Record the advanced commit as the reviewed pin (no override, so it is honored, not re-resolved).
        var record = await fixture.Apps.GetAppAsync("com.example.notes");
        await fixture.Apps.UpsertAppAsync(record! with { SourceState = record.SourceState! with { Commit = commit2, LocalOverridePath = null } });

        // The pinned commit is missing locally, so EnsurePinnedCommit fetches and checks it out — the lock
        // advances (only) via the reviewed commit.
        var advanced = await fixture.Sources.EnsurePinnedCommitAsync("com.example.notes");
        Assert.Equal(commit2, advanced.Source?.Commit);
        Assert.Equal(commit2, await RunGitAsync(checkout, ["rev-parse", "HEAD"]));
    }

    [Fact]
    public async Task ResolveManagedAsync_BranchFetchResolvesTheMovedOriginTip_NotTheStaleLocalBranch()
    {
        // `git fetch` advances refs/remotes/origin/* but never the clone-time local branch, so a
        // branch resolve that preferred refs/heads/{branch} returned the clone-time tip forever — a
        // reviewed source-resolve with fetch could never advance a branch-pinned app.
        var fixture = await LifecycleFixture.CreateAsync();
        var repository = await CreateGitRepositoryAsync(fixture.Root);
        var commit1 = await RunGitAsync(repository, ["rev-parse", "HEAD"]);
        var manifest = await fixture.WriteManifestAsync("1.0.0", sourceRepository: repository);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var first = await fixture.Sources.ResolveManagedAsync("com.example.notes", new AppSourceResolveRequest(Branch: "main"));
        Assert.Equal(commit1, first.Source?.Commit);

        // Upstream advances after the clone.
        await File.WriteAllTextAsync(Path.Combine(repository, "advance.txt"), "v2");
        _ = await RunGitAsync(repository, ["add", "advance.txt"]);
        _ = await RunGitAsync(repository, ["-c", "user.name=Hosty Test", "-c", "user.email=hosty@example.test", "commit", "-m", "Advance"]);
        var commit2 = await RunGitAsync(repository, ["rev-parse", "HEAD"]);

        var resolved = await fixture.Sources.ResolveManagedAsync(
            "com.example.notes",
            new AppSourceResolveRequest(Branch: "main", Fetch: true));

        Assert.Equal(commit2, resolved.Source?.Commit);
    }

    [Fact]
    public async Task ResolveManagedAsync_FetchSurvivesAChannelTagThatMovedUpstream()
    {
        // Source repositories carry moving channel tags (CI re-points this repo's own `cli-dev`), and an
        // unforced `git fetch --tags` *rejects* such an update ("would clobber existing tag") and exits
        // non-zero. That failed the whole resolve — and with it every source-backed app update — even
        // though the app's own branch had fetched fine.
        var fixture = await LifecycleFixture.CreateAsync();
        var repository = await CreateGitRepositoryAsync(fixture.Root);
        _ = await RunGitAsync(repository, ["tag", "-f", "channel-dev"]);
        var manifest = await fixture.WriteManifestAsync("1.0.0", sourceRepository: repository);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        // The clone copies the tag at its current commit.
        var first = await fixture.Sources.ResolveManagedAsync("com.example.notes", new AppSourceResolveRequest(Branch: "main"));
        var checkout = Assert.IsType<string>(first.Source?.ManagedCheckoutPath);

        // Upstream advances and the channel tag is re-pointed at the new commit.
        await File.WriteAllTextAsync(Path.Combine(repository, "advance.txt"), "v2");
        _ = await RunGitAsync(repository, ["add", "advance.txt"]);
        _ = await RunGitAsync(repository, ["-c", "user.name=Hosty Test", "-c", "user.email=hosty@example.test", "commit", "-m", "Advance"]);
        var commit2 = await RunGitAsync(repository, ["rev-parse", "HEAD"]);
        _ = await RunGitAsync(repository, ["tag", "-f", "channel-dev"]);

        var resolved = await fixture.Sources.ResolveManagedAsync(
            "com.example.notes",
            new AppSourceResolveRequest(Branch: "main", Fetch: true));

        Assert.Equal(commit2, resolved.Source?.Commit);
        Assert.Equal(commit2, await RunGitAsync(checkout, ["rev-parse", "refs/tags/channel-dev^{commit}"]));
    }

    [Fact]
    public async Task EnsurePinnedCommit_ReResolvesABranchRefFromOrigin_NotTheStaleLocalBranch()
    {
        // The re-resolve path (no recorded commit) resolves the recorded ref against the checkout,
        // and a stale local branch resolves "successfully" — the fetch-retry only fires on failure —
        // so the pin stuck at the clone-time tip even after the checkout had fetched the moved branch.
        var fixture = await LifecycleFixture.CreateAsync();
        var repository = await CreateLocalCommandGitRepositoryAsync(fixture.Root);
        var manifest = await fixture.WriteManifestAsync("1.0.0", sourceRepository: repository);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var first = await fixture.Sources.EnsurePinnedCommitAsync("com.example.notes");
        var checkout = Assert.IsType<string>(first.Source?.ManagedCheckoutPath);

        // The branch moves upstream and the checkout has fetched it (a reviewed operation fetches),
        // but the recorded pin is unset (e.g. the manifest ref changed and BuildSourceState reset it).
        await File.WriteAllTextAsync(Path.Combine(repository, "advance.txt"), "v2");
        _ = await RunGitAsync(repository, ["add", "advance.txt"]);
        _ = await RunGitAsync(repository, ["-c", "user.name=Hosty Test", "-c", "user.email=hosty@example.test", "commit", "-m", "Advance"]);
        var commit2 = await RunGitAsync(repository, ["rev-parse", "HEAD"]);
        _ = await RunGitAsync(checkout, ["fetch", "--all", "--tags", "--prune"]);
        var record = await fixture.Apps.GetAppAsync("com.example.notes");
        await fixture.Apps.UpsertAppAsync(record! with { SourceState = record.SourceState! with { Commit = null } });

        var repinned = await fixture.Sources.EnsurePinnedCommitAsync("com.example.notes");

        Assert.Equal(commit2, repinned.Source?.Commit);
        Assert.Equal(commit2, await RunGitAsync(checkout, ["rev-parse", "HEAD"]));
    }

    [Fact]
    public async Task ResolveManifestCommitAsync_ResolvesRefsWithoutMaterializingACheckout()
    {
        // The update sweep builds a plan for every app, so the source probe must stay a lightweight
        // remote lookup: cloning/fetching per app would populate disk with checkouts for apps that
        // were never started and pay a full fetch on every routine update check. The pinned checkout
        // is materialized at start instead (EnsurePinnedCommitAsync, which fetch-and-retries for a
        // commit the clone has not seen yet).
        var fixture = await LifecycleFixture.CreateAsync();
        var repository = await CreateGitRepositoryAsync(fixture.Root);
        var branchCommit = await RunGitAsync(repository, ["rev-parse", "HEAD"]);
        // An *annotated* tag: the tag object has its own id, so a naive lookup pins the tag rather
        // than the commit it points at.
        _ = await RunGitAsync(repository, ["-c", "user.name=Hosty Test", "-c", "user.email=hosty@example.test", "tag", "-a", "v1", "-m", "Release 1"]);
        var checkoutPath = Path.Combine(fixture.Paths.SourcesRoot, "com.example.notes");

        var byBranch = await fixture.Sources.ResolveManifestCommitAsync(
            new RuntimeAppSource("git", repository, "main", null, null));
        var byTag = await fixture.Sources.ResolveManifestCommitAsync(
            new RuntimeAppSource("git", repository, null, "v1", null));
        var byCommit = await fixture.Sources.ResolveManifestCommitAsync(
            new RuntimeAppSource("git", repository, null, null, branchCommit));

        Assert.Equal(branchCommit, byBranch);
        // Peeled to the commit, not the annotated tag object.
        Assert.Equal(branchCommit, byTag);
        Assert.Equal(branchCommit, byCommit);
        Assert.False(Directory.Exists(checkoutPath));
    }

    [Fact]
    public async Task ResolveManifestCommitAsync_ReportsARefMissingFromTheRepository()
    {
        // `git ls-remote` exits 0 with empty output for a ref that does not exist, so an unmatched
        // lookup must be turned into an explicit failure rather than resolving to nothing.
        var fixture = await LifecycleFixture.CreateAsync();
        var repository = await CreateGitRepositoryAsync(fixture.Root);

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Sources.ResolveManifestCommitAsync(new RuntimeAppSource("git", repository, "no-such-branch", null, null)));

        Assert.Equal("source_ref_not_found", error.Code);
    }

    [Fact]
    public async Task ApplyUpdateAsync_AdvancesTheSourcePinWhenTheBranchTipMoved()
    {
        // The "ghost version" defect: a reviewed update of a URL-installed source app saved the new
        // manifest but left SourceState.Commit at the old pin (BuildSourceState keeps it while the
        // manifest ref stays "main"), so the next start force-checked-out the old commit — the app
        // showed the new version while running the old code. The reviewed update must surface the
        // commit movement in the plan and move the pin to exactly the reviewed commit on apply.
        const string manifestUrl = "https://apps.example.test/remote-local/manifest.json";
        string? repository = null;
        var manifestVersion = "1.0.0";
        var manifests = new AppManifestService(new HttpClient(new StubHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(CreateRemoteLocalCommandManifestJson(repository!, manifestVersion), Encoding.UTF8, "application/json"),
        })));
        var fixture = await LifecycleFixture.CreateAsync(manifests);
        repository = await CreateLocalCommandGitRepositoryAsync(fixture.Root);
        var commit1 = await RunGitAsync(repository, ["rev-parse", "HEAD"]);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestUrl, SelectedRuntime: "dev"));

        // First start-equivalent: pin the reviewed commit into the managed checkout.
        var pinned = await fixture.Sources.EnsurePinnedCommitAsync("com.example.remote-local");
        var checkout = Assert.IsType<string>(pinned.Source?.ManagedCheckoutPath);
        Assert.Equal(commit1, pinned.Source?.Commit);

        // Upstream releases: the branch tip moves and the published manifest bumps its version.
        await File.WriteAllTextAsync(Path.Combine(repository, "advance.txt"), "v2");
        _ = await RunGitAsync(repository, ["add", "advance.txt"]);
        _ = await RunGitAsync(repository, ["-c", "user.name=Hosty Test", "-c", "user.email=hosty@example.test", "commit", "-m", "Advance"]);
        var commit2 = await RunGitAsync(repository, ["rev-parse", "HEAD"]);
        manifestVersion = "1.1.0";

        // The plan surfaces the current→new commit pair for review, like image digests for docker apps.
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.remote-local", new AppUpdatePlanRequest());
        Assert.Contains($"source:{commit1}->{commit2}", plan.Changes);

        var result = await fixture.Service.ApplyUpdateAsync("com.example.remote-local", new AppUpdateApplyRequest(plan.PlanDigest));
        var app = await fixture.Apps.GetAppAsync("com.example.remote-local");
        Assert.Equal("1.1.0", result.App?.Version);
        Assert.Equal(commit2, app?.SourceState?.Commit);

        // The next start pins the checkout to the advanced commit — the running code moves with the
        // update instead of staying at the old tip.
        _ = await fixture.Sources.EnsurePinnedCommitAsync("com.example.remote-local");
        Assert.Equal(commit2, await RunGitAsync(checkout, ["rev-parse", "HEAD"]));
    }

    [Fact]
    public async Task InstallAsync_DerivesManifestSubpathFromRawManifestUrl()
    {
        const string manifestUrl = "https://raw.githubusercontent.com/acme/monorepo/main/apps/web/manifest.json";
        var manifests = new AppManifestService(new HttpClient(new StubHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("""
                {
                  "schemaVersion": "app.0.1",
                  "id": "com.example.web",
                  "name": "Web App",
                  "version": "1.0.0",
                  "source": { "type": "git", "repository": "https://github.com/acme/monorepo.git", "branch": "main" },
                  "runtimeProfiles": [
                    { "key": "docker", "type": "docker", "default": true },
                    { "key": "dev", "type": "localCommand", "development": true }
                  ],
                  "defaultRuntime": "docker",
                  "services": [{
                    "key": "app",
                    "runtimes": {
                      "docker": { "type": "docker", "image": "ghcr.io/acme/web:1.0.0" },
                      "dev": { "type": "localCommand", "command": "npm run dev", "workingDirectory": "apps/web" }
                    }
                  }]
                }
                """, Encoding.UTF8, "application/json"),
        })));
        var fixture = await LifecycleFixture.CreateAsync(manifests);

        await fixture.Service.InstallAsync(new AppInstallRequest(manifestUrl, SelectedRuntime: "docker"));

        // Anchored on the repository owner/repo (acme/monorepo) with the ref (main) stripped, the manifest
        // URL yields the in-repo directory apps/web so a live checkout can find <checkout>/apps/web.
        var app = await fixture.Apps.GetAppAsync("com.example.web");
        Assert.Equal("apps/web", app?.SourceState?.ManifestSubpath);
    }

    [Fact]
    public async Task InstallAsync_LeavesManifestSubpathNullForRootManifestWithMultiSegmentRef()
    {
        // A multi-segment ref (branch "release/1.0") with the manifest at the repo root: the ref segments
        // consume the entire in-repo path, so the subpath is null (not "1.0"). See StripRefPrefix.
        const string manifestUrl = "https://raw.githubusercontent.com/acme/monorepo/release/1.0/manifest.json";
        var manifests = new AppManifestService(new HttpClient(new StubHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("""
                {
                  "schemaVersion": "app.0.1",
                  "id": "com.example.web",
                  "name": "Web App",
                  "version": "1.0.0",
                  "source": { "type": "git", "repository": "https://github.com/acme/monorepo.git", "branch": "release/1.0" },
                  "runtimeProfiles": [{ "key": "docker", "type": "docker", "default": true }],
                  "defaultRuntime": "docker",
                  "services": [{ "key": "app", "runtimes": { "docker": { "type": "docker", "image": "ghcr.io/acme/web:1.0.0" } } }]
                }
                """, Encoding.UTF8, "application/json"),
        })));
        var fixture = await LifecycleFixture.CreateAsync(manifests);

        await fixture.Service.InstallAsync(new AppInstallRequest(manifestUrl, SelectedRuntime: "docker"));

        var app = await fixture.Apps.GetAppAsync("com.example.web");
        Assert.Null(app?.SourceState?.ManifestSubpath);
    }

    [Fact]
    public async Task InstallAsync_LeavesManifestSubpathNullForRootManifest()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var repositoryRoot = Path.Combine(fixture.Root, "root-repo");
        Directory.CreateDirectory(Path.Combine(repositoryRoot, ".git"));
        var manifestPath = Path.Combine(repositoryRoot, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, CreateLocalCommandFolderManifestJson("1.0.0"));

        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath, SelectedRuntime: "dev"));

        // Manifest at the repo root ⇒ no subpath (reads <root>/manifest.json, the pre-existing behavior).
        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal(Path.GetFullPath(repositoryRoot), app?.SourceState?.LocalOverridePath);
        Assert.Null(app?.SourceState?.ManifestSubpath);
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
        // The source root is the repo root; the manifest sits one app subtree in — captured so the live
        // manifest read targets <root>/apps/demo-app/manifest.json.
        Assert.Equal("apps/demo-app", app?.SourceState?.ManifestSubpath);

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
    public async Task ConfigureAsync_ProviderNone_LetsTheOperatorOwnThePublicOrigin()
    {
        // With ingress off the operator owns exposure, so the free-form origin is theirs to set.
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));

        await fixture.Service.ConfigureAsync("com.example.notes", new AppConfigureRequest(
            Settings: new Dictionary<string, string?> { ["HOSTY_PUBLIC_ORIGIN_APP_HTTP"] = "https://notes.example.com" }));

        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal("https://notes.example.com", app!.Settings["HOSTY_PUBLIC_ORIGIN_APP_HTTP"].Value);
    }

    [Fact]
    public async Task ConfigureAsync_LocalConfigProvider_RefusesToWriteADerivedPublicOrigin()
    {
        // The local provider re-derives this value on every start, so accepting the write would store a
        // URL that silently reverts — one of the two ways the origin used to diverge from reality.
        var fixture = await LifecycleFixture.CreateAsync(ingressBaseDomain: "apps.example.test");
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.ConfigureAsync("com.example.notes", new AppConfigureRequest(
                Settings: new Dictionary<string, string?> { ["HOSTY_PUBLIC_ORIGIN_APP_HTTP"] = "https://notes.example.com" })));

        Assert.Equal("public_origin_managed", error.Code);
    }

    [Fact]
    public async Task ConfigureAsync_ManagedOrigin_AcceptsAnUnchangedResend()
    {
        // A settings form resends every field. Refusing an unchanged managed value would make every
        // other setting on that page unsavable.
        var fixture = await LifecycleFixture.CreateAsync(ingressBaseDomain: "apps.example.test");
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        await fixture.Service.StartAsync("com.example.notes");
        var derived = (await fixture.Apps.GetAppAsync("com.example.notes"))!.Settings["HOSTY_PUBLIC_ORIGIN_APP_HTTP"].Value;

        await fixture.Service.ConfigureAsync("com.example.notes", new AppConfigureRequest(
            Settings: new Dictionary<string, string?>
            {
                ["HOSTY_PUBLIC_ORIGIN_APP_HTTP"] = derived,
                ["APP_MODE"] = "staging",
            }));

        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal("staging", app!.Settings["APP_MODE"].Value);
    }

    [Fact]
    public async Task ConfigureAsync_ManagedOriginWithNoValueYet_AcceptsTheFormsBlank()
    {
        // The settings form posts "" for a public origin that has none yet, which is every derived origin
        // before the app's first start. Counting blank-for-unset as a change would make the whole form
        // unsavable on a host with ingress on.
        var fixture = await LifecycleFixture.CreateAsync(ingressBaseDomain: "apps.example.test");
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));

        await fixture.Service.ConfigureAsync("com.example.notes", new AppConfigureRequest(
            Settings: new Dictionary<string, string?>
            {
                ["HOSTY_PUBLIC_ORIGIN_APP_HTTP"] = "",
                ["APP_MODE"] = "staging",
            }));

        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal("staging", app!.Settings["APP_MODE"].Value);
    }

    [Fact]
    public async Task ConfigureAsync_ApiProvider_RefusesOnlyPublishedOrigins()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.CoreSettings.UpdateAsync(new Dictionary<string, string?>
        {
            ["HOSTY_INGRESS_PROVIDER"] = IngressSettings.ProviderCloudflareRemote,
        });
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));

        // Not published yet: the operator may still front this endpoint with their own proxy.
        await fixture.Service.ConfigureAsync("com.example.notes", new AppConfigureRequest(
            Settings: new Dictionary<string, string?> { ["HOSTY_PUBLIC_ORIGIN_APP_HTTP"] = "https://notes.example.com" }));

        await fixture.Publications.UpsertAsync(new CloudflarePublication(
            "com.example.notes", "app.http", "notes", "notes.example.test", "dns-1", "http://127.0.0.1:3000",
            CloudflareOwnershipStates.Owned, DateTimeOffset.UnixEpoch));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.ConfigureAsync("com.example.notes", new AppConfigureRequest(
                Settings: new Dictionary<string, string?> { ["HOSTY_PUBLIC_ORIGIN_APP_HTTP"] = "https://elsewhere.example.com" })));

        Assert.Equal("public_origin_managed", error.Code);
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
        })));
        var fixture = await LifecycleFixture.CreateAsync(manifests);
        repository = await CreateLocalCommandGitRepositoryAsync(fixture.Root);

        await fixture.Service.InstallAsync(new AppInstallRequest(manifestUrl, SelectedRuntime: "dev"));

        try
        {
            var start = await fixture.Service.StartAsync("com.example.remote-local");
            var app = await fixture.Apps.GetAppAsync("com.example.remote-local");
            var managedCheckoutPath = Path.Combine(fixture.Paths.AppsRoot, "com.example.remote-local", "source");
            var cwdPath = Path.Combine(fixture.Paths.AppsRoot, "com.example.remote-local", "data", "cwd.txt");

            Assert.Equal("running", start.App?.RuntimeState);
            Assert.Equal(manifestUrl, app?.ManifestUrl);
            Assert.Equal(repository, app?.SourceState?.Repository);
            Assert.Null(app?.SourceState?.LocalOverridePath);
            Assert.True(Directory.Exists(Path.Combine(managedCheckoutPath, ".git")));
            Assert.True(File.Exists(cwdPath));
            var serviceWorkingDirectory = (await File.ReadAllTextAsync(cwdPath)).Trim();
            Assert.EndsWith(
                $"{Path.DirectorySeparatorChar}com.example.remote-local{Path.DirectorySeparatorChar}source{Path.DirectorySeparatorChar}apps{Path.DirectorySeparatorChar}remote-app",
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
        })));
        var fixture = await LifecycleFixture.CreateAsync(manifests);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestUrl, SelectedRuntime: "dev"));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.StartAsync("com.example.remote-local"));

        Assert.Equal("source_repository_relative_remote_unsupported", error.Code);
    }

    [Fact]
    public async Task InstallAsync_AllowsRemoteManifestLocalCommandRuntime()
    {
        // A remotely-fetched manifest may select a localCommand runtime (it runs a host command). This is
        // no longer blocked in Core; the operator is warned in the install UI that it runs at their own
        // risk. See the marketplace install-review dialog for the warning.
        const string manifestUrl = "https://apps.example.test/remote-local/manifest.json";
        var manifests = new AppManifestService(new HttpClient(new StubHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(CreateRemoteLocalCommandManifestJson("."), Encoding.UTF8, "application/json"),
        })));
        var fixture = await LifecycleFixture.CreateAsync(manifests);

        await fixture.Service.InstallAsync(new AppInstallRequest(manifestUrl, SelectedRuntime: "dev"));

        var app = await fixture.Apps.GetAppAsync("com.example.remote-local");
        Assert.Equal("dev", app?.SelectedRuntime);
        Assert.Equal(manifestUrl, app?.ManifestUrl);
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

    [Fact]
    public async Task ConfigureMountsAsync_GlobalRefPersistsBindingAndSurfacesSource()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: RequiredCatalogMountsJson);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var host = CreateExternalDirectory();
        await fixture.CreateGlobalMountService().UpsertAsync(new GlobalMountUpsertRequest("media", host));

        await fixture.Service.ConfigureMountsAsync(
            "com.example.notes",
            new AppMountsRequest([new AppMountBindingInput("catalogRoots", GlobalMountName: "media")]));

        var summary = (await fixture.Service.ListAppsAsync()).Single();
        var binding = Assert.Single(summary.Mounts.Single().Bindings);
        Assert.Equal("media", binding.Label);
        Assert.Equal("global", binding.Source);
        Assert.Equal("media", binding.GlobalMountName);
        Assert.Equal(Path.GetFullPath(host), binding.HostPath);
        Assert.Equal("/mnt/catalogRoots/media", binding.ContainerPath);
    }

    [Fact]
    public async Task ConfigureMountsAsync_RejectsUnknownGlobalRef()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: RequiredCatalogMountsJson);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.ConfigureMountsAsync(
                "com.example.notes",
                new AppMountsRequest([new AppMountBindingInput("catalogRoots", GlobalMountName: "ghost")])));

        Assert.Equal("global_mount_not_found", error.Code);
    }

    [Fact]
    public async Task StartAsync_ResolvesGlobalRefHostPathLiveFromLibrary()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: RequiredCatalogMountsJson);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var host = CreateExternalDirectory();
        var library = fixture.CreateGlobalMountService();
        await library.UpsertAsync(new GlobalMountUpsertRequest("media", host));
        await fixture.Service.ConfigureMountsAsync(
            "com.example.notes",
            new AppMountsRequest([new AppMountBindingInput("catalogRoots", GlobalMountName: "media")]));

        await fixture.Service.StartAsync("com.example.notes");

        var mount = Assert.Single(fixture.Adapter.LastContext!.Mounts);
        // The start gate binds the fully-resolved real path (C-H3), so the docker adapter mounts the
        // exact location Core validated rather than a path it would re-traverse through a symlink.
        Assert.Equal(MountPathPolicy.ResolveRealPath(host), mount.HostPath);
        Assert.Equal("/mnt/catalogRoots/media", mount.ContainerPath);
    }

    [Fact]
    public async Task StartAsync_RequiredSlotFailsWhenReferencedGlobalDeleted()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: RequiredCatalogMountsJson);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var host = CreateExternalDirectory();
        var library = fixture.CreateGlobalMountService();
        await library.UpsertAsync(new GlobalMountUpsertRequest("media", host));
        await fixture.Service.ConfigureMountsAsync(
            "com.example.notes",
            new AppMountsRequest([new AppMountBindingInput("catalogRoots", GlobalMountName: "media")]));

        // Force-delete the library entry: the binding becomes inert, leaving the required slot empty.
        await library.DeleteAsync("media", force: true);

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.StartAsync("com.example.notes"));

        Assert.Equal("app_mount_required_unconfigured", error.Code);
    }

    [Fact]
    public async Task GlobalMount_DeleteBlockedWhileReferencedThenForced()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: RequiredCatalogMountsJson);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var host = CreateExternalDirectory();
        var library = fixture.CreateGlobalMountService();
        await library.UpsertAsync(new GlobalMountUpsertRequest("media", host));
        await fixture.Service.ConfigureMountsAsync(
            "com.example.notes",
            new AppMountsRequest([new AppMountBindingInput("catalogRoots", GlobalMountName: "media")]));

        var listed = Assert.Single(await library.ListAsync());
        Assert.Equal(1, listed.UsedBy);

        var blocked = await Assert.ThrowsAsync<AppLifecycleException>(() => library.DeleteAsync("media", force: false));
        Assert.Equal("global_mount_in_use", blocked.Code);

        var remaining = await library.DeleteAsync("media", force: true);
        Assert.Empty(remaining);
    }

    private const string RequiredCatalogMountsJson =
        """ "externalMounts": { "catalogRoots": { "multiple": true, "required": true, "service": "app" } },""";

    private static string CreateExternalDirectory()
    {
        var path = Path.Combine(Path.GetTempPath(), $"hosty-mount-src-{Guid.NewGuid():N}");
        Directory.CreateDirectory(path);
        return path;
    }

    [Fact]
    public async Task LoadSelection_LiveSourceFolder_PrefersLiveManifestOverInternalCopy()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var folder = Path.Combine(fixture.Root, "live-app");
        Directory.CreateDirectory(folder);
        var manifestPath = Path.Combine(folder, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, CreateLocalCommandFolderManifestJson("1.0.0"));
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath));

        // The operator edits the live source folder; Core must run the live manifest on the next
        // start, not the reviewed internal copy saved at install (2b/R5).
        await File.WriteAllTextAsync(manifestPath, CreateLocalCommandFolderManifestJson("2.0.0"));
        var app = await fixture.Apps.GetAppAsync("com.example.notes");

        var load = await fixture.Service.LoadSelectionWithStatusAsync(app!, CancellationToken.None);

        Assert.True(load.LiveReconciled);
        Assert.Null(load.ManifestError);
        Assert.Equal("2.0.0", load.Selection.Manifest.Version);
    }

    [Fact]
    public async Task LoadSelection_LiveSourceFolder_LegacyRecordWithoutPersistedProfiles_StillLiveReconciles()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var folder = Path.Combine(fixture.Root, "legacy-live-app");
        Directory.CreateDirectory(folder);
        var manifestPath = Path.Combine(folder, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, CreateLocalCommandFolderManifestJson("1.0.0"));
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath));

        // Simulate a legacy record that never persisted RuntimeProfiles: liveness must still resolve from
        // the reviewed internal copy (development runtime → live), not silently fall back to non-live.
        var installed = await fixture.Apps.GetAppAsync("com.example.notes");
        await fixture.Apps.UpsertAppAsync(installed! with { RuntimeProfiles = null });

        await File.WriteAllTextAsync(manifestPath, CreateLocalCommandFolderManifestJson("2.0.0"));
        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Null(app!.RuntimeProfiles);

        var load = await fixture.Service.LoadSelectionWithStatusAsync(app, CancellationToken.None);

        Assert.True(load.LiveReconciled);
        Assert.Equal("2.0.0", load.Selection.Manifest.Version);
    }

    [Fact]
    public async Task LoadSelection_MonorepoLiveSource_ReadsManifestFromSubpath()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var repoRoot = Path.Combine(fixture.Root, "monorepo");
        Directory.CreateDirectory(Path.Combine(repoRoot, ".git"));
        var appDirectory = Path.Combine(repoRoot, "apps", "web");
        Directory.CreateDirectory(appDirectory);
        var manifestPath = Path.Combine(appDirectory, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, CreateMonorepoDevManifestJson("1.0.0"));
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath, SelectedRuntime: "dev"));

        // Source root is the repo root; the manifest is one subtree in.
        var installed = await fixture.Apps.GetAppAsync("com.example.web");
        Assert.Equal(Path.GetFullPath(repoRoot), installed!.SourceState?.LocalOverridePath);
        Assert.Equal("apps/web", installed.SourceState?.ManifestSubpath);

        // The operator edits the live manifest in its subfolder; Core must read it from <root>/apps/web,
        // not <root>/manifest.json (which does not exist for a monorepo app).
        await File.WriteAllTextAsync(manifestPath, CreateMonorepoDevManifestJson("2.0.0"));
        var app = await fixture.Apps.GetAppAsync("com.example.web");

        var load = await fixture.Service.LoadSelectionWithStatusAsync(app!, CancellationToken.None);

        Assert.True(load.LiveReconciled);
        Assert.Null(load.ManifestError);
        Assert.Equal("2.0.0", load.Selection.Manifest.Version);
    }

    private static string CreateMonorepoDevManifestJson(string version)
        => $$"""
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.web",
              "name": "Web App",
              "version": "{{version}}",
              "source": { "type": "git", "repository": ".", "branch": "main" },
              "runtimeProfiles": [{ "key": "dev", "type": "localCommand", "default": true, "development": true }],
              "defaultRuntime": "dev",
              "services": [{
                "key": "app",
                "runtimes": {
                  "dev": { "type": "localCommand", "command": "echo hi", "workingDirectory": "apps/web" }
                }
              }]
            }
            """;

    [Fact]
    public async Task LoadSelection_UrlDevelopmentRuntime_ReadsLiveManifestFromManagedCheckout()
    {
        const string manifestUrl = "https://raw.githubusercontent.com/acme/monorepo/main/apps/web/manifest.json";
        var manifests = new AppManifestService(new HttpClient(new StubHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(CreateUrlMonorepoDevManifestJson("1.0.0"), Encoding.UTF8, "application/json"),
        })));
        var fixture = await LifecycleFixture.CreateAsync(manifests);

        // A URL install may select docker (a localCommand runtime needs the remote opt-in to be selected).
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestUrl, SelectedRuntime: "docker"));
        var installed = await fixture.Apps.GetAppAsync("com.example.web");
        var checkoutPath = Assert.IsType<string>(installed!.SourceState?.ManagedCheckoutPath);
        Assert.Equal("apps/web", installed.SourceState?.ManifestSubpath);

        // Simulate the managed clone the start step materializes, with an edited manifest in its subpath.
        Directory.CreateDirectory(Path.Combine(checkoutPath, ".git"));
        var checkoutAppDirectory = Path.Combine(checkoutPath, "apps", "web");
        Directory.CreateDirectory(checkoutAppDirectory);
        await File.WriteAllTextAsync(Path.Combine(checkoutAppDirectory, "manifest.json"), CreateUrlMonorepoDevManifestJson("2.0.0"));

        // Switching to the development runtime runs it live from the checkout, reading the manifest from
        // <checkout>/apps/web — no override required (Q2).
        await fixture.Apps.UpsertAppAsync(installed with { SelectedRuntime = "dev" });
        var app = await fixture.Apps.GetAppAsync("com.example.web");

        var load = await fixture.Service.LoadSelectionWithStatusAsync(app!, CancellationToken.None);

        Assert.True(load.LiveReconciled);
        Assert.Null(load.ManifestError);
        Assert.Equal("2.0.0", load.Selection.Manifest.Version);
    }

    private static string CreateUrlMonorepoDevManifestJson(string version)
        => $$"""
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.web",
              "name": "Web App",
              "version": "{{version}}",
              "source": { "type": "git", "repository": "https://github.com/acme/monorepo.git", "branch": "main" },
              "runtimeProfiles": [
                { "key": "docker", "type": "docker", "default": true },
                { "key": "dev", "type": "localCommand", "development": true }
              ],
              "defaultRuntime": "docker",
              "services": [{
                "key": "app",
                "runtimes": {
                  "docker": { "type": "docker", "image": "ghcr.io/acme/web:{{version}}" },
                  "dev": { "type": "localCommand", "command": "npm run dev", "workingDirectory": "apps/web" }
                }
              }]
            }
            """;

    [Fact]
    public async Task LoadSelection_LiveSourceFolder_InvalidEdit_FallsBackToLastGoodAndReportsError()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var folder = Path.Combine(fixture.Root, "live-app");
        Directory.CreateDirectory(folder);
        var manifestPath = Path.Combine(folder, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, CreateLocalCommandFolderManifestJson("1.0.0"));
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath));

        // A mid-edit-invalid folder manifest must not break the app: Core keeps running the last-good
        // copy and surfaces the error rather than failing (2b/R13/R14).
        await File.WriteAllTextAsync(manifestPath, "{ not valid json");
        var app = await fixture.Apps.GetAppAsync("com.example.notes");

        var load = await fixture.Service.LoadSelectionWithStatusAsync(app!, CancellationToken.None);

        Assert.False(load.LiveReconciled);
        Assert.NotNull(load.ManifestError);
        Assert.Equal("1.0.0", load.Selection.Manifest.Version);
    }

    [Fact]
    public async Task ReconcileLiveContract_AdoptsLiveVersionFreshensCopyAndRecordsChanges()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var folder = Path.Combine(fixture.Root, "live-app");
        Directory.CreateDirectory(folder);
        var manifestPath = Path.Combine(folder, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, CreateLocalCommandFolderManifestJson("1.0.0"));
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath));

        await File.WriteAllTextAsync(manifestPath, CreateLocalCommandFolderManifestJson("2.0.0"));
        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        var load = await fixture.Service.LoadSelectionWithStatusAsync(app!, CancellationToken.None);

        var reconciled = await fixture.Service.ReconcileLiveContractAsync(app!, load, CancellationToken.None);

        // The persisted contract adopts the live version (no reviewed-update ceremony, R5) and the
        // adopted delta is recorded for awareness (R11).
        Assert.Equal("2.0.0", reconciled.Version);
        Assert.Contains(reconciled.LiveChanges ?? [], change => change == "version:1.0.0->2.0.0");
        // The last-good internal copy is freshened, so a re-read now baselines at the new version (R10).
        var internalCopy = Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "manifest.json");
        var refreshed = await fixture.Manifests.LoadAsync(internalCopy);
        Assert.Equal("2.0.0", refreshed.Manifest.Version);
    }

    [Fact]
    public async Task ReconcileLiveContract_KeepsOrphanedMountBindingWhenSlotRemoved()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var folder = Path.Combine(fixture.Root, "live-app");
        Directory.CreateDirectory(folder);
        var manifestPath = Path.Combine(folder, "manifest.json");
        const string mountSlot = ""","externalMounts":{"catalogRoots":{"mode":"rw","multiple":true,"service":"app"}}""";
        await File.WriteAllTextAsync(manifestPath, CreateLocalCommandFolderManifestJson("1.0.0", mountSlot));
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath));
        var host = CreateExternalDirectory();
        await fixture.Service.ConfigureMountsAsync(
            "com.example.notes",
            new AppMountsRequest([new AppMountBindingInput("catalogRoots", "movies", host)]));

        // The operator removes the mount slot from the live manifest. Hosty must NOT delete the
        // operator's binding — it is kept (orphaned, inert) and re-activates if the slot returns (R7).
        await File.WriteAllTextAsync(manifestPath, CreateLocalCommandFolderManifestJson("2.0.0"));
        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        var load = await fixture.Service.LoadSelectionWithStatusAsync(app!, CancellationToken.None);

        var reconciled = await fixture.Service.ReconcileLiveContractAsync(app!, load, CancellationToken.None);

        Assert.DoesNotContain(reconciled.MountSlots ?? [], slot => slot.Key == "catalogRoots");
        var binding = Assert.Single(reconciled.Mounts ?? []);
        Assert.Equal("catalogRoots", binding.Key);
        Assert.Equal("movies", binding.Label);
    }

    [Fact]
    public async Task ReconcileLiveContract_AdoptsAddedInterfacesBlock()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var folder = Path.Combine(fixture.Root, "live-app");
        Directory.CreateDirectory(folder);
        var manifestPath = Path.Combine(folder, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, CreateLocalCommandFolderManifestJson("1.0.0"));
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath));

        // The operator adds an `interfaces` block to the live folder manifest. Adoption must carry it
        // onto the record — the projections come from the shared choke point, not a hand-copied field
        // list that once silently omitted Interfaces.
        await File.WriteAllTextAsync(manifestPath, CreateLocalCommandFolderManifestJson(
            "2.0.0",
            ""","interfaces":{"ai-gateway":[{"path":"/assistant"}]}"""));
        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        var load = await fixture.Service.LoadSelectionWithStatusAsync(app!, CancellationToken.None);

        var reconciled = await fixture.Service.ReconcileLiveContractAsync(app!, load, CancellationToken.None);

        var declaration = Assert.Single(reconciled.Interfaces!["ai-gateway"]);
        Assert.Equal("/assistant", declaration.Path);
    }

    [Fact]
    public async Task BackfillManifestProjections_HealsRecordWrittenByDifferentCoreBuild()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifestPath = await fixture.WriteManifestAsync(
            "1.0.0",
            interfacesJson: """ "interfaces": { "ai-gateway": [{ "endpoint": "app.http", "path": "/assistant" }] }, """);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath));

        // Install runs the projections under this build, so the record is stamped with it.
        var installed = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.NotNull(installed!.Interfaces);
        Assert.Equal(CoreStatusResponse.PlatformVersionString, installed.NormalizedBy);

        // Simulate the record an older Core wrote: sections its parser did not know are absent from
        // state.json, and there is no stamp (the exact shape of the 2026-08-09 ai-gateway rollout).
        await fixture.Apps.UpsertAppAsync(installed with { Interfaces = null, NormalizedBy = null });

        var healed = await fixture.Service.BackfillManifestProjectionsAsync();

        Assert.Equal(1, healed);
        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        var declaration = Assert.Single(app!.Interfaces!["ai-gateway"]);
        Assert.Equal("app.http", declaration.EndpointKey);
        Assert.Equal("/assistant", declaration.Path);
        Assert.Equal(CoreStatusResponse.PlatformVersionString, app.NormalizedBy);
        // Operator-owned state is untouched by the heal.
        Assert.Equal("production", app.Settings["APP_MODE"].Value);
        Assert.Equal("1.0.0", app.Version);
    }

    [Fact]
    public async Task BackfillManifestProjections_RecordStampedByThisBuild_SkipsWithoutRewriting()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifestPath = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath));
        var before = await fixture.Apps.GetAppAsync("com.example.notes");

        var healed = await fixture.Service.BackfillManifestProjectionsAsync();

        // Steady-state boots neither re-read manifests nor rewrite state.json.
        Assert.Equal(0, healed);
        var after = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal(before!.UpdatedAt, after!.UpdatedAt);
    }

    [Fact]
    public async Task BackfillManifestProjections_NullInterfaceDeclarationInLegacyCopy_HealsWithoutThrowing()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifestPath = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath));
        var installed = await fixture.Apps.GetAppAsync("com.example.notes");
        await fixture.Apps.UpsertAppAsync(installed! with { NormalizedBy = null });

        // The stored copy is the raw source JSON, and an older Core never shape-validated the
        // `interfaces` section it did not know — so a null declaration can legitimately sit there.
        // The projection must drop it, not dereference it.
        var withNullDeclaration = await fixture.WriteManifestAsync(
            "1.0.0",
            interfacesJson: """ "interfaces": { "ai-gateway": [null] }, """);
        File.Copy(withNullDeclaration, Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "manifest.json"), overwrite: true);

        var healed = await fixture.Service.BackfillManifestProjectionsAsync();

        Assert.Equal(1, healed);
        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        // All declarations were null, so the interface key collapses away entirely.
        Assert.Null(app!.Interfaces);
        Assert.Equal(CoreStatusResponse.PlatformVersionString, app.NormalizedBy);
    }

    [Fact]
    public async Task BackfillManifestProjections_ProjectionFailure_SkipsRecordUnstampedAndHealsTheRest()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        await fixture.Service.InstallAsync(new AppInstallRequest(
            await fixture.WriteManifestAsync("1.0.0", id: "com.example.other", name: "Other")));
        foreach (var id in new[] { "com.example.notes", "com.example.other" })
        {
            var record = await fixture.Apps.GetAppAsync(id);
            await fixture.Apps.UpsertAppAsync(record! with { NormalizedBy = null });
        }

        // A legacy stored copy the projection chokes on (a null dependency entry dereferences in
        // ToDependencyContract). Per-record isolation must skip it un-stamped — so a later boot
        // retries — and still heal the record behind it instead of aborting the boot step.
        await File.WriteAllTextAsync(
            Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "manifest.json"),
            """
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.notes",
              "name": "Notes",
              "version": "1.0.0",
              "runtimeProfiles": [{ "key": "docker", "type": "docker", "default": true }],
              "services": [],
              "dependencies": [null]
            }
            """);

        var healed = await fixture.Service.BackfillManifestProjectionsAsync();

        Assert.Equal(1, healed);
        var broken = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Null(broken!.NormalizedBy);
        var other = await fixture.Apps.GetAppAsync("com.example.other");
        Assert.Equal(CoreStatusResponse.PlatformVersionString, other!.NormalizedBy);
    }

    [Fact]
    public async Task BackfillManifestProjections_MissingManifestCopy_SkipsWithoutStamping()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifestPath = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath));
        var installed = await fixture.Apps.GetAppAsync("com.example.notes");
        await fixture.Apps.UpsertAppAsync(installed! with { NormalizedBy = null });
        File.Delete(Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "manifest.json"));

        var healed = await fixture.Service.BackfillManifestProjectionsAsync();

        // No stored copy to project from: skip, and leave the record un-stamped so a later boot
        // retries once the copy exists again.
        Assert.Equal(0, healed);
        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Null(app!.NormalizedBy);
    }

    [Fact]
    public async Task RestartAsync_LiveSourceApp_AdoptsFolderManifestAndRevendorsAssets()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var folder = Path.Combine(fixture.Root, "live-app");
        Directory.CreateDirectory(Path.Combine(folder, "assets"));
        var manifestPath = Path.Combine(folder, "manifest.json");
        await File.WriteAllTextAsync(Path.Combine(folder, "assets", "home.svg"), "<svg>v1</svg>");
        await File.WriteAllTextAsync(manifestPath, CreateNavIconFolderManifestJson("1.0.0", "Home"));
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath));

        try
        {
            _ = await fixture.Service.StartAsync("com.example.notes");

            // The operator edits the manifest and an icon, then restarts — the dev-mode iteration step.
            // Restart must adopt the folder contract and re-vendor display assets exactly like a cold
            // start, so the sidebar tracks the edit without a stop/start ceremony.
            await File.WriteAllTextAsync(Path.Combine(folder, "assets", "home.svg"), "<svg>v2</svg>");
            await File.WriteAllTextAsync(manifestPath, CreateNavIconFolderManifestJson("2.0.0", "Start"));

            var restarted = await fixture.Service.RestartAsync("com.example.notes");

            Assert.Equal("2.0.0", restarted.App!.Version);
            var nav = Assert.Single(restarted.App.Navigation);
            Assert.Equal("Start", nav.Label);
            // Live asset URLs carry no version buster, so the refreshed icon is not pinned to a stale
            // immutable browser-cache entry.
            Assert.Equal("/api/apps/com.example.notes/assets/assets/home.svg", nav.IconUrl);
            var vendored = Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "assets", "home.svg");
            Assert.Equal("<svg>v2</svg>", await File.ReadAllTextAsync(vendored));
        }
        finally
        {
            _ = await fixture.Service.StopAsync("com.example.notes");
        }
    }

    [Fact]
    public async Task RestartAsync_LiveSourceApp_StopsRenamedServiceFromBaselineContract()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var folder = Path.Combine(fixture.Root, "live-app");
        Directory.CreateDirectory(Path.Combine(folder, "assets"));
        var manifestPath = Path.Combine(folder, "manifest.json");
        await File.WriteAllTextAsync(Path.Combine(folder, "assets", "home.svg"), "<svg>v1</svg>");
        await File.WriteAllTextAsync(manifestPath, CreateNavIconFolderManifestJson("1.0.0", "Home", serviceKey: "app"));
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath));

        try
        {
            _ = await fixture.Service.StartAsync("com.example.notes");
            Assert.NotNull(fixture.LocalProcesses.Get("com.example.notes", "app"));

            // The operator renames the service mid-edit. Restart must stop against the baseline
            // contract (what the running process was started with) — stopping from the adopted
            // contract would look for 'web' only and orphan the old 'app' process.
            await File.WriteAllTextAsync(manifestPath, CreateNavIconFolderManifestJson("2.0.0", "Home", serviceKey: "web"));

            _ = await fixture.Service.RestartAsync("com.example.notes");

            Assert.Null(fixture.LocalProcesses.Get("com.example.notes", "app"));
            Assert.NotNull(fixture.LocalProcesses.Get("com.example.notes", "web"));
        }
        finally
        {
            _ = await fixture.Service.StopAsync("com.example.notes");
        }
    }

    [Fact]
    public async Task RestartAsync_LiveSourceApp_InvalidEditKeepsLastGoodAndRecordsError()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var folder = Path.Combine(fixture.Root, "live-app");
        Directory.CreateDirectory(folder);
        var manifestPath = Path.Combine(folder, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, CreateNavIconFolderManifestJson("1.0.0", "Home"));
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath));

        try
        {
            _ = await fixture.Service.StartAsync("com.example.notes");

            // A mid-edit-invalid folder manifest must not break the restart: Core keeps running the
            // last-good contract and surfaces the error on the record (2b/R13/R14).
            await File.WriteAllTextAsync(manifestPath, "{ not valid json");

            var restarted = await fixture.Service.RestartAsync("com.example.notes");

            Assert.Equal("1.0.0", restarted.App!.Version);
            Assert.NotNull(restarted.App.ManifestError);
        }
        finally
        {
            _ = await fixture.Service.StopAsync("com.example.notes");
        }
    }

    [Fact]
    public async Task LoadSelection_DockerFolderInstall_DoesNotLiveReadInternalCopy()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var folder = Path.Combine(fixture.Root, "docker-app");
        Directory.CreateDirectory(folder);
        var manifestPath = Path.Combine(folder, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, CreateRemoteManifestJson("1.0.0"));
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath));

        // A docker (image) app is not live source: editing the folder must NOT take effect on start —
        // it stays a reviewed update. The selection reflects the install-time internal copy.
        await File.WriteAllTextAsync(manifestPath, CreateRemoteManifestJson("2.0.0"));
        var app = await fixture.Apps.GetAppAsync("com.example.notes");

        var load = await fixture.Service.LoadSelectionWithStatusAsync(app!, CancellationToken.None);

        Assert.False(load.LiveReconciled);
        Assert.Null(load.ManifestError);
        Assert.Equal("1.0.0", load.Selection.Manifest.Version);
    }

    [Fact]
    public async Task LoadSelection_NonDevelopmentLocalCommandFolder_DoesNotLiveReadInternalCopy()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var folder = Path.Combine(fixture.Root, "prod-src-app");
        Directory.CreateDirectory(folder);
        var manifestPath = Path.Combine(folder, "manifest.json");
        // A localCommand runtime WITHOUT development is a build-to-production source runtime: locked and
        // updated in review, so it must NOT re-read the folder manifest live even though it runs from
        // source. development: true is the single gate for liveness (runtime-artifact-model.md).
        await File.WriteAllTextAsync(manifestPath, CreateReleaseLocalCommandFolderManifestJson("1.0.0"));
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestPath));

        await File.WriteAllTextAsync(manifestPath, CreateReleaseLocalCommandFolderManifestJson("2.0.0"));
        var app = await fixture.Apps.GetAppAsync("com.example.notes");

        var load = await fixture.Service.LoadSelectionWithStatusAsync(app!, CancellationToken.None);

        Assert.False(load.LiveReconciled);
        Assert.Null(load.ManifestError);
        Assert.Equal("1.0.0", load.Selection.Manifest.Version);
    }

    private static string CreateReleaseLocalCommandFolderManifestJson(string version)
        => $$"""
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.notes",
              "name": "Notes",
              "version": "{{version}}",
              "runtimeProfiles": [{ "key": "release", "type": "localCommand", "default": true }],
              "defaultRuntime": "release",
              "services": [{
                "key": "app",
                "runtimes": {
                  "release": {
                    "type": "localCommand",
                    "command": "echo hi"
                  }
                }
              }]
            }
            """;

    private static string CreateLocalCommandFolderManifestJson(string version, string? extraJson = null)
        => $$"""
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.notes",
              "name": "Notes",
              "version": "{{version}}",
              "runtimeProfiles": [{ "key": "dev", "type": "localCommand", "default": true, "development": true }],
              "defaultRuntime": "dev",
              "services": [{
                "key": "app",
                "runtimes": {
                  "dev": {
                    "type": "localCommand",
                    "command": "echo hi"
                  }
                }
              }]{{extraJson ?? ""}}
            }
            """;

    private static string CreateNavIconFolderManifestJson(string version, string navLabel, string serviceKey = "app")
        => $$"""
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.notes",
              "name": "Notes",
              "version": "{{version}}",
              "runtimeProfiles": [{ "key": "dev", "type": "localCommand", "default": true, "development": true }],
              "defaultRuntime": "dev",
              "services": [{
                "key": "{{serviceKey}}",
                "runtimes": {
                  "dev": {
                    "type": "localCommand",
                    "command": "sleep 5"
                  }
                }
              }],
              "ui": {
                "path": "/",
                "navigation": [{ "label": "{{navLabel}}", "path": "/", "iconAsset": "assets/home.svg" }]
              }
            }
            """;

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

    private static string CreateRemoteLocalCommandManifestJson(string sourceRepository, string version = "1.0.0")
        => $$"""
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.remote-local",
              "name": "Remote Local App",
              "version": "{{version}}",
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

    [Fact]
    public async Task ReassignPortPlanAsync_ReportsCurrentPortAndRunningDependent()
    {
        var fixture = await LifecycleFixture.CreateAsync(withPortAllocator: true);
        await fixture.Apps.UpsertAppAsync(SeedReassignApp("com.example.api", "stopped",
            assignments: [ReassignAssignment("app", "http", 5000)],
            endpoints: [ReassignEndpoint("app", "http", "http://localhost:5000")]));
        await fixture.Apps.UpsertAppAsync(SeedReassignApp("com.example.web", "running",
            dependencies: [new AppDependencyContract("com.example.api", null, Required: true, [])]));

        var plan = await fixture.Service.ReassignPortPlanAsync("com.example.api", "app", "http");

        Assert.Equal(5000, plan.CurrentPort);
        Assert.False(plan.OwnerRunning);
        var dependent = Assert.Single(plan.AffectedDependents);
        Assert.Equal("com.example.web", dependent.AppId);
        Assert.True(dependent.Running);
        Assert.NotEmpty(plan.Digest);
    }

    [Fact]
    public async Task ReassignPortAsync_MovesPortAndReportsRunningDependentsForRestart()
    {
        var fixture = await LifecycleFixture.CreateAsync(withPortAllocator: true);
        await fixture.Apps.UpsertAppAsync(SeedReassignApp("com.example.api", "stopped",
            assignments: [ReassignAssignment("app", "http", 5000)],
            endpoints: [ReassignEndpoint("app", "http", "http://localhost:5000")]));
        await fixture.Apps.UpsertAppAsync(SeedReassignApp("com.example.web", "running",
            dependencies: [new AppDependencyContract("com.example.api", null, Required: true, [])]));

        var plan = await fixture.Service.ReassignPortPlanAsync("com.example.api", "app", "http");
        var result = await fixture.Service.ReassignPortAsync("com.example.api", new ReassignPortRequest("app", "http", plan.Digest));

        Assert.Equal(5000, result.OldPort);
        Assert.NotEqual(5000, result.NewPort);
        // The stopped owner is not restarted; the running dependent must be, to drop the stale local URL.
        Assert.Equal(new[] { "com.example.web" }, result.RestartRequiredAppIds);
        var api = await fixture.Apps.GetAppAsync("com.example.api");
        Assert.Equal(result.NewPort, Assert.Single(api!.PortAssignments!).HostPort);
        Assert.Equal($"http://localhost:{result.NewPort}", Assert.Single(api.Endpoints).Url);
    }

    [Fact]
    public async Task ReassignPortAsync_StaleDigest_Throws()
    {
        var fixture = await LifecycleFixture.CreateAsync(withPortAllocator: true);
        await fixture.Apps.UpsertAppAsync(SeedReassignApp("com.example.api", "stopped",
            assignments: [ReassignAssignment("app", "http", 5000)],
            endpoints: [ReassignEndpoint("app", "http", "http://localhost:5000")]));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.ReassignPortAsync("com.example.api", new ReassignPortRequest("app", "http", "stale-digest")));
        Assert.Equal("reassign_state_changed", error.Code);
    }

    [Fact]
    public async Task ReassignPortPlanAsync_ManifestPort_RejectedAsNotRemappable()
    {
        var fixture = await LifecycleFixture.CreateAsync(withPortAllocator: true);
        await fixture.Apps.UpsertAppAsync(SeedReassignApp("com.example.api", "stopped",
            assignments: [ReassignAssignment("app", "http", 5000, source: AppPortSources.Manifest, remappable: false)],
            endpoints: [ReassignEndpoint("app", "http", "http://localhost:5000")]));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.ReassignPortPlanAsync("com.example.api", "app", "http"));
        Assert.Equal("reassign_not_remappable", error.Code);
    }

    [Fact]
    public async Task ReassignPortAsync_ManualMode_PinsPortAndMarksAssignmentOperatorOwned()
    {
        var fixture = await LifecycleFixture.CreateAsync(withPortAllocator: true);
        await fixture.Apps.UpsertAppAsync(SeedReassignApp("com.example.api", "stopped",
            assignments: [ReassignAssignment("app", "http", 5000)],
            endpoints: [ReassignEndpoint("app", "http", "http://localhost:5000")]));

        var plan = await fixture.Service.ReassignPortPlanAsync("com.example.api", "app", "http");
        Assert.False(plan.Pinned);

        var result = await fixture.Service.ReassignPortAsync(
            "com.example.api",
            new ReassignPortRequest("app", "http", plan.Digest, ReassignPortRequest.ModeManual, 8321));

        Assert.Equal(8321, result.NewPort);
        var api = await fixture.Apps.GetAppAsync("com.example.api");
        var assignment = Assert.Single(api!.PortAssignments!);
        Assert.Equal(AppPortSources.Operator, assignment.Source);
        Assert.False(assignment.Remappable);
        Assert.Equal("http://localhost:8321", Assert.Single(api.Endpoints).Url);
    }

    [Fact]
    public async Task ReassignPortAsync_ExplicitAutomatic_UnpinsAndReturnsToAutomatic()
    {
        // The un-pin path: without it, choosing a port would be a one-way door. The dialog's Automatic
        // toggle posts exactly this.
        var fixture = await LifecycleFixture.CreateAsync(withPortAllocator: true);
        var scopedKey = RuntimePortHelper.ServiceScopedOverrideSettingKey("app", "http");
        await fixture.Apps.UpsertAppAsync(SeedReassignApp("com.example.api", "stopped",
            assignments: [ReassignAssignment("app", "http", 8321, source: AppPortSources.Operator, remappable: false)],
            endpoints: [ReassignEndpoint("app", "http", "http://localhost:8321")]) with
        {
            Settings = new Dictionary<string, AppSettingValue>(StringComparer.Ordinal)
            {
                [scopedKey] = new(scopedKey, "string", "8321", Secret: false),
            },
        });

        var plan = await fixture.Service.ReassignPortPlanAsync("com.example.api", "app", "http");
        var result = await fixture.Service.ReassignPortAsync(
            "com.example.api",
            new ReassignPortRequest("app", "http", plan.Digest, ReassignPortRequest.ModeAutomatic, null));

        Assert.NotEqual(8321, result.NewPort);
        var api = await fixture.Apps.GetAppAsync("com.example.api");
        var assignment = Assert.Single(api!.PortAssignments!);
        Assert.Equal(AppPortSources.Automatic, assignment.Source);
        Assert.True(assignment.Remappable);
        // A surviving override would silently re-pin the old port at the next start.
        Assert.False(api.Settings.ContainsKey(scopedKey));
    }

    [Fact]
    public async Task ReassignPortAsync_PinnedPort_StaysEditableButRefusesLegacyAutomaticMove()
    {
        // A legacy client (no mode) has no UI to choose automatic-vs-manual, so a blind re-roll from it must
        // not move a port the operator deliberately pinned. An explicitly-moded request may, see above.
        var fixture = await LifecycleFixture.CreateAsync(withPortAllocator: true);
        await fixture.Apps.UpsertAppAsync(SeedReassignApp("com.example.api", "stopped",
            assignments: [ReassignAssignment("app", "http", 8321, source: AppPortSources.Operator, remappable: false)],
            endpoints: [ReassignEndpoint("app", "http", "http://localhost:8321")]));

        var plan = await fixture.Service.ReassignPortPlanAsync("com.example.api", "app", "http");
        Assert.True(plan.Pinned);
        Assert.Equal(8321, plan.CurrentPort);

        var moved = await fixture.Service.ReassignPortAsync(
            "com.example.api",
            new ReassignPortRequest("app", "http", plan.Digest, ReassignPortRequest.ModeManual, 8322));
        Assert.Equal(8322, moved.NewPort);

        var afterMove = await fixture.Service.ReassignPortPlanAsync("com.example.api", "app", "http");
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.ReassignPortAsync("com.example.api", new ReassignPortRequest("app", "http", afterMove.Digest)));
        Assert.Equal("reassign_not_remappable", error.Code);
    }

    [Fact]
    public async Task ReassignPortAsync_ManualModeWithoutPort_Rejected()
    {
        var fixture = await LifecycleFixture.CreateAsync(withPortAllocator: true);
        await fixture.Apps.UpsertAppAsync(SeedReassignApp("com.example.api", "stopped",
            assignments: [ReassignAssignment("app", "http", 5000)],
            endpoints: [ReassignEndpoint("app", "http", "http://localhost:5000")]));

        var plan = await fixture.Service.ReassignPortPlanAsync("com.example.api", "app", "http");
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.ReassignPortAsync(
                "com.example.api",
                new ReassignPortRequest("app", "http", plan.Digest, ReassignPortRequest.ModeManual, null)));
        Assert.Equal("port_required", error.Code);
    }

    [Fact]
    public async Task ReassignPortAsync_AbsentMode_StillAllocatesAutomatically()
    {
        // Wire compatibility: an older Shell posts service/portKey/digest with no mode at all.
        var fixture = await LifecycleFixture.CreateAsync(withPortAllocator: true);
        await fixture.Apps.UpsertAppAsync(SeedReassignApp("com.example.api", "stopped",
            assignments: [ReassignAssignment("app", "http", 5000)],
            endpoints: [ReassignEndpoint("app", "http", "http://localhost:5000")]));

        var plan = await fixture.Service.ReassignPortPlanAsync("com.example.api", "app", "http");
        var result = await fixture.Service.ReassignPortAsync("com.example.api", new ReassignPortRequest("app", "http", plan.Digest));

        Assert.NotEqual(5000, result.NewPort);
        var api = await fixture.Apps.GetAppAsync("com.example.api");
        Assert.Equal(AppPortSources.Automatic, Assert.Single(api!.PortAssignments!).Source);
    }

    [Fact]
    public void ReassignPortContract_MatchesTheWireNamesTheShellReads()
    {
        // The Shell types this endpoint against `pinned` / `minManualPort`, and posts `mode` / `port`.
        // Source-generated AOT metadata is the only place that contract is decided, so assert it here
        // rather than discovering a silent rename at runtime.
        var plan = new ReassignPortPlan("com.example.api", "app", "http", 8321, "http://localhost:8321", OwnerRunning: false, [], Pinned: true, MinManualPort: 1024, Digest: "d");
        var planJson = JsonSerializer.Serialize(plan, CoreJsonSerializerContext.Default.ReassignPortPlan);
        Assert.Contains("\"pinned\":true", planJson, StringComparison.Ordinal);
        Assert.Contains("\"minManualPort\":1024", planJson, StringComparison.Ordinal);

        var request = JsonSerializer.Deserialize(
            """{"service":"app","portKey":"http","digest":"d","mode":"manual","port":8321}""",
            CoreJsonSerializerContext.Default.ReassignPortRequest);
        Assert.NotNull(request);
        Assert.True(request!.IsManual);
        Assert.Equal(8321, request.DesiredPort);

        // An older Shell omits both new fields entirely.
        var legacy = JsonSerializer.Deserialize(
            """{"service":"app","portKey":"http","digest":"d"}""",
            CoreJsonSerializerContext.Default.ReassignPortRequest);
        Assert.NotNull(legacy);
        Assert.False(legacy!.IsManual);
        Assert.Null(legacy.DesiredPort);
    }

    [Fact]
    public void PreflightLoopbackAssignments_PortInUse_ThrowsRuntimePortUnavailable()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var app = SeedReassignApp("com.example.api", "stopped", assignments: [ReassignAssignment("app", "http", port)]);

        var error = Assert.Throws<AppLifecycleException>(() => CoreLifecycleService.PreflightLoopbackAssignments(app));
        Assert.Equal("runtime_port_unavailable", error.Code);
        Assert.Contains($"app.http → {port}", error.Message);
    }

    [Fact]
    public void PreflightLoopbackAssignments_WildcardBoundHolder_ThrowsRuntimePortUnavailable()
    {
        // A localCommand app that listens on "all interfaces" holds `0.0.0.0`/`::`, never `127.0.0.1`.
        // On BSD/macOS that slipped past the loopback-only probe entirely, so a reserved port squatted by
        // such a process was reported free and the operator got a generic adapter bind failure — or an app
        // that started and never served — instead of this structured, reassign-able conflict.
        using var holder = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
        holder.Bind(new IPEndPoint(IPAddress.Any, 0));
        holder.Listen(1);
        var port = ((IPEndPoint)holder.LocalEndPoint!).Port;
        var app = SeedReassignApp("com.example.api", "stopped", assignments: [ReassignAssignment("app", "http", port)]);

        var error = Assert.Throws<AppLifecycleException>(() => CoreLifecycleService.PreflightLoopbackAssignments(app));
        Assert.Equal("runtime_port_unavailable", error.Code);
        Assert.Contains($"app.http → {port}", error.Message);
    }

    [Fact]
    public void PreflightLoopbackAssignments_FreePort_DoesNotThrow()
    {
        var freePort = RuntimePortHelper.AllocateLoopbackPort();
        var app = SeedReassignApp("com.example.api", "stopped", assignments: [ReassignAssignment("app", "http", freePort)]);

        CoreLifecycleService.PreflightLoopbackAssignments(app); // does not throw
    }

    [Fact]
    public void PreflightLoopbackAssignments_RunningApp_SkipsCheckEvenWhenPortBound()
    {
        // A running app (restart/adoption) legitimately holds its own port; the preflight must not flag it.
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var app = SeedReassignApp("com.example.api", "running", assignments: [ReassignAssignment("app", "http", port)]);

        CoreLifecycleService.PreflightLoopbackAssignments(app); // skipped → does not throw
    }

    [Fact]
    public async Task WaitForLoopbackAssignmentsReleasedAsync_PortFreedWithinWindow_DoesNotThrow()
    {
        // The reported bug: updating a *running* app stops its container then restarts, but docker frees
        // the published host port a beat later, so the restart's preflight saw the app's own port as still
        // taken. A short poll must ride out that self-release race. Here a listener holds the port, then
        // frees it well within the wait window; the wait must complete cleanly rather than fail.
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var app = SeedReassignApp("com.example.api", "stopped", assignments: [ReassignAssignment("app", "http", port)]);

        var release = Task.Run(async () =>
        {
            await Task.Delay(400);
            listener.Stop();
        });

        try
        {
            await CoreLifecycleService.WaitForLoopbackAssignmentsReleasedAsync(app, TimeSpan.FromSeconds(5), CancellationToken.None);
        }
        finally
        {
            // Awaited on every path so a fault in the release surfaces instead of going unobserved; the
            // `using` frees the port regardless, so a failure here cannot leave it bound for later tests.
            await release;
        }
    }

    [Fact]
    public async Task WaitForLoopbackAssignmentsReleasedAsync_PortHeldForWholeWindow_Throws()
    {
        // A genuine external conflict never clears, so after the window the structured error still fires.
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var app = SeedReassignApp("com.example.api", "stopped", assignments: [ReassignAssignment("app", "http", port)]);

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            CoreLifecycleService.WaitForLoopbackAssignmentsReleasedAsync(app, TimeSpan.FromMilliseconds(500), CancellationToken.None));

        Assert.Equal("runtime_port_unavailable", error.Code);
        Assert.Contains($"app.http → {port}", error.Message);
    }

    [Fact]
    public async Task WaitForLoopbackAssignmentsReleasedAsync_ZeroTimeout_FailsWithoutSleeping()
    {
        // The timeout is a real bound, not a poll count: a zero one must fail immediately rather than
        // serve one full poll interval first (which a count-based loop did).
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var app = SeedReassignApp("com.example.api", "stopped", assignments: [ReassignAssignment("app", "http", port)]);

        var stopwatch = Stopwatch.StartNew();
        await Assert.ThrowsAsync<AppLifecycleException>(() =>
            CoreLifecycleService.WaitForLoopbackAssignmentsReleasedAsync(app, TimeSpan.Zero, CancellationToken.None));
        stopwatch.Stop();

        Assert.True(stopwatch.ElapsedMilliseconds < 200, $"expected an immediate failure, took {stopwatch.ElapsedMilliseconds}ms");
    }

    [Fact]
    public async Task ApplyUpdateAsync_LingeringOwnHostPort_StartsAnywayInsteadOfFailingTheUpdate()
    {
        // The reported symptom: updating a *running* app reported "update failed: assigned host port(s)
        // already in use" naming the app's own port, and the operator's Restart button then started it
        // fine. The port was ours, still being released — Docker Desktop keeps a published host port
        // forwarded for a while after `docker stop` returns, sometimes past the old 5s window — and
        // expiring that window failed the whole update and left the app stopped. The window now bounds
        // how long we *wait*, not whether we start: on expiry the update proceeds and the runtime's own
        // bind decides. Held here for the whole (shrunk) window, so this exercises the give-up path.
        var fixture = await LifecycleFixture.CreateAsync(selfRestartPortReleaseTimeout: TimeSpan.FromMilliseconds(300));
        var manifestV1 = await fixture.WriteManifestAsync("1.0.0");
        var manifestV2 = await fixture.WriteManifestAsync("2.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifestV1));
        _ = await fixture.Service.StartAsync("com.example.notes");

        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        // Give the running app a loopback reservation on the port the listener is squatting, so the
        // post-stop probe inside the update sees it as taken exactly like the real teardown did.
        _ = await fixture.Apps.UpdateAppAsync(
            "com.example.notes",
            current => current with { PortAssignments = [ReassignAssignment("app", "http", port)] });

        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(manifestV2));
        var result = await fixture.Service.ApplyUpdateAsync("com.example.notes", new AppUpdateApplyRequest(plan.PlanDigest, manifestV2));

        Assert.Equal("updated", result.Status);
        Assert.Equal("2.0.0", result.App?.Version);
        // The whole point: the app is back up, not stranded stopped waiting for a manual restart.
        Assert.Equal("running", result.App?.RuntimeState);
    }

    [Fact]
    public async Task StartAsync_ColdStartOntoATakenPort_StillFailsWithTheStructuredConflict()
    {
        // The other half of the split: with nothing of ours just stopped, a busy reserved port really is
        // someone else's, and the operator gets the actionable error rather than a runtime bind failure.
        var fixture = await LifecycleFixture.CreateAsync(selfRestartPortReleaseTimeout: TimeSpan.FromMilliseconds(300));
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        _ = await fixture.Apps.UpdateAppAsync(
            "com.example.notes",
            current => current with { PortAssignments = [ReassignAssignment("app", "http", port)] });

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Service.StartAsync("com.example.notes"));

        Assert.Equal("runtime_port_unavailable", error.Code);
        Assert.Contains($"app.http → {port}", error.Message);
    }

    [Fact]
    public void PreflightLoopbackAssignments_HostNetworkAssignment_IsNotProbed()
    {
        // Host-network ports bind a fixed container port and are outside the loopback pool; even if the
        // number is currently bound on loopback, the preflight ignores them.
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var app = SeedReassignApp("com.example.torrent", "stopped",
            assignments: [new AppPortAssignment("app", "torrent", port, AppPortTransports.Tcp, AppPortBindScopes.HostNetwork, AppPortSources.HostNetwork, Remappable: false, AssignedAt: DateTimeOffset.UnixEpoch)]);

        CoreLifecycleService.PreflightLoopbackAssignments(app); // host-network skipped → does not throw
    }

    [Fact]
    public async Task StartAsync_WhenTheAppIsAlreadyUp_DoesNotRejectItsOwnBoundPorts()
    {
        // Regression guard for the trap the transitional stamp opened: stamping `starting` overwrites
        // the very evidence the port preflight uses to exempt an app that legitimately holds its own
        // ports. A Core restart that kept containers running (keep-apps, docker adoption) then autostarts
        // an app whose record already says `running` — and it would fail on its own ports.
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));

        // Hold a port and reserve it for the app, exactly as its surviving container would.
        using var holder = new TcpListener(IPAddress.Loopback, 0);
        holder.Start();
        var heldPort = ((IPEndPoint)holder.LocalEndpoint).Port;
        await fixture.Apps.UpdateAppAsync("com.example.notes", current => current with
        {
            RuntimeState = AppRuntimeStates.Running,
            PortAssignments = [ReassignAssignment("app", "http", heldPort)],
        });

        await fixture.Service.StartAsync("com.example.notes"); // must not throw runtime_port_unavailable

        Assert.Equal(AppRuntimeStates.Running, (await fixture.Apps.GetAppAsync("com.example.notes"))!.RuntimeState);
    }

    [Fact]
    public async Task StartAsync_WhenTheRequestIsCancelled_DoesNotStrandATransitionalState()
    {
        // A client disconnect after the stamp used to leave the record on `starting` with the lock
        // already released: no reconciler observes a non-IsUp record, so it sat there until the next
        // boot sweep and the Shell kept its lifecycle controls disabled.
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        await fixture.Service.StopAsync("com.example.notes");

        using var cts = new CancellationTokenSource();
        fixture.Adapter.StartProbe = () =>
        {
            cts.Cancel();
            cts.Token.ThrowIfCancellationRequested();
            return Task.CompletedTask;
        };

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => fixture.Service.StartAsync("com.example.notes", cts.Token));

        var settled = (await fixture.Apps.GetAppAsync("com.example.notes"))!;
        Assert.False(AppRuntimeStates.IsBusy(settled.RuntimeState));
        Assert.Equal(AppRuntimeStates.Unknown, settled.RuntimeState);
    }

    [Fact]
    public async Task StopAsync_WhenTheRequestIsCancelled_DoesNotStrandATransitionalState()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));

        using var cts = new CancellationTokenSource();
        fixture.Adapter.StopProbe = () =>
        {
            cts.Cancel();
            cts.Token.ThrowIfCancellationRequested();
            return Task.CompletedTask;
        };

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => fixture.Service.StopAsync("com.example.notes", cts.Token));

        var settled = (await fixture.Apps.GetAppAsync("com.example.notes"))!;
        Assert.False(AppRuntimeStates.IsBusy(settled.RuntimeState));
        Assert.Equal(AppRuntimeStates.Unknown, settled.RuntimeState);
    }

    [Fact]
    public async Task StartAsync_PersistsStartingWhileTheVerbIsInFlight()
    {
        // The whole point of the feature: the record — not just the clicking tab — says a start is
        // happening, so a second admin, a reloaded page and the CLI all see it.
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        await fixture.Service.StopAsync("com.example.notes");

        string? observed = null;
        fixture.Adapter.StartProbe = async () =>
            observed = (await fixture.Apps.GetAppAsync("com.example.notes"))!.RuntimeState;
        await fixture.Service.StartAsync("com.example.notes");

        Assert.Equal(AppRuntimeStates.Starting, observed);
        Assert.Equal(AppRuntimeStates.Running, (await fixture.Apps.GetAppAsync("com.example.notes"))!.RuntimeState);
    }

    [Fact]
    public async Task StopAsync_PersistsStoppingWhileTheVerbIsInFlight()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));

        string? observed = null;
        fixture.Adapter.StopProbe = async () =>
            observed = (await fixture.Apps.GetAppAsync("com.example.notes"))!.RuntimeState;
        await fixture.Service.StopAsync("com.example.notes");

        Assert.Equal(AppRuntimeStates.Stopping, observed);
        Assert.Equal(AppRuntimeStates.Stopped, (await fixture.Apps.GetAppAsync("com.example.notes"))!.RuntimeState);
    }

    [Fact]
    public async Task StopAsync_WhenTheRuntimeFails_LeavesATerminalStateNotStopping()
    {
        // Stop had no failure path at all before transitional states existed, because a throw simply
        // left the record on its previous value. Now a throw would strand it on `stopping` forever: no
        // reconciler observes a non-IsUp record, so nothing downstream would ever correct it.
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        fixture.Adapter.FailOnStopCount = fixture.Adapter.StopCount + 1;

        await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Service.StopAsync("com.example.notes"));

        var app = (await fixture.Apps.GetAppAsync("com.example.notes"))!;
        Assert.Equal(AppRuntimeStates.Unknown, app.RuntimeState);
        Assert.False(AppRuntimeStates.IsBusy(app.RuntimeState));
        Assert.Equal("failed", app.OperationStatus);
    }

    [Fact]
    public async Task RecoverStrandedLifecycleStatesAsync_ResetsAStateLeftMidTransition()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        // Exactly what a Core killed mid-start leaves behind.
        await fixture.Apps.UpdateAppAsync("com.example.notes", app => app with { RuntimeState = AppRuntimeStates.Starting });

        var recovered = await fixture.Service.RecoverStrandedLifecycleStatesAsync();

        Assert.Equal(1, recovered);
        Assert.Equal(AppRuntimeStates.Unknown, (await fixture.Apps.GetAppAsync("com.example.notes"))!.RuntimeState);
    }

    [Fact]
    public async Task RecoverStrandedLifecycleStatesAsync_LeavesATerminalStateAlone()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        var before = (await fixture.Apps.GetAppAsync("com.example.notes"))!.RuntimeState;
        Assert.False(AppRuntimeStates.IsBusy(before));

        var recovered = await fixture.Service.RecoverStrandedLifecycleStatesAsync();

        Assert.Equal(0, recovered);
        Assert.Equal(before, (await fixture.Apps.GetAppAsync("com.example.notes"))!.RuntimeState);
    }

    [Fact]
    public async Task RecoverStrandedLifecycleStatesAsync_SkipsAnAppWhoseVerbIsStillInFlight()
    {
        // Core serves requests while this sweep runs, so a start that is legitimately mid-flight must
        // not be stamped over — that would be the very corruption the sweep exists to remove.
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        await fixture.Service.StopAsync("com.example.notes");

        var recovered = -1;
        fixture.Adapter.StartProbe = async () => recovered = await fixture.Service.RecoverStrandedLifecycleStatesAsync();
        await fixture.Service.StartAsync("com.example.notes");

        Assert.Equal(0, recovered);
        Assert.Equal(AppRuntimeStates.Running, (await fixture.Apps.GetAppAsync("com.example.notes"))!.RuntimeState);
    }

    [Fact]
    public async Task RestoreBackupAsync_RefusesWhileTheAppIsStillStopping()
    {
        // IsIdle, not !IsUp: restoring over the data directory of an app that is still shutting down
        // races the runtime for those files. The old gate compared against "running" and let this pass.
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        await fixture.Apps.UpdateAppAsync("com.example.notes", app => app with { RuntimeState = AppRuntimeStates.Stopping });

        var error = await Assert.ThrowsAsync<AppLifecycleException>(
            () => fixture.Service.RestoreBackupAsync("com.example.notes", "any", new AppRestoreBackupRequest()));

        Assert.Equal("app_must_be_stopped", error.Code);
    }

    [Fact]
    public void ResolveRuntimeStateFromHealth_NeverProducesATransitionalState()
    {
        // The two vocabularies share the token "starting" but not its meaning: container health
        // "starting" means the container is already up with a pending HEALTHCHECK, so it must map to
        // `running`. If this mapper could emit an app-level transitional value, the supervisor and a
        // lifecycle verb would fight over the record.
        foreach (var status in new[] { "healthy", "degraded", "starting", "stopped", "unhealthy", "unknown", "" })
        {
            var resolved = CoreLifecycleService.ResolveRuntimeStateFromHealth(new AppRuntimeHealthResult(status, []));
            Assert.False(AppRuntimeStates.IsBusy(resolved));
        }

        Assert.Equal(
            AppRuntimeStates.Running,
            CoreLifecycleService.ResolveRuntimeStateFromHealth(new AppRuntimeHealthResult("starting", [])));
    }

    [Fact]
    public async Task ListAppsAsync_ProjectsDependencyStateForEveryMatrixRow()
    {
        // The whole point of the projection: Core reports STATE, never a verdict, so one shape serves
        // the required/optional split the client renders as red/amber/nothing.
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Apps.UpsertAppAsync(SeedReassignApp(
            "com.example.provider-running",
            "running",
            endpoints: [ReassignEndpoint("app", "control", "http://127.0.0.1:7100")]));
        await fixture.Apps.UpsertAppAsync(SeedReassignApp("com.example.provider-stopped", "stopped"));
        await fixture.Apps.UpsertAppAsync(SeedReassignApp(
            "com.example.consumer",
            "running",
            dependencies:
            [
                new AppDependencyContract("com.example.provider-running", "^1.0.0", Required: true,
                    [new AppDependencyEndpointContract("app.control", "ctl")]),
                new AppDependencyContract("com.example.provider-stopped", null, Required: true, []),
                new AppDependencyContract("com.example.absent", null, Required: false, []),
            ]));

        var consumer = (await fixture.Service.ListAppsAsync()).Single(app => app.Id == "com.example.consumer");

        var dependencies = Assert.IsAssignableFrom<IReadOnlyList<AppDependencySummary>>(consumer.Dependencies);
        Assert.Equal(3, dependencies.Count);

        var running = dependencies.Single(d => d.AppId == "com.example.provider-running");
        Assert.True(running.Installed);
        Assert.True(running.Running);
        Assert.True(running.Required);
        Assert.Equal("^1.0.0", running.Version);
        var wired = Assert.Single(running.Endpoints);
        Assert.Equal("ctl", wired.Alias);
        Assert.True(wired.Resolved);

        var stopped = dependencies.Single(d => d.AppId == "com.example.provider-stopped");
        Assert.True(stopped.Installed);
        Assert.False(stopped.Running);

        var absent = dependencies.Single(d => d.AppId == "com.example.absent");
        Assert.False(absent.Installed);
        Assert.False(absent.Running);
        Assert.False(absent.Required);
    }

    [Fact]
    public async Task ListAppsAsync_ReportsAWiredEndpointWithNoUrlAsUnresolved()
    {
        // A running provider whose wired endpoint has no URL (typically a typo'd key) silently drops
        // HOSTY_DEPENDENCY_{ALIAS}_URL at injection, so it has to stay visible after the advisory is gone.
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Apps.UpsertAppAsync(SeedReassignApp(
            "com.example.provider",
            "running",
            endpoints: [ReassignEndpoint("app", "control", null)]));
        await fixture.Apps.UpsertAppAsync(SeedReassignApp(
            "com.example.consumer",
            "running",
            dependencies:
            [
                new AppDependencyContract("com.example.provider", null, Required: true,
                    [new AppDependencyEndpointContract("typo", "ctl")]),
            ]));

        var consumer = (await fixture.Service.ListAppsAsync()).Single(app => app.Id == "com.example.consumer");

        var dependency = Assert.Single(consumer.Dependencies!);
        Assert.True(dependency.Running);
        Assert.False(Assert.Single(dependency.Endpoints).Resolved);
    }

    [Fact]
    public async Task ListAppsAsync_OmitsDependenciesWhenNoneAreDeclared()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Apps.UpsertAppAsync(SeedReassignApp("com.example.solo", "running"));

        var solo = (await fixture.Service.ListAppsAsync()).Single(app => app.Id == "com.example.solo");

        Assert.Null(solo.Dependencies);
    }

    private static AppRecord SeedReassignApp(
        string id,
        string runtimeState,
        IReadOnlyList<AppPortAssignment>? assignments = null,
        IReadOnlyList<AppEndpointContract>? endpoints = null,
        IReadOnlyList<AppDependencyContract>? dependencies = null)
        => new(
            Id: id,
            DisplayName: id,
            Description: null,
            Version: "1.0.0",
            Kind: "runtime",
            System: false,
            Source: "installed",
            ManifestPath: null,
            ManifestUrl: null,
            SelectedRuntime: "docker",
            OperationStatus: "installed",
            RuntimeState: runtimeState,
            LastOperation: null,
            LastError: null,
            Capabilities: [],
            Settings: new Dictionary<string, AppSettingValue>(),
            StorageMappings: [],
            Dependencies: dependencies ?? [],
            Endpoints: endpoints ?? [],
            InstalledAt: DateTimeOffset.UtcNow,
            UpdatedAt: DateTimeOffset.UtcNow,
            PortAssignments: assignments);

    private static AppPortAssignment ReassignAssignment(string service, string key, int port, string? source = null, bool remappable = true)
        => new(service, key, port, AppPortTransports.Tcp, AppPortBindScopes.Loopback, source ?? AppPortSources.Automatic, remappable, DateTimeOffset.UnixEpoch);

    private static AppEndpointContract ReassignEndpoint(string service, string key, string? url)
        => new($"{service}.{key}", "http", url, Public: true, Service: service, Port: key);

    [Fact]
    public async Task InstallAsync_WithPlanId_InstallsTheReviewedBytesNotTheCurrentFile()
    {
        // The C-CR1 adversarial case: the source answers the plan with manifest A and the apply with
        // manifest B. A bound apply must install exactly A — the reviewed bytes — or nothing.
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        var plan = await fixture.Service.CreateInstallPlanAsync(new AppInstallPlanRequest(manifest));
        Assert.NotNull(plan.PlanId);

        var swapped = await fixture.WriteManifestAsync("2.0.0");
        File.Copy(swapped, manifest, overwrite: true);

        var response = await fixture.Service.InstallAsync(new AppInstallRequest(manifest, PlanId: plan.PlanId));

        Assert.Equal("1.0.0", response.App?.Version);
        var vendoredCopy = await File.ReadAllTextAsync(Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "manifest.json"));
        Assert.Contains("1.0.0", vendoredCopy);
        Assert.DoesNotContain("2.0.0", vendoredCopy);
    }

    [Fact]
    public async Task InstallAsync_WithUnknownPlanId_Rejects()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");

        var ex = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.InstallAsync(new AppInstallRequest(manifest, PlanId: "instp_missing")));

        Assert.Equal("install_plan_expired", ex.Code);
    }

    [Fact]
    public async Task InstallAsync_PlanIdIsSingleUse()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        var plan = await fixture.Service.CreateInstallPlanAsync(new AppInstallPlanRequest(manifest));

        _ = await fixture.Service.InstallAsync(new AppInstallRequest(manifest, PlanId: plan.PlanId));
        await fixture.Service.RemoveAsync("com.example.notes", new AppRemoveRequest());
        var second = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.InstallAsync(new AppInstallRequest(manifest, PlanId: plan.PlanId)));

        Assert.Equal("install_plan_expired", second.Code);
    }

    [Fact]
    public async Task InstallAsync_WithExpiredPlan_Rejects()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        var plan = await fixture.Service.CreateInstallPlanAsync(new AppInstallPlanRequest(manifest));

        fixture.Clock.UtcNow += TimeSpan.FromMinutes(61);

        var ex = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.InstallAsync(new AppInstallRequest(manifest, PlanId: plan.PlanId)));

        Assert.Equal("install_plan_expired", ex.Code);
    }

    [Fact]
    public async Task InstallAsync_WithPlanId_BindsSystemnessFromTheReviewedPlan()
    {
        // What was reviewed is what installs: an apply that claims System=false cannot demote a plan
        // that was reviewed as a system install (and vice versa a plain apply cannot escalate).
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        var plan = await fixture.Service.CreateInstallPlanAsync(new AppInstallPlanRequest(manifest, System: true));

        _ = await fixture.Service.InstallAsync(new AppInstallRequest(manifest, System: false, PlanId: plan.PlanId));

        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.True(app!.System);
    }

    [Fact]
    public async Task CreateInstallPlanAsync_CapsPendingPlansByEvictingTheOldest()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");

        var first = await fixture.Service.CreateInstallPlanAsync(new AppInstallPlanRequest(manifest));
        for (var i = 0; i < 64; i++)
        {
            fixture.Clock.UtcNow += TimeSpan.FromSeconds(1);
            _ = await fixture.Service.CreateInstallPlanAsync(new AppInstallPlanRequest(manifest));
        }

        // 65 plans minted against a cap of 64: the first (oldest) one is gone, applying it re-reviews.
        var ex = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.InstallAsync(new AppInstallRequest(manifest, PlanId: first.PlanId)));

        Assert.Equal("install_plan_expired", ex.Code);
    }

    [Fact]
    public async Task InstallAsync_WithPlanId_PinsThePlanTimeDigestNotTheApplyTimeOne()
    {
        // The C-CR1 Fix B adversarial case for installs: the registry answers the plan with digest A
        // and would answer a start-time resolve with digest B. The bound apply pins A — the digest
        // the operator reviewed — so the first start runs A.
        var fixture = await LifecycleFixture.CreateAsync();
        var planned = "sha256:" + new string('a', 64);
        var repushed = "sha256:" + new string('b', 64);
        fixture.Adapter.RemoteDigest = planned;
        var manifest = await fixture.WriteManifestAsync("1.0.0");

        var plan = await fixture.Service.CreateInstallPlanAsync(new AppInstallPlanRequest(manifest));
        var surfaced = Assert.Single(plan.ArtifactDigests ?? []);
        Assert.Equal(planned, surfaced.CandidateDigest);

        fixture.Adapter.RemoteDigest = repushed;
        _ = await fixture.Service.InstallAsync(new AppInstallRequest(manifest, PlanId: plan.PlanId));

        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        var installLock = Assert.Single(app!.ArtifactLocks!).Value;
        Assert.Equal(planned, installLock.ImageDigest);
        Assert.Equal("image", installLock.Kind);
    }

    [Fact]
    public async Task InstallAsync_WithUnresolvablePlanDigest_LeavesTheLockForStartTimeBackfill()
    {
        // Offline registry / local-only image: the plan shows no digest, so there is nothing reviewed
        // to pin — first start TOFU-backfills exactly as before.
        var fixture = await LifecycleFixture.CreateAsync();
        fixture.Adapter.RemoteDigest = null;
        var manifest = await fixture.WriteManifestAsync("1.0.0");

        var plan = await fixture.Service.CreateInstallPlanAsync(new AppInstallPlanRequest(manifest));
        _ = await fixture.Service.InstallAsync(new AppInstallRequest(manifest, PlanId: plan.PlanId));

        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Null(app!.ArtifactLocks);
    }

    [Fact]
    public async Task ApplyUpdateAsync_PersistsTheReviewedCandidateDigestAsTheLock()
    {
        // The plan surfaced artifact:{svc}:{old}->{candidate}; apply must persist that candidate as
        // the run-lock. A tag re-pushed between apply and start previously swapped unreviewed bytes
        // in, because apply dropped the lock and start re-resolved the tag.
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        var reviewedDigest = "sha256:" + new string('c', 64);
        fixture.Adapter.RemoteDigest = reviewedDigest;
        var target = await fixture.WriteManifestAsync("2.0.0");

        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(target));
        fixture.Adapter.RemoteDigest = "sha256:" + new string('d', 64);
        _ = await fixture.Service.ApplyUpdateAsync("com.example.notes", new AppUpdateApplyRequest(plan.PlanDigest));

        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        var updateLock = Assert.Single(app!.ArtifactLocks!).Value;
        Assert.Equal(reviewedDigest, updateLock.ImageDigest);
    }

    [Fact]
    public async Task RehomeOsAllocatedPortsAsync_MovesAutomaticPortIntoTheBandAndCarriesTheEndpointUrl()
    {
        // Every automatic port allocated before 0.76.0 came from a port-0 bind, i.e. out of the range the
        // OS hands to every outbound connection on the host — a reservation only ever on loan. The
        // operator's own pin is in that range too, and must survive untouched: they may have a firewall
        // rule on it.
        var fixture = await LifecycleFixture.CreateAsync(withPortAllocator: true);
        await SeedRehomableAppAsync(fixture);

        Assert.Equal(1, await fixture.Service.RehomeOsAllocatedPortsAsync());

        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        var moved = Assert.Single(app!.PortAssignments!, assignment => assignment.Service == "app");
        Assert.False(RuntimePortHelper.IsOsDynamicRangePort(moved.HostPort));
        Assert.InRange(moved.HostPort, RuntimePortHelper.AutomaticPortRangeStart, RuntimePortHelper.OsDynamicPortFloor - 1);
        Assert.Equal(AppPortSources.Automatic, moved.Source);
        Assert.True(moved.Remappable);
        // The URL is the app's durable address; leaving it on the old port would be worse than not moving.
        Assert.Equal($"http://localhost:{moved.HostPort}", Assert.Single(app.Endpoints, endpoint => endpoint.Service == "app").Url);

        var pinned = Assert.Single(app.PortAssignments!, assignment => assignment.Service == "admin");
        Assert.Equal(52999, pinned.HostPort);
        Assert.Equal("http://localhost:52999", Assert.Single(app.Endpoints, endpoint => endpoint.Service == "admin").Url);
    }

    [Fact]
    public async Task RehomeOsAllocatedPortsAsync_SecondRun_ChangesNothing()
    {
        // Selection is by port range, so a rehomed record stops matching. Without that, every boot would
        // churn endpoint URLs and invalidate dependents' injected addresses for no reason.
        var fixture = await LifecycleFixture.CreateAsync(withPortAllocator: true);
        await SeedRehomableAppAsync(fixture);
        await fixture.Service.RehomeOsAllocatedPortsAsync();
        var afterFirst = await fixture.Apps.GetAppAsync("com.example.notes");

        Assert.Equal(0, await fixture.Service.RehomeOsAllocatedPortsAsync());

        var afterSecond = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal(
            afterFirst!.PortAssignments!.Select(assignment => assignment.HostPort),
            afterSecond!.PortAssignments!.Select(assignment => assignment.HostPort));
    }

    [Fact]
    public async Task RehomeOsAllocatedPortsAsync_SeveralPortsOnOneApp_AllMoveAndStayDistinct()
    {
        // Each move persists a new revision, so the next one has to allocate against the record as
        // written — otherwise two ports on the same app could be handed the same number. The loop is also
        // bounded by a target list captured once: re-deriving it per round would never terminate if the
        // allocator fell back to another OS-range port.
        var fixture = await LifecycleFixture.CreateAsync(withPortAllocator: true);
        await SeedRehomableAppAsync(fixture, extraAutomaticPort: 52307);

        Assert.Equal(2, await fixture.Service.RehomeOsAllocatedPortsAsync());

        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        var moved = app!.PortAssignments!
            .Where(assignment => assignment.Source == AppPortSources.Automatic)
            .Select(assignment => assignment.HostPort)
            .ToArray();
        Assert.Equal(2, moved.Length);
        Assert.Equal(2, moved.Distinct().Count());
        Assert.All(moved, port => Assert.False(RuntimePortHelper.IsOsDynamicRangePort(port)));
    }

    [Fact]
    public async Task RehomeOsAllocatedPortsAsync_LegacyManifestPin_IsLeftAlone()
    {
        // The boot backfill derives assignments from stored endpoint URLs and classifies anything without
        // a matching HOSTY_PORT_* setting as `automatic`, because a URL cannot say whether Core chose the
        // port or the manifest declared it. A legacy record whose manifest pins a port in the dynamic
        // range therefore *looks* remappable — moving it would break the firewall rule or router forward
        // the operator built around that number.
        var fixture = await LifecycleFixture.CreateAsync(withPortAllocator: true);
        await SeedRehomableAppAsync(fixture);
        await WriteManifestCopyPinningAppHttpAsync(fixture, 52306);

        Assert.Equal(0, await fixture.Service.RehomeOsAllocatedPortsAsync());

        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal(52306, Assert.Single(app!.PortAssignments!, assignment => assignment.Service == "app").HostPort);
        Assert.Equal("http://localhost:52306", Assert.Single(app.Endpoints, endpoint => endpoint.Service == "app").Url);
    }

    [Fact]
    public async Task RehomeOsAllocatedPortsAsync_ManifestPinningAnotherKey_StillMovesTheAutomaticOne()
    {
        // The skip is per (service, port key), not per app: a manifest that pins one port must not freeze
        // the app's genuinely automatic ones.
        var fixture = await LifecycleFixture.CreateAsync(withPortAllocator: true);
        await SeedRehomableAppAsync(fixture, extraAutomaticPort: 52307);
        await WriteManifestCopyPinningAppHttpAsync(fixture, 52306);

        Assert.Equal(1, await fixture.Service.RehomeOsAllocatedPortsAsync());

        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal(52306, Assert.Single(app!.PortAssignments!, assignment => assignment.Service == "app").HostPort);
        var worker = Assert.Single(app.PortAssignments!, assignment => assignment.Service == "worker");
        Assert.False(RuntimePortHelper.IsOsDynamicRangePort(worker.HostPort));
    }

    // The reviewed manifest copy Core keeps beside the app, declaring `app.http` with an explicit
    // localPort — the shape the rehoming pass has to read to recognise a legacy pin.
    private static async Task WriteManifestCopyPinningAppHttpAsync(LifecycleFixture fixture, int localPort)
    {
        var appRoot = Path.Combine(fixture.Paths.AppsRoot, "com.example.notes");
        Directory.CreateDirectory(appRoot);
        await File.WriteAllTextAsync(Path.Combine(appRoot, "manifest.json"), $$"""
        {
          "schemaVersion": "app.0.1",
          "id": "com.example.notes",
          "name": "Notes",
          "version": "1.0.0",
          "runtimeProfiles": [{ "key": "docker", "type": "docker", "default": true }],
          "defaultRuntime": "docker",
          "services": [{
            "key": "app",
            "runtimes": {
              "docker": {
                "type": "docker",
                "image": "example/notes:1.0.0",
                "ports": [{ "key": "http", "containerPort": 8080, "localPort": {{localPort}} }]
              }
            }
          }]
        }
        """);
    }

    [Fact]
    public async Task RehomeOsAllocatedPortsAsync_RunningApp_KeepsItsPort()
    {
        // Core may have adopted a live listener (keep-apps light restart, docker adoption) before this
        // pass runs. Moving the reservation would leave the record disagreeing with the process actually
        // serving; the app is retried on a later boot, when it is down.
        var fixture = await LifecycleFixture.CreateAsync(withPortAllocator: true);
        await SeedRehomableAppAsync(fixture, runtimeState: AppRuntimeStates.Running);

        Assert.Equal(0, await fixture.Service.RehomeOsAllocatedPortsAsync());

        var app = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal(52306, Assert.Single(app!.PortAssignments!, assignment => assignment.Service == "app").HostPort);
    }

    // A record in the pre-0.76.0 shape: one automatic reservation the OS handed out, plus an operator pin
    // that happens to sit in the same range. Seeded directly rather than installed, because the rehoming
    // pass reads nothing but the record.
    private static async Task SeedRehomableAppAsync(
        LifecycleFixture fixture,
        string runtimeState = AppRuntimeStates.Stopped,
        int? extraAutomaticPort = null)
    {
        AppEndpointContract[] extraEndpoints = extraAutomaticPort is { } extraPort
            ? [new AppEndpointContract("worker.http", "http", $"http://localhost:{extraPort}", Public: false, Service: "worker", Port: "http")]
            : [];
        AppPortAssignment[] extraAssignments = extraAutomaticPort is { } extra
            ? [new AppPortAssignment("worker", "http", extra, AppPortTransports.Tcp, AppPortBindScopes.Loopback, AppPortSources.Automatic, Remappable: true, AssignedAt: DateTimeOffset.UnixEpoch)]
            : [];

        await fixture.Apps.UpsertAppAsync(new AppRecord(
            Id: "com.example.notes",
            DisplayName: "Notes",
            Description: null,
            Version: "1.0.0",
            Kind: "runtime",
            System: false,
            Source: "installed",
            ManifestPath: null,
            ManifestUrl: null,
            SelectedRuntime: "docker",
            OperationStatus: "installed",
            RuntimeState: runtimeState,
            LastOperation: null,
            LastError: null,
            Capabilities: [],
            Settings: new Dictionary<string, AppSettingValue>(StringComparer.Ordinal)
            {
                ["HOSTY_PORT_ADMIN_HTTP"] = new("HOSTY_PORT_ADMIN_HTTP", "string", "52999", Secret: false),
            },
            StorageMappings: [],
            Dependencies: [],
            Endpoints:
            [
                new AppEndpointContract("app.http", "http", "http://localhost:52306", Public: true, Service: "app", Port: "http"),
                new AppEndpointContract("admin.http", "http", "http://localhost:52999", Public: false, Service: "admin", Port: "http"),
                .. extraEndpoints,
            ],
            InstalledAt: DateTimeOffset.UtcNow,
            UpdatedAt: DateTimeOffset.UtcNow)
        {
            PortAssignments =
            [
                new AppPortAssignment("app", "http", 52306, AppPortTransports.Tcp, AppPortBindScopes.Loopback, AppPortSources.Automatic, Remappable: true, AssignedAt: DateTimeOffset.UnixEpoch),
                new AppPortAssignment("admin", "http", 52999, AppPortTransports.Tcp, AppPortBindScopes.Loopback, AppPortSources.Operator, Remappable: false, AssignedAt: DateTimeOffset.UnixEpoch),
                .. extraAssignments,
            ],
        });
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
            FakeClock clock,
            CoreSettingsService coreSettings,
            CloudflarePublicationStore publications)
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
            CoreSettings = coreSettings;
            Publications = publications;
        }

        public string Root { get; }

        public CoreDataPaths Paths { get; }

        public AppRegistryStore Apps { get; }

        public AppBackupService Backups { get; }

        public AppManifestService Manifests { get; }

        public AppSourceService Sources { get; }

        public CoreLifecycleService Service { get; }

        // The live Core settings the fixture's ingress controller and public-origin ownership read, so a
        // test can switch the ingress provider the same way an operator does.
        public CoreSettingsService CoreSettings { get; }

        // The publication store that decides, under the API provider, which origins are already owned.
        public CloudflarePublicationStore Publications { get; }

        public RecordingRuntimeAdapter Adapter { get; }

        public LocalCommandProcessRegistry LocalProcesses { get; }

        public FakeClock Clock { get; }

        public static async Task<LifecycleFixture> CreateAsync(
            AppManifestService? manifests = null,
            string? ingressBaseDomain = null,
            bool withPortAllocator = false,
            // Shrinks the self-restart port-release window so a test can reach the give-up path in
            // milliseconds instead of the production 15s. Null keeps the production window.
            TimeSpan? selfRestartPortReleaseTimeout = null)
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
                ListenUrl: "http://127.0.0.1:3001",
                CorePublicOrigin: "http://127.0.0.1:3001",
                RuntimePublicHost: "localhost",
                ShellSourceOverridePath: null,
                ShellAutostart: false,
                IngressConfigPath: Path.Combine(root, "core", "ingress", "config.yml"));
            var localProcesses = new LocalCommandProcessRegistry();
            var appServiceTokens = new AppServiceTokenService(new AppServiceSigningKey("test-control-secret"u8.ToArray()));
            var localAdapter = new LocalCommandRuntimeAdapter(runtimeConfig, localProcesses, appServiceTokens);
            // Ingress config is now a live Core setting (CoreSettingsService), not baked into the runtime
            // config, so seed the cloudflared provider through the settings store the controller reads.
            var coreSettings = new CoreSettingsService(new CoreSettingsStore(paths, Microsoft.Extensions.Logging.Abstractions.NullLogger<CoreSettingsStore>.Instance));
            if (ingressBaseDomain is not null)
            {
                await coreSettings.UpdateAsync(new Dictionary<string, string?>
                {
                    ["HOSTY_INGRESS_PROVIDER"] = "cloudflared",
                    ["HOSTY_INGRESS_BASE_DOMAIN"] = ingressBaseDomain,
                    ["HOSTY_INGRESS_TUNNEL_ID"] = "test-tunnel",
                    ["HOSTY_INGRESS_CREDENTIALS_FILE"] = Path.Combine(root, "creds.json"),
                });
            }

            IIngressController ingress = new CloudflaredIngressController(coreSettings, runtimeConfig, Microsoft.Extensions.Logging.Abstractions.NullLogger<CloudflaredIngressController>.Instance);
            var portAllocator = withPortAllocator ? new RuntimePortAllocator(runtimeConfig) : null;
            var publications = new CloudflarePublicationStore(paths);
            var publicOrigins = new PublicOriginOwnership(coreSettings, publications);
            var service = new CoreLifecycleService(paths, apps, manifests, backups, sources, [adapter, localAdapter], ingress, Microsoft.Extensions.Logging.Abstractions.NullLogger<CoreLifecycleService>.Instance, notifications: null, clock: clock, portAllocator: portAllocator, selfRestartPortReleaseTimeout: selfRestartPortReleaseTimeout, publicOrigins: publicOrigins);
            return new LifecycleFixture(root, paths, apps, backups, manifests, sources, service, adapter, localProcesses, clock, coreSettings, publications);
        }

        // Shared-mounts library over the same data root the lifecycle service reads from.
        public GlobalMountService CreateGlobalMountService()
            => new(new GlobalMountStore(Paths), Apps, new MountPathPolicy(Paths));

        public async Task<string> WriteManifestAsync(
            string version,
            bool includeDependency = false,
            string? sourceRepository = null,
            string? settingsJson = null,
            string? externalMountsJson = null,
            string? networkJson = null,
            string? capabilitiesJson = null,
            string? interfacesJson = null,
            string id = "com.example.notes",
            string name = "Notes",
            string? cacheJson = null)
        {
            var path = Path.Combine(Root, $"{id}-{version}.json");
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
                  "id": "{{id}}",
                  "name": "{{name}}",
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
                  {{capabilitiesJson ?? ""}}
                  {{interfacesJson ?? ""}}
                  {{cacheJson ?? ""}}
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

    private sealed class RecordingRuntimeAdapter : IAppRuntimeAdapter, IImageDigestResolver, IRunningContainerProbe
    {
        public string Type => "docker";

        // App ids the fake docker daemon reports as having a running labelled container (C-M1 sweep).
        public HashSet<string> RunningAppIds { get; } = new(StringComparer.Ordinal);

        public Task<IReadOnlySet<string>> ListRunningAppIdsAsync(CancellationToken cancellationToken = default)
            => Task.FromResult<IReadOnlySet<string>>(RunningAppIds);

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

        // Awaited inside the verb, so a test can observe the record exactly while the operation is in
        // flight — which is the only moment the transitional state is persisted.
        public Func<Task>? StartProbe { get; set; }

        public Func<Task>? StopProbe { get; set; }

        public int? FailOnStopCount { get; set; }

        public async Task<AppRuntimeStartResult> StartAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
        {
            StartCount++;
            LastContext = context;
            if (StartProbe is { } probe)
            {
                await probe();
            }

            if (FailOnStartCount == StartCount)
            {
                throw new AppLifecycleException("runtime_start_failed", "Runtime failed to start.");
            }

            OnStarted?.Invoke();
            return new AppRuntimeStartResult(
                "running",
                [new AppEndpointContract("app.http", "http", "http://localhost:3100", Public: true, Service: "app", Port: "http")],
                StartLocks);
        }

        public Task<string?> ResolveRemoteDigestAsync(RuntimeDockerImage image, CancellationToken cancellationToken = default)
            => Task.FromResult(RemoteDigest);

        // When set, StopAsync waits for this gate before answering — lets a test hold a background
        // update apply deterministically "in flight".
        public Task? StopGate { get; set; }

        public async Task<AppRuntimeOperationResult> StopAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
        {
            StopCount++;
            if (StopProbe is { } probe)
            {
                await probe();
            }

            if (StopGate is { } gate)
            {
                await gate;
            }

            if (FailOnStopCount == StopCount)
            {
                throw new AppLifecycleException("runtime_stop_failed", "Runtime failed to stop.");
            }

            return new AppRuntimeOperationResult("stopped");
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
