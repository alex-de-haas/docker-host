using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static AppDevActor DevActor(WorkspaceOwner owner) => new(owner.UserId, "test-assistant", owner);
    private static AppDevRequest DevRequest(string action, string? tree = null, bool accept = false)
        => new(Guid.NewGuid().ToString("D"), action, action == "enter" ? "dev" : null, tree, AcceptDataChanges: accept);
    private static async Task<AppDevStatus> ApplyReviewedDev(CoreLifecycleService service, AppDevRequest request, AppDevActor actor)
    {
        var plan = await service.PlanDevModeAsync("test.created", request, actor);
        return await service.ApplyDevModeAsync("test.created", request with { PlanDigest = plan.PlanDigest }, actor);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DevMode_LiveWorktreeReturnsExactSourceAndRunningStateWithoutDiscardingData(bool running)
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        if (running) await f.Service.StartAsync("test.created");
        var before = (await f.Apps.GetAppAsync("test.created"))!;
        var data = Path.Combine(f.Paths.AppsRoot, "test.created", "data", "notes.json");
        Directory.CreateDirectory(Path.GetDirectoryName(data)!); await File.WriteAllTextAsync(data, "ordinary-user-data");
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "uncommitted.txt"), "keep this edit");
        await workspaces.CommandAsync(tree.Id, owner, "lease", new(Guid.NewGuid().ToString(), LeaseId: Guid.NewGuid().ToString()), default);
        var request = DevRequest("enter", tree.Id); var actor = DevActor(owner);
        var plan = await f.Service.PlanDevModeAsync("test.created", request, actor);
        request = request with { PlanDigest = plan.PlanDigest };
        var active = await f.Service.ApplyDevModeAsync("test.created", request, actor);
        Assert.Equal("active", active.Phase); Assert.Equal("running", active.App.RuntimeState);
        Assert.Equal(before.InstalledAt, (await f.Apps.GetAppAsync("test.created"))!.InstalledAt);
        Assert.Equal(tree.Path, (await f.Apps.GetAppAsync("test.created"))!.SourceState!.LocalOverridePath);
        Assert.Single(await f.Backups.ListBackupsAsync("test.created"));
        var repeat = await f.Service.ApplyDevModeAsync("test.created", request, actor);
        Assert.Equal(active.OperationId, repeat.OperationId); Assert.Single(await f.Backups.ListBackupsAsync("test.created"));
        await File.WriteAllTextAsync(data, "ordinary-data-after-live-edit");
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "uncommitted.txt"), "keep later edit");
        var restored = await ApplyReviewedDev(f.Service, DevRequest("return", accept: true), actor);
        Assert.Equal("returned", restored.Phase); Assert.Equal(running ? "running" : "stopped", restored.App.RuntimeState);
        var after = (await f.Apps.GetAppAsync("test.created"))!;
        Assert.Equal(before.SourceState, after.SourceState); Assert.Equal(before.Autostart, after.Autostart);
        Assert.Equal("ordinary-data-after-live-edit", await File.ReadAllTextAsync(data));
        Assert.Equal("keep later edit", await File.ReadAllTextAsync(Path.Combine(tree.Path, "uncommitted.txt")));
        Assert.Equal(before.SelectedRuntime, after.SelectedRuntime);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DevMode_PreservesOriginalManifestSourceAcrossEntryAndReturn(bool capturedSource)
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        var original = (await f.Apps.GetAppAsync("test.created"))!.InstallManifestPath;
        if (!capturedSource) await f.Apps.UpdateAppAsync("test.created", a => a with { InstallManifestPath = null });
        var expected = capturedSource ? original : null;
        var actor = DevActor(owner);
        await ApplyReviewedDev(f.Service, DevRequest("enter", tree.Id), actor);
        Assert.Equal(expected, (await f.Apps.GetAppAsync("test.created"))!.InstallManifestPath);
        await ApplyReviewedDev(f.Service, DevRequest("return", accept: true), actor);
        Assert.Equal(expected, (await f.Apps.GetAppAsync("test.created"))!.InstallManifestPath);
    }

    private static async Task<(LifecycleFixture Fixture, CoreLifecycleService Service, UserDirectoryStore Users, PrivateSourceService Private)> PrivateDevFixture(bool privateManifest = false)
    {
        var (f, _, _, _, _, _) = await LocalHandoffFixture();
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        var source = app.SourceState!.LocalOverridePath!;
        var repository = new Uri(source).AbsoluteUri;
        var (users, privateSources, grant) = await PrivateDocumentAccessAsync(f, repository);
        if (privateManifest)
        {
            const string url = "https://fixture.example/private/main/manifest.json";
            await f.Apps.UpdateAppAsync(app.Id, a => a with { ManifestUrl = url, PrivateSources = new(Manifest: grant with { ManifestUrl = url }) });
        }
        else
        {
            var manifest = System.Text.Json.Nodes.JsonNode.Parse(await File.ReadAllTextAsync(app.ManifestPath!))!;
            manifest["source"] = new System.Text.Json.Nodes.JsonObject { ["repository"] = repository, ["branch"] = "main" };
            await File.WriteAllTextAsync(app.ManifestPath!, manifest.ToJsonString());
            await File.WriteAllTextAsync(Path.Combine(source, "manifest.json"), manifest.ToJsonString());
            await f.Apps.UpdateAppAsync(app.Id, a => a with { PrivateSources = new(Git: grant) });
        }
        return (f, f.RecreateService(privateSources: privateSources), users, privateSources);
    }

    [Fact]
    public async Task DevMode_TrustedLocalOperatorUsesReviewedPrivateGrantAndStillHonorsRevocation()
    {
        var (f, service, users, _) = await PrivateDevFixture();
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        var request = DevRequest("enter");
        Assert.Equal("dev_source_forbidden", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            service.PlanDevModeAsync(app.Id, request, new("bob", "manual")))).Code);
        var local = new AppDevActor("local-operator", "cli", TrustedLocalOperator: true);
        Assert.Equal("active", (await ApplyReviewedDev(service, request, local)).Phase);
        var starts = f.Adapter.StartCount;
        var stops = f.Adapter.StopCount;
        Assert.Equal("dev_source_authority_required", (await Assert.ThrowsAsync<AppLifecycleException>(() => service.StartAsync(app.Id))).Code);
        Assert.Equal("dev_source_authority_required", (await Assert.ThrowsAsync<AppLifecycleException>(() => service.RestartAsync(app.Id))).Code);
        Assert.Equal(starts, f.Adapter.StartCount); Assert.Equal(stops, f.Adapter.StopCount);
        Assert.Equal("active", (await ApplyReviewedDev(service, DevRequest("restart"), local)).Phase);
        await users.UpdateAsync(s => s with { ProviderConnections = [] });
        Assert.Equal("stopped", (await service.StopAsync(app.Id)).App!.RuntimeState);
        starts = f.Adapter.StartCount;
        Assert.Equal("dev_source_authority_required", (await Assert.ThrowsAsync<AppLifecycleException>(() => service.StartAsync(app.Id))).Code);
        Assert.Equal("dev_source_authority_required", (await Assert.ThrowsAsync<AppLifecycleException>(() => service.RestartAsync(app.Id))).Code);
        Assert.Equal(starts, f.Adapter.StartCount);
        Assert.Equal("stopped", (await f.Apps.GetAppAsync(app.Id))!.RuntimeState);
        Assert.Equal("source_access_required", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            service.PlanDevModeAsync(app.Id, DevRequest("restart"), local))).Code);
        Assert.Equal("returned", (await ApplyReviewedDev(service, DevRequest("return", accept: true), local)).Phase);
    }

    [Theory]
    [InlineData("enter")]
    [InlineData("restart")]
    public async Task DevMode_PendingReplayRechecksPrivateConnectionBeforeRuntimeEffects(string action)
    {
        var (f, service, users, privateSources) = await PrivateDevFixture();
        var actor = new AppDevActor("local-operator", "cli", TrustedLocalOperator: true);
        if (action == "restart") await ApplyReviewedDev(service, DevRequest("enter"), actor);
        var request = DevRequest(action);
        request = request with { PlanDigest = (await service.PlanDevModeAsync("test.created", request, actor)).PlanDigest };
        f.Adapter.StartContextProbe = (_, _) => throw new AppLifecycleException("fixture_failed", "Interrupted private start");
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ApplyDevModeAsync("test.created", request, actor));
        f.Adapter.StartContextProbe = null;
        await users.UpdateAsync(s => s with { ProviderConnections = [] });
        var starts = f.Adapter.StartCount; var stops = f.Adapter.StopCount;
        var resumed = f.RecreateService(privateSources: privateSources);
        Assert.Equal("source_access_required", (await Assert.ThrowsAsync<AppLifecycleException>(() => resumed.ApplyDevModeAsync("test.created", request, actor))).Code);
        Assert.Equal(starts, f.Adapter.StartCount); Assert.Equal(stops, f.Adapter.StopCount);
        Assert.Equal("returned", (await ApplyReviewedDev(resumed, DevRequest("return", accept: true), actor)).Phase);
    }

    [Fact]
    public async Task DevMode_PrivateManifestUsesPersistedUrlAndCurrentOwnerConnection()
    {
        var (_, service, users, _) = await PrivateDevFixture(privateManifest: true);
        var actor = new AppDevActor("admin", "manual");
        Assert.Equal("dev_source_forbidden", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            service.PlanDevModeAsync("test.created", DevRequest("enter"), new("bob", "manual")))).Code);
        Assert.Equal("active", (await ApplyReviewedDev(service, DevRequest("enter"), actor)).Phase);
        Assert.Equal("active", (await ApplyReviewedDev(service, DevRequest("restart"), actor)).Phase);
        await users.UpdateAsync(s => s with { ProviderConnections = [] });
        Assert.Equal("source_access_required", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            service.PlanDevModeAsync("test.created", DevRequest("restart"), actor))).Code);
        Assert.Equal("returned", (await ApplyReviewedDev(service, DevRequest("return", accept: true), actor)).Phase);
    }

    [Fact]
    public async Task DevMode_RejectsWrongOwnerStaleReviewAndConflictingSourceChanges()
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        var input = DevRequest("enter", tree.Id); var actor = DevActor(owner);
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.PlanDevModeAsync("test.created", input, DevActor(owner with { SessionId = "other" })));
        var plan = await f.Service.PlanDevModeAsync("test.created", input, actor);
        await f.Service.ConfigureAsync("test.created", new(new Dictionary<string, string?> { ["PORT"] = "3999" }));
        var stale = await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.ApplyDevModeAsync("test.created", input with { PlanDigest = plan.PlanDigest }, actor));
        Assert.Equal("dev_plan_changed", stale.Code);
        await ApplyReviewedDev(f.Service, input, actor);
        Assert.Equal("dev_mode_active", (await Assert.ThrowsAsync<AppLifecycleException>(() => f.Sources.ClearLocalOverrideAsync("test.created"))).Code);
        Assert.Equal("dev_mode_active", (await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.ApplyRuntimeSwitchAsync("test.created", new("dev", "anything")))).Code);
        Assert.Equal("workspace_in_use", (await Assert.ThrowsAsync<AppLifecycleException>(() => workspaces.CommandAsync(tree.Id, owner, "merge", new(Guid.NewGuid().ToString()), default))).Code);
        var conflict = await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.ApplyDevModeAsync("test.created", input with { PlanDigest = "different" }, actor));
        Assert.Equal("dev_request_conflict", conflict.Code);
    }

    [Fact]
    public async Task DevMode_BackupFailureLeavesStoppedAndDoesNotRunDevCode()
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        var backupPath = Path.Combine(f.Paths.BackupsRoot, "test.created");
        Directory.CreateDirectory(Path.GetDirectoryName(backupPath)!); await File.WriteAllTextAsync(backupPath, "blocked");
        await Assert.ThrowsAnyAsync<IOException>(() => ApplyReviewedDev(f.Service, DevRequest("enter", tree.Id), DevActor(owner)));
        var state = await f.Service.GetDevModeAsync("test.created");
        Assert.Equal("stopped", state.Phase); Assert.Equal("stopped", state.App.RuntimeState);
        Assert.NotEqual(tree.Path, (await f.Apps.GetAppAsync("test.created"))!.SourceState!.LocalOverridePath);
        Assert.Equal("returned", (await ApplyReviewedDev(f.Service, DevRequest("return"), DevActor(owner))).Phase);
    }

    [Fact]
    public async Task DevMode_FailedStartRecoversUnderOriginalReceiptAfterServiceRestart()
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        var request = DevRequest("enter", tree.Id); var actor = DevActor(owner);
        var plan = await f.Service.PlanDevModeAsync("test.created", request, actor);
        request = request with { PlanDigest = plan.PlanDigest };
        f.Adapter.StartContextProbe = (_, _) => throw new AppLifecycleException("fixture_start_failed", "Failure");
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.ApplyDevModeAsync("test.created", request, actor));
        var failed = await f.Service.GetDevModeAsync("test.created");
        Assert.Equal("starting", failed.Phase); Assert.Equal("dev", failed.App.SelectedRuntime);
        Assert.Equal(tree.Path, (await f.Apps.GetAppAsync("test.created"))!.SourceState!.LocalOverridePath);
        f.Adapter.StartContextProbe = null;
        var recovered = await f.RecreateService().ApplyDevModeAsync("test.created", request, actor);
        Assert.Equal("active", recovered.Phase); Assert.Single(await f.Backups.ListBackupsAsync("test.created"));
    }

    [Fact]
    public async Task DevMode_ReturnAfterManifestDamageStopsUsingInstalledRecipeAndPreservesEdits()
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture(); var actor = DevActor(owner);
        await ApplyReviewedDev(f.Service, DevRequest("enter", tree.Id), actor);
        var manifest = Path.Combine(tree.Path, "manifest.json"); await File.WriteAllTextAsync(manifest, "broken manifest");
        var result = await ApplyReviewedDev(f.Service, DevRequest("return", accept: true), actor);
        Assert.Equal("returned", result.Phase); Assert.Equal("broken manifest", await File.ReadAllTextAsync(manifest));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DevMode_OrdinaryStopIgnoresDamagedOrChangedLiveManifest(bool malformed)
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture(); var actor = DevActor(owner);
        await ApplyReviewedDev(f.Service, DevRequest("enter", tree.Id), actor);
        // Public dev sources retain the ordinary lifecycle controls.
        Assert.Equal("stopped", (await f.Service.StopAsync("test.created")).App!.RuntimeState);
        Assert.Equal("running", (await f.Service.StartAsync("test.created")).App!.RuntimeState);
        Assert.Equal("running", (await f.Service.RestartAsync("test.created")).App!.RuntimeState);
        var path = Path.Combine(tree.Path, "manifest.json");
        var edited = System.Text.Json.Nodes.JsonNode.Parse(await File.ReadAllTextAsync(path))!;
        edited["name"] = "Changed live contract";
        var content = malformed ? "broken manifest" : edited.ToJsonString();
        await File.WriteAllTextAsync(path, content);
        Assert.NotEmpty((await f.Service.GetLogsAsync("test.created", 20)).Text);
        Assert.Equal("test.created", (await f.Service.GetHealthAsync("test.created")).AppId);
        var stops = f.Adapter.StopCount;
        Assert.Equal("stopped", (await f.Service.StopAsync("test.created")).App!.RuntimeState);
        Assert.Equal(stops + 1, f.Adapter.StopCount);
        Assert.Equal(content, await File.ReadAllTextAsync(path));
        if (malformed)
            Assert.Equal("manifest_json_invalid", (await Assert.ThrowsAsync<AppManifestException>(() => f.Service.StartAsync("test.created"))).Code);
        else
            Assert.Equal("dev_contract_changed", (await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.StartAsync("test.created"))).Code);
        Assert.Equal("stopped", (await f.Apps.GetAppAsync("test.created"))!.RuntimeState);
        Assert.Equal("returned", (await ApplyReviewedDev(f.Service, DevRequest("return", accept: true), actor)).Phase);
        Assert.Equal(content, await File.ReadAllTextAsync(path));
    }

    [Fact]
    public async Task DevMode_ReturnRequiresExplicitDataCompatibilityAndNeverRestoresAutomatically()
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture(); var actor = DevActor(owner);
        await ApplyReviewedDev(f.Service, DevRequest("enter", tree.Id), actor);
        var data = Path.Combine(f.Paths.AppsRoot, "test.created", "data", "changed.json"); await File.WriteAllTextAsync(data, "new schema");
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => ApplyReviewedDev(f.Service, DevRequest("return"), actor));
        Assert.Equal("dev_data_compatibility_required", error.Code);
        Assert.Equal("stopped", (await f.Service.GetDevModeAsync("test.created")).App!.RuntimeState);
        Assert.Equal("new schema", await File.ReadAllTextAsync(data));
        Assert.Equal("returned", (await ApplyReviewedDev(f.Service, DevRequest("return", accept: true), actor)).Phase);
    }
    [Fact]
    public async Task DevMode_ReturnRecoversOldRuntimeStartAndRetiresAllPriorRequestIds()
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture(); var actor = DevActor(owner);
        await f.Service.StartAsync("test.created");
        await ApplyReviewedDev(f.Service, DevRequest("enter", tree.Id), actor);
        var returning = DevRequest("return", accept: true);
        returning = returning with { PlanDigest = (await f.Service.PlanDevModeAsync("test.created", returning, actor)).PlanDigest };
        f.Adapter.StartContextProbe = (_, _) => throw new AppLifecycleException("fixture_failed", "Interrupted return");
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.ApplyDevModeAsync("test.created", returning, actor));
        Assert.Equal("return-starting", (await f.Service.GetDevModeAsync("test.created")).Phase);
        Assert.Equal("dev_mode_active", (await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.StartAsync("test.created"))).Code);
        f.Adapter.StartContextProbe = null;
        Assert.Equal("returned", (await f.RecreateService().ApplyDevModeAsync("test.created", returning, actor)).Phase);
        await ApplyReviewedDev(f.Service, DevRequest("enter", tree.Id), actor);
        Assert.Equal("dev_request_retired", (await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.ApplyDevModeAsync("test.created", returning, actor))).Code);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DevMode_BackupReplayKeepsTheArchivedDataBaseline(bool changed)
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture(); var actor = DevActor(owner);
        var data = Path.Combine(f.Paths.AppsRoot, "test.created", "data", "notes.txt");
        Directory.CreateDirectory(Path.GetDirectoryName(data)!); await File.WriteAllTextAsync(data, "before backup");
        var request = DevRequest("enter", tree.Id);
        request = request with { PlanDigest = (await f.Service.PlanDevModeAsync("test.created", request, actor)).PlanDigest };
        var active = await f.Service.ApplyDevModeAsync("test.created", request, actor);
        var op = (await AppDevStore.ReadAsync(f.Paths, "test.created", active.OperationId!, default))!;
        var backup = Assert.Single(await f.Backups.ListBackupsAsync("test.created"));
        // The archive and its metadata survived; the backed-up journal checkpoint did not.
        op = op with { Phase = "stopped", BackupId = null, Receipts = op.Receipts!.Select(r => r with { State = "pending" }).ToArray() };
        await AppDevStore.SaveAsync(f.Paths, op, default);
        await f.Apps.UpdateAppAsync("test.created", a => a with { RuntimeState = "stopped", SelectedRuntime = op.PreviousRuntime,
            SourceState = op.PreviousSource, ArtifactLocks = op.PreviousArtifacts });
        if (changed) await File.WriteAllTextAsync(data, "changed before retry");
        var starts = f.Adapter.StartCount;
        var service = f.RecreateService();
        if (changed)
        {
            Assert.Equal("dev_backup_data_changed", (await Assert.ThrowsAsync<AppLifecycleException>(() => service.ApplyDevModeAsync("test.created", request, actor))).Code);
            Assert.Equal(starts, f.Adapter.StartCount);
            Assert.Equal("stopped", (await f.Apps.GetAppAsync("test.created"))!.RuntimeState);
            Assert.Equal("changed before retry", await File.ReadAllTextAsync(data));
            var retained = (await AppDevStore.ReadAsync(f.Paths, "test.created", op.Id, default))!;
            Assert.Equal(op.DataHash, retained.DataHash);
            Assert.Equal(backup.ArchiveSha256, Assert.Single(await f.Backups.ListBackupsAsync("test.created")).ArchiveSha256);
            await ApplyReviewedDev(service, DevRequest("return", accept: true), actor);
            var fresh = await ApplyReviewedDev(service, DevRequest("enter", tree.Id), actor);
            var replacement = Assert.Single(await f.Backups.ListBackupsAsync("test.created"), b => b.BackupId == fresh.BackupId);
            using var archive = System.IO.Compression.ZipFile.OpenRead(replacement.ArchivePath);
            using var reader = new StreamReader(archive.GetEntry("notes.txt")!.Open());
            Assert.Equal("changed before retry", await reader.ReadToEndAsync());
        }
        else
        {
            var resumed = await service.ApplyDevModeAsync("test.created", request, actor);
            Assert.Equal("active", resumed.Phase); Assert.Equal(backup.BackupId, resumed.BackupId);
            Assert.Single(await f.Backups.ListBackupsAsync("test.created"));
        }
    }

    [Theory]
    [InlineData("enter", "starting", "active")]
    [InlineData("restart", "restarting", "active")]
    [InlineData("return", "return-bound", "returned")]
    public async Task DevMode_TerminalReceiptSurvivesRegistryFailureAndReplay(string action, string priorPhase, string terminalPhase)
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture(); var actor = DevActor(owner);
        if (action != "enter") await ApplyReviewedDev(f.Service, DevRequest("enter", tree.Id), actor);
        var request = DevRequest(action, action == "enter" ? tree.Id : null, accept: true);
        request = request with { PlanDigest = (await f.Service.PlanDevModeAsync("test.created", request, actor)).PlanDigest };
        var result = await f.Service.ApplyDevModeAsync("test.created", request, actor);
        var op = (await AppDevStore.ReadAsync(f.Paths, "test.created", result.OperationId!, default))!;
        // Recreate the durable checkpoint immediately before the terminal journal commit, with the
        // runtime transition already done. Make the next registry write fail after that commit.
        op = op with { Phase = priorPhase, Receipts = op.Receipts!.Select(r =>
            r.RequestId == request.RequestId ? r with { State = "pending" } : r).ToArray() };
        await AppDevStore.SaveAsync(f.Paths, op, default);
        await f.Apps.UpdateAppAsync("test.created", a => a with { OperationStatus = "development-" + priorPhase });
        var statePath = Path.Combine(f.Paths.AppsRoot, "test.created", "state.json");
        var state = await File.ReadAllBytesAsync(statePath);
        File.Delete(statePath); Directory.CreateDirectory(statePath);
        try
        {
            var failure = await Record.ExceptionAsync(() => f.Service.DevPhaseAsync(op, terminalPhase, default, completedRequestId: request.RequestId));
            Assert.True(failure is IOException or UnauthorizedAccessException, failure?.ToString() ?? "Expected registry failure");
        }
        finally { Directory.Delete(statePath); await File.WriteAllBytesAsync(statePath, state); }
        var saved = (await AppDevStore.ReadAsync(f.Paths, "test.created", op.Id, default))!;
        Assert.Equal(terminalPhase, saved.Phase);
        Assert.Equal("succeeded", Assert.Single(saved.Receipts!, r => r.RequestId == request.RequestId).State);
        var starts = f.Adapter.StartCount; var stops = f.Adapter.StopCount;
        var replay = await f.RecreateService().ApplyDevModeAsync("test.created", request, actor);
        Assert.Equal(terminalPhase, replay.Phase);
        Assert.Equal("development-" + terminalPhase, (await f.Apps.GetAppAsync("test.created"))!.OperationStatus);
        Assert.Equal(starts, f.Adapter.StartCount); Assert.Equal(stops, f.Adapter.StopCount);
    }

    [Fact]
    public async Task DevMode_CompletedEntryReplayAfterReturnObservesCurrentOperation()
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture(); var actor = DevActor(owner);
        var request = DevRequest("enter", tree.Id);
        request = request with { PlanDigest = (await f.Service.PlanDevModeAsync("test.created", request, actor)).PlanDigest };
        await f.Service.ApplyDevModeAsync("test.created", request, actor);
        await ApplyReviewedDev(f.Service, DevRequest("return", accept: true), actor);
        await f.Apps.UpdateAppAsync("test.created", a => a with { OperationStatus = "configured" });
        var starts = f.Adapter.StartCount; var stops = f.Adapter.StopCount;
        Assert.Equal("returned", (await f.RecreateService().ApplyDevModeAsync("test.created", request, actor)).Phase);
        Assert.Equal("configured", (await f.Apps.GetAppAsync("test.created"))!.OperationStatus);
        Assert.Equal(starts, f.Adapter.StartCount); Assert.Equal(stops, f.Adapter.StopCount);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DevMode_ReturnReplayPreservesLaterOrdinaryLifecycleStatus(bool restart)
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture(); var actor = DevActor(owner);
        await ApplyReviewedDev(f.Service, DevRequest("enter", tree.Id), actor);
        var request = DevRequest("return", accept: true);
        request = request with { PlanDigest = (await f.Service.PlanDevModeAsync("test.created", request, actor)).PlanDigest };
        await f.Service.ApplyDevModeAsync("test.created", request, actor);
        if (restart) await f.Service.RestartAsync("test.created"); else await f.Service.StartAsync("test.created");
        var starts = f.Adapter.StartCount; var stops = f.Adapter.StopCount;
        Assert.Equal("returned", (await f.RecreateService().ApplyDevModeAsync("test.created", request, actor)).Phase);
        Assert.Equal(restart ? "restarted" : "started", (await f.Apps.GetAppAsync("test.created"))!.OperationStatus);
        Assert.Equal(starts, f.Adapter.StartCount); Assert.Equal(stops, f.Adapter.StopCount);
    }

    [Fact]
    public async Task DevMode_ManualConfiguredSourceNeedsNoWorkspaceAndPreservesDirtyFiles()
    {
        var (f, _, _, _, _, _) = await LocalHandoffFixture();
        var source = (await f.Apps.GetAppAsync("test.created"))!.SourceState!.LocalOverridePath!;
        await File.WriteAllTextAsync(Path.Combine(source, "manual.txt"), "ordinary manual edit");
        var actor = new AppDevActor("operator", "manual");
        Assert.Equal("active", (await ApplyReviewedDev(f.Service, DevRequest("enter"), actor)).Phase);
        Assert.Equal("returned", (await ApplyReviewedDev(f.Service, DevRequest("return", accept: true), actor)).Phase);
        Assert.Equal("ordinary manual edit", await File.ReadAllTextAsync(Path.Combine(source, "manual.txt")));
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("invalid")]
    public async Task DevMode_UnavailableJournalPreservesDashboardAndBlocksMutation(string damage)
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await f.Apps.UpdateAppAsync("test.created", a => a with { Autostart = false });
        var active = await ApplyReviewedDev(f.Service, DevRequest("enter", tree.Id), DevActor(owner));
        var file = AppDevStore.Record(f.Paths, "test.created", active.OperationId!);
        if (damage == "missing") File.Delete(file); else await File.WriteAllTextAsync(file, "{invalid");
        var summary = Assert.Single(await f.Service.ListAppsAsync());
        Assert.Equal("unavailable", summary.DevMode?.Phase);
        Assert.Equal("dev_state_unavailable", (await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.StopAsync("test.created"))).Code);
        Assert.True(Directory.Exists(tree.Path));
        await f.Service.InstallAsync(new AppInstallRequest(await f.WriteManifestAsync("1.0.0"), Autostart: false, StartOnInstall: true));
        var before = await f.Apps.GetAppAsync("test.created");
        var stops = f.Adapter.StopCount;
        var results = await f.RecreateService().StopAutostartDisabledAppsAsync();
        Assert.Equal("dev_state_unavailable", Assert.Single(results, r => r.AppId == "test.created").ErrorCode);
        Assert.True(Assert.Single(results, r => r.AppId == "com.example.notes").Succeeded);
        Assert.Equal("stopped", (await f.Apps.GetAppAsync("com.example.notes"))!.RuntimeState);
        Assert.Equal(before, await f.Apps.GetAppAsync("test.created"));
        Assert.Equal(stops + 1, f.Adapter.StopCount);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("invalid")]
    public async Task DevMode_UnavailableJournalBlocksRestoreWithoutReplacingData(string damage)
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        var data = Path.Combine(f.Paths.AppsRoot, "test.created", "data", "notes.txt");
        Directory.CreateDirectory(Path.GetDirectoryName(data)!); await File.WriteAllTextAsync(data, "before backup");
        var active = await ApplyReviewedDev(f.Service, DevRequest("enter", tree.Id), DevActor(owner));
        await f.Service.StopAsync("test.created");
        await File.WriteAllTextAsync(data, "keep changed data");
        var file = AppDevStore.Record(f.Paths, "test.created", active.OperationId!);
        if (damage == "missing") File.Delete(file); else await File.WriteAllTextAsync(file, "{invalid");
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.RestoreBackupAsync("test.created", active.BackupId!, new(true)));
        Assert.Equal("dev_state_unavailable", error.Code);
        Assert.Equal("keep changed data", await File.ReadAllTextAsync(data));
        Assert.Single(await f.Backups.ListBackupsAsync("test.created"));
    }

    [Fact]
    public async Task DevMode_KeepsAutostartPreferenceAndIndependentPreviewConsumer()
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        await f.Apps.UpdateAppAsync("test.created", a => a with { Autostart = false });
        var sandbox = Guid.NewGuid().ToString("N");
        await workspaces.SetSandboxConsumerAsync(tree.Id, sandbox, true, default);
        var actor = DevActor(owner);
        await ApplyReviewedDev(f.Service, DevRequest("enter", tree.Id), actor);
        Assert.Empty(await f.RecreateService().StopAutostartDisabledAppsAsync());
        Assert.Equal("running", (await f.Service.GetDevModeAsync("test.created")).App!.RuntimeState);
        Assert.False((await f.Apps.GetAppAsync("test.created"))!.Autostart);
        Assert.Equal([sandbox], (await workspaces.Read(tree.Id, owner, default)).SandboxConsumers);
        await workspaces.SetSandboxConsumerAsync(tree.Id, sandbox, false, default);
        Assert.Equal("workspace_in_use", (await Assert.ThrowsAsync<AppLifecycleException>(() => workspaces.CommandAsync(tree.Id, owner, "cleanup", new(Guid.NewGuid().ToString()), default))).Code);
        Assert.Equal("returned", (await ApplyReviewedDev(f.Service, DevRequest("return", accept: true), actor)).Phase);
        Assert.True(Directory.Exists(tree.Path));
    }

    [Fact]
    public async Task DevMode_RestoreRequiresStoppedAppAndExplicitlyRestoresOnlyData()
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        var data = Path.Combine(f.Paths.AppsRoot, "test.created", "data", "schema.json");
        Directory.CreateDirectory(Path.GetDirectoryName(data)!); await File.WriteAllTextAsync(data, "old");
        var actor = DevActor(owner); var active = await ApplyReviewedDev(f.Service, DevRequest("enter", tree.Id), actor);
        await File.WriteAllTextAsync(data, "incompatible");
        Assert.Equal("app_must_be_stopped", (await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.RestoreBackupAsync("test.created", active.BackupId!, new(false)))).Code);
        await f.Service.StopAsync("test.created");
        await f.Service.RestoreBackupAsync("test.created", active.BackupId!, new(false));
        Assert.Equal("old", await File.ReadAllTextAsync(data));
        Assert.Equal("active", (await f.Service.GetDevModeAsync("test.created")).Phase);
        Assert.Equal("returned", (await ApplyReviewedDev(f.Service, DevRequest("return"), actor)).Phase);
        Assert.True(Directory.Exists(tree.Path));
    }

}
