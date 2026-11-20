using System.IO.Compression;
using System.Text.Json.Nodes;
using Haas.Hosty.Core;
using Haas.Hosty.Launch;
using Haas.Hosty.Core.Tests.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static async Task<AppExecutionOperation> ExecutionRequest(LifecycleFixture f, WorkspaceOwner owner,
        string kind, DevelopmentWorkspace? tree = null, string? runtime = null, string? onlyWorkspace = null)
    {
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        var request = new AppExecutionTargetRequest(Guid.NewGuid().ToString("D"), kind, runtime,
            kind == "workspace" ? tree!.WorkspaceId : null, kind == "workspace" ? tree!.Id : null);
        var previous = await JsonStorage.ReadAsync<AppExecutionOwner>(
            Path.Combine(AppExecutionStore.DirectoryFor(f.Paths, app.Id), "owner.json"));
        return new(app.Id, request, new(owner.UserId, "test-assistant"), app.InstalledAt, AppExecutionStore.Binding(app),
            "test:" + request.RequestId, OnlyWorkspaceId: onlyWorkspace, PreviousRequestId: previous?.RequestId);
    }

    private static async Task<DevelopmentWorkspace> AnotherExecutionTree(LifecycleFixture f, WorkspaceOwner owner,
        DevelopmentWorkspaceService workspaces, DevelopmentWorkspace first)
    {
        var other = owner with { SessionId = owner.SessionId + "-second" };
        var tree = await workspaces.PrepareAsync(other, new(Guid.NewGuid().ToString(), other.SessionId,
            "test.created", "/assistant", "main", Name: "Second workspace"), default);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "manifest.json"),
            await File.ReadAllTextAsync(Path.Combine(first.Path, "manifest.json")));
        return tree;
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExecutionTargets_WorkspaceToWorkspaceReturnsToPackageAndRetainsCurrentData(bool workspaceOnlyRuntime)
    {
        var (f, owner, workspaces, first, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, first);
        var second = await AnotherExecutionTree(f, owner, workspaces, first);
        if (workspaceOnlyRuntime) await AddCandidateOnlyRuntime(first);
        await f.Service.StartAsync("test.created");
        var installed = await File.ReadAllTextAsync((await f.Apps.GetAppAsync("test.created"))!.ManifestPath!);
        var data = Path.Combine(f.Paths.AppsRoot, "test.created", "data", "sentinel");
        Directory.CreateDirectory(Path.GetDirectoryName(data)!);
        await File.WriteAllTextAsync(data, "release data");
        var a = await ExecutionRequest(f, owner, "workspace", first, workspaceOnlyRuntime ? CandidateOnlyRuntime : "dev");
        var entry = await f.Service.ExecuteTargetAsync(a, default);
        if (entry.State == "review-required")
        {
            await f.Service.ApproveWorkspaceManifestAsync(entry.Review!.WorkspaceManifest!, owner.UserId, [], default);
            entry = await f.Service.ExecuteTargetAsync(a, default);
        }
        Assert.Equal("completed", entry.State);
        Assert.Equal(a.Request.Runtime, (await f.Apps.GetAppAsync("test.created"))!.SelectedRuntime);
        if (workspaceOnlyRuntime) await File.WriteAllTextAsync(Path.Combine(first.Path, "manifest.json"), "{ broken source");
        var baseline = Assert.Single(await f.Backups.ListBackupsAsync("test.created"));
        await File.WriteAllTextAsync(data, "first workspace data");
        var b = await ExecutionRequest(f, owner, "workspace", second);
        Assert.Equal("completed", (await f.Service.ExecuteTargetAsync(b, default)).State);
        Assert.Equal(second.Id, (await f.Service.GetDevModeAsync("test.created")).WorktreeId);
        Assert.Equal("docker", (await f.Service.GetDevModeAsync("test.created")).PreviousRuntime);
        await File.WriteAllTextAsync(data, "current data survives");
        var back = await ExecutionRequest(f, owner, "package");
        Assert.Equal("completed", (await f.Service.ExecuteTargetAsync(back, default)).State);
        Assert.Equal("docker", (await f.Apps.GetAppAsync("test.created"))!.SelectedRuntime);
        Assert.Equal("current data survives", await File.ReadAllTextAsync(data));
        Assert.Equal(installed, await File.ReadAllTextAsync((await f.Apps.GetAppAsync("test.created"))!.ManifestPath!));
        Assert.True(Directory.Exists(first.Path));
        Assert.True(Directory.Exists(second.Path));

        var backups = (await f.Service.ListBackupsAsync("test.created")).Backups;
        Assert.Equal(2, backups.Count(backup => backup.Reason == "pre-development-mode"));
        Assert.Equal(baseline.BackupId, Assert.Single(backups, backup => backup.IsWorkspaceReturnBackup).BackupId);
        await f.Service.StopAsync("test.created");
        await f.Service.RestoreBackupAsync("test.created", baseline.BackupId, new(CreatePreRestoreBackup: true));
        Assert.Equal("release data", await File.ReadAllTextAsync(data));
        Assert.Equal("docker", (await f.Apps.GetAppAsync("test.created"))!.SelectedRuntime);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExecutionTargets_ReturnAfterTwoFailedWorkspaceStartsHonorsPackageRunIntent(bool explicitlyStopped)
    {
        var (f, owner, workspaces, first, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, first);
        var second = await AnotherExecutionTree(f, owner, workspaces, first);
        const string appId = "test.created";
        await f.Service.StartAsync(appId);
        f.Adapter.StartProbe = () => throw new AppLifecycleException("runtime_start_failed", "Workspace build failed.");
        f.Adapter.Health = context => new("unhealthy", context.Manifest.Services.Select(s => ServiceHealth(s.Key, "exited", exitCode: 1)).ToArray());
        foreach (var tree in new[] { first, second })
        {
            var result = await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", tree), default);
            Assert.Equal("dev_workspace_start_failed", result.Code);
            Assert.Equal(tree.Id, (await f.Service.GetDevModeAsync(appId)).WorktreeId);
            Assert.Equal("stopped", (await f.Apps.GetAppAsync(appId))!.RuntimeState);
        }
        if (explicitlyStopped) await f.Service.StopAsync(appId);
        var starts = f.Adapter.StartCount;
        f.Adapter.StartProbe = null;
        f.Adapter.Health = null;
        var restored = await f.RecreateService().ExecuteTargetAsync(await ExecutionRequest(f, owner, "package"), default);
        Assert.Equal("completed", restored.State);
        var app = (await f.Apps.GetAppAsync(appId))!;
        Assert.Equal("docker", app.SelectedRuntime);
        Assert.Equal(explicitlyStopped ? "stopped" : "running", app.RuntimeState);
        Assert.Equal(starts + (explicitlyStopped ? 0 : 1), f.Adapter.StartCount);
    }

    [Fact]
    public async Task ExecutionTargets_NewSkillMountDoesNotApplyToPreviousWorkspaceStop()
    {
        var (f, owner, workspaces, first, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, first);
        var second = await AnotherExecutionTree(f, owner, workspaces, first);
        await f.Service.StartAsync("test.created");
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", first), default);
        await EditDevManifest(second.Path, manifest =>
        {
            manifest["corePermissions"] = new System.Text.Json.Nodes.JsonArray("apps.skills.read");
            manifest["externalMounts"] = new System.Text.Json.Nodes.JsonObject
            {
                ["skills"] = new System.Text.Json.Nodes.JsonObject
                {
                    ["kind"] = "agent-skills", ["scope"] = "instance", ["mode"] = "ro",
                    ["required"] = true, ["service"] = manifest["services"]![0]!["key"]!.GetValue<string>()
                }
            };
        });
        var request = await ExecutionRequest(f, owner, "workspace", second);
        var review = await f.Service.ExecuteTargetAsync(request, default);
        Assert.Equal("review-required", review.State);
        await f.Service.ApproveWorkspaceManifestAsync(review.Review!.WorkspaceManifest!, owner.UserId, [], default);
        Assert.Equal("completed", (await f.Service.ExecuteTargetAsync(request, default)).State);
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        Assert.Equal("running", app.RuntimeState);
        Assert.Equal(second.Path, app.SourceState!.LocalOverridePath);
        Assert.Contains(app.MountSlots!, slot => slot.Kind == "agent-skills");
        Assert.Equal("completed", (await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "package"), default)).State);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExecutionTargets_ReturnReportsPackageWhileStartingAndAfterStartFailure(bool failStart)
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        await f.Service.StartAsync("test.created");
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", tree), default);
        var inventory = await new WorkspaceInspectionService(workspaces, f.Apps, f.Clock).ListAsync(owner.UserId, default);
        var before = await f.Service.ReadExecutionTargetsAsync("test.created", inventory, default);
        Assert.Equal(tree.Id, before.Current.WorktreeId);

        var observedStart = false;
        f.Adapter.StartContextProbe = async (_, _) =>
        {
            var app = (await f.Apps.GetAppAsync("test.created"))!;
            Assert.Equal("starting", app.RuntimeState);
            Assert.Equal("return-starting", (await f.Service.GetDevModeAsync(app.Id)).Phase);
            var current = (await f.Service.ReadExecutionTargetsAsync(app.Id, inventory, default)).Current;
            Assert.Equal("package", current.Kind);
            Assert.Equal("docker", current.Runtime);
            Assert.Null(current.WorkspaceId);
            Assert.Null(current.WorktreeId);
            observedStart = true;
            if (failStart) throw new IOException("Interrupted package start");
        };
        var back = await ExecutionRequest(f, owner, "package");
        if (failStart)
        {
            await Assert.ThrowsAsync<IOException>(() => f.Service.ExecuteTargetAsync(back, default));
            Assert.Equal("package", (await f.Service.ReadExecutionTargetsAsync("test.created", inventory, default)).Current.Kind);
            f.Adapter.StartContextProbe = null;
            back = (await AppExecutionStore.ReadAsync(f.Paths, back.AppId, back.Request.RequestId, default))!;
        }
        Assert.Equal("completed", (await f.Service.ExecuteTargetAsync(back, default)).State);
        Assert.True(observedStart);
        Assert.Equal("package", (await f.Service.ReadExecutionTargetsAsync("test.created", inventory, default)).Current.Kind);
    }

    [Fact]
    public async Task ExecutionTargets_EntryStopsThenBacksUpBeforeStartingFromSelectedSource()
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        await f.Service.StartAsync("test.created");
        var inventory = await new WorkspaceInspectionService(workspaces, f.Apps, f.Clock).ListAsync(owner.UserId, default);
        var data = Path.Combine(f.Paths.AppsRoot, "test.created", "data");
        Directory.CreateDirectory(data);
        var observedStop = false;
        var observedStart = false;
        f.Adapter.PreparationProbe = _ => throw new InvalidOperationException("Ordinary workspace switches must use normal Start.");
        f.Adapter.StopProbe = async () =>
        {
            if (observedStop) return;
            var current = (await f.Service.ReadExecutionTargetsAsync("test.created", inventory, default)).Current;
            Assert.Equal("package", current.Kind);
            Assert.Empty(await f.Backups.ListBackupsAsync("test.created"));
            await File.WriteAllTextAsync(Path.Combine(data, "last-write"), "flushed at Stop");
            observedStop = true;
        };
        f.Adapter.StartContextProbe = async (context, _) =>
        {
            var current = (await f.Service.ReadExecutionTargetsAsync("test.created", inventory, default)).Current;
            Assert.Equal(tree.Id, current.WorktreeId);
            Assert.Equal(tree.Path, context.App.SourceState!.LocalOverridePath);
            Assert.False(context.PreparationOnly);
            var backup = Assert.Single(await f.Backups.ListBackupsAsync("test.created"));
            using var archive = ZipFile.OpenRead(backup.ArchivePath);
            using var reader = new StreamReader(archive.GetEntry("last-write")!.Open());
            Assert.Equal("flushed at Stop", await reader.ReadToEndAsync());
            observedStart = true;
        };
        Assert.Equal("completed", (await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", tree), default)).State);
        Assert.True(observedStop);
        Assert.True(observedStart);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExecutionTargets_FailedStartKeepsWorkspaceEditableAndRepairable(bool useRestart)
    {
        var (f, owner, workspaces, first, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, first);
        var second = await AnotherExecutionTree(f, owner, workspaces, first);
        await f.Service.StartAsync("test.created");
        var oldArtifact = new ArtifactLock("image", f.Adapter.RemoteDigest, "fixture/first-workspace", null, null, f.Clock.UtcNow);
        f.Adapter.StartLocks = new Dictionary<string, ArtifactLock> { ["app"] = oldArtifact };
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", first), default);
        Assert.Contains(oldArtifact, (await f.Apps.GetAppAsync("test.created"))!.ArtifactLocks!.Values);
        f.Adapter.StartLocks = null;
        f.Adapter.Health = context => new("unhealthy", context.Manifest.Services.Select(s => ServiceHealth(s.Key, "exited", exitCode: 1)).ToArray());
        var source = Path.Combine(second.Path, "candidate-code");
        await File.WriteAllTextAsync(source, "broken");
        f.Adapter.StartContextProbe = async (context, cancellation) =>
        {
            Assert.DoesNotContain(oldArtifact, context.App.ArtifactLocks?.Values ?? []);
            if (await File.ReadAllTextAsync(Path.Combine(context.App.SourceState!.LocalOverridePath!, "candidate-code"), cancellation) == "broken")
                throw new AppLifecycleException("runtime_start_failed", "Workspace build failed.");
        };
        var request = await ExecutionRequest(f, owner, "workspace", second);
        var result = await f.Service.ExecuteTargetAsync(request, default);
        Assert.Equal("failed", result.State);
        Assert.Equal("dev_workspace_start_failed", result.Code);
        Assert.Contains("Workspace build failed", result.Error);
        var app = (await f.Apps.GetAppAsync(request.AppId))!;
        Assert.Equal(second.Path, app.SourceState!.LocalOverridePath);
        Assert.Equal("stopped", app.RuntimeState);
        var starts = f.Adapter.StartCount;
        var backups = (await f.Backups.ListBackupsAsync(app.Id)).Select(backup => backup.BackupId).Order().ToArray();
        Assert.Equal(2, backups.Length);

        Assert.Contains("log line", (await f.Service.GetLogsAsync(app.Id, 100)).Text);
        f.Adapter.Health = null;
        var recovered = f.RecreateService();
        Assert.Equal("failed", (await recovered.ExecuteTargetAsync(request, default)).State);
        Assert.Equal(starts, f.Adapter.StartCount);
        var lease = Guid.NewGuid().ToString("D");
        await workspaces.CommandAsync(second.Id, second.Owner, "lease", new(Guid.NewGuid().ToString(), LeaseId: lease), default);
        await File.WriteAllTextAsync(source, "fixed");
        await workspaces.CommandAsync(second.Id, second.Owner, "release-lease", new(Guid.NewGuid().ToString(), LeaseId: lease), default);
        if (useRestart) await recovered.RestartAsync(app.Id);
        else await recovered.StartAsync(app.Id);
        app = (await f.Apps.GetAppAsync(app.Id))!;
        Assert.Equal("running", app.RuntimeState);
        Assert.Equal(second.Path, app.SourceState!.LocalOverridePath);
        Assert.Equal(starts + 1, f.Adapter.StartCount);
        Assert.Equal(backups, (await f.Backups.ListBackupsAsync(app.Id)).Select(backup => backup.BackupId).Order().ToArray());
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task ExecutionTargets_FailureBeforeBindingKeepsPreviousSelectionUsable(bool existingWorkspace, bool failBackup)
    {
        var (f, owner, workspaces, first, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, first);
        var second = await AnotherExecutionTree(f, owner, workspaces, first);
        await f.Service.StartAsync("test.created");
        if (existingWorkspace) await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", first), default);
        var before = (await f.Apps.GetAppAsync("test.created"))!;
        var starts = f.Adapter.StartCount;
        var request = await ExecutionRequest(f, owner, "workspace", second);
        if (failBackup)
        {
            var operation = WorkspaceRuntimeFiles.ChildId(request.Request.RequestId, "execution:" + before.Id);
            Directory.CreateDirectory(Path.Combine(f.Paths.BackupsRoot, before.Id, operation + "_pre-development-mode.zip"));
            var error = await Record.ExceptionAsync(() => f.Service.ExecuteTargetAsync(request, default));
            Assert.NotNull(error);
        }
        else
        {
            f.Adapter.StopRuntimeState = "running";
            Assert.Equal("dev_stop_unverified", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
                f.Service.ExecuteTargetAsync(request, default))).Code);
            f.Adapter.StopRuntimeState = "stopped";
        }
        var after = (await f.Apps.GetAppAsync(before.Id))!;
        Assert.Equal(before.SelectedRuntime, after.SelectedRuntime);
        Assert.Equal(before.SourceState!.LocalOverridePath, after.SourceState!.LocalOverridePath);
        Assert.Equal(failBackup ? "stopped" : "running", after.RuntimeState);
        var inventory = await new WorkspaceInspectionService(workspaces, f.Apps, f.Clock).ListAsync(owner.UserId, default);
        var current = (await f.Service.ReadExecutionTargetsAsync(after.Id, inventory, default)).Current;
        Assert.Equal(existingWorkspace ? "workspace" : "package", current.Kind);
        Assert.Equal(existingWorkspace ? first.Id : null, current.WorktreeId);
        Assert.Equal(starts, f.Adapter.StartCount);
        if (failBackup)
        {
            await f.Service.StartAsync(after.Id);
            Assert.Equal("running", (await f.Apps.GetAppAsync(after.Id))!.RuntimeState);
            Assert.Equal(before.SelectedRuntime, f.Adapter.LastContext!.App.SelectedRuntime);
        }
    }

    [Fact]
    public async Task ExecutionTargets_ReplayObservesHealthyBoundWorkspaceAfterLostStartOutcome()
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        var request = await ExecutionRequest(f, owner, "workspace", tree);
        await f.Service.ExecuteTargetAsync(request, default);
        var app = (await f.Apps.GetAppAsync(request.AppId))!;
        var bound = (await AppDevStore.ReadAsync(f.Paths, app, default))!;
        var receipt = Assert.Single(bound.Receipts!);
        await AppDevStore.SaveAsync(f.Paths, bound with { Phase = "starting", Receipts = [receipt with { State = "pending" }] }, default);
        var starts = f.Adapter.StartCount;
        var stops = f.Adapter.StopCount;
        f.Adapter.Health = context => new("healthy", context.Manifest.Services.Select(s => ServiceHealth(s.Key)).ToArray());

        var recovered = f.RecreateService();
        Assert.Equal("completed", (await recovered.ExecuteTargetAsync(request, default)).State);
        Assert.Equal("active", (await recovered.GetDevModeAsync(app.Id)).Phase);
        Assert.Equal(bound.BackupId, Assert.Single(await f.Backups.ListBackupsAsync(app.Id)).BackupId);
        Assert.Equal(starts, f.Adapter.StartCount);
        Assert.Equal(stops, f.Adapter.StopCount);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExecutionTargets_RevokedInitiatorSettlesOnlyItsCommittedBindingWithoutRuntimeEffects(bool startupCompleted)
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        var request = await ExecutionRequest(f, owner, "workspace", tree);
        var appId = request.AppId;
        Assert.Equal("completed", (await f.Service.ExecuteTargetAsync(request, default)).State);
        if (!startupCompleted) await f.Service.StopAsync(appId);
        var app = (await f.Apps.GetAppAsync(appId))!;
        var op = (await AppDevStore.ReadAsync(f.Paths, app, default))!;
        var receipt = Assert.Single(op.Receipts!);
        await AppDevStore.SaveAsync(f.Paths, op with
        {
            Phase = startupCompleted ? "starting" : "bound", Receipts = [receipt with { State = "pending" }]
        }, default);
        var ownerPath = Path.Combine(AppExecutionStore.DirectoryFor(f.Paths, appId), "owner.json");
        var selected = (await JsonStorage.ReadAsync<AppExecutionOwner>(ownerPath))!;
        var foreign = selected with { RequestId = Guid.NewGuid().ToString("D") };
        await JsonStorage.WriteAsync(ownerPath, foreign);
        var starts = f.Adapter.StartCount;
        var stops = f.Adapter.StopCount;
        var checks = 0;
        Task Deny(CancellationToken _)
        {
            checks++;
            throw WorkspaceActivationAccess.Denied();
        }

        var recovered = f.RecreateService();
        var stale = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            recovered.ExecuteTargetAsync(request with { PreviousRequestId = foreign.RequestId }, default, Deny));
        Assert.Equal("dev_selection_changed", stale.Code);
        Assert.Equal(0, checks);
        Assert.Equal(foreign, await JsonStorage.ReadAsync<AppExecutionOwner>(ownerPath));
        await JsonStorage.WriteAsync(ownerPath, selected);
        var result = await recovered.ExecuteTargetAsync(request, default, Deny);
        Assert.Equal(startupCompleted ? "completed" : "failed", result.State);
        Assert.Equal(startupCompleted ? 0 : 1, checks);
        if (!startupCompleted)
        {
            Assert.Equal("dev_workspace_start_failed", result.Code);
            Assert.Equal(WorkspaceActivationAccess.Denied().Message, result.Error);
        }
        Assert.Equal(selected, await JsonStorage.ReadAsync<AppExecutionOwner>(ownerPath));
        var status = await recovered.GetDevModeAsync(appId);
        Assert.Equal("active", status.Phase);
        Assert.Equal(tree.Id, status.WorktreeId);
        Assert.Equal(startupCompleted ? "running" : "stopped", status.App.RuntimeState);
        Assert.Equal(startupCompleted ? "succeeded" : "failed", Assert.Single(status.Receipts).State);
        Assert.Equal(starts, f.Adapter.StartCount);
        Assert.Equal(stops, f.Adapter.StopCount);
        Assert.Equal(op.BackupId, Assert.Single(await f.Backups.ListBackupsAsync(appId)).BackupId);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExecutionTargets_ReplayAfterBindingSettlesFailedLaunchDespiteLaterManifestEdit(bool failureRecorded)
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        var request = await ExecutionRequest(f, owner, "workspace", tree);
        var appId = request.AppId;
        if (failureRecorded)
        {
            f.Adapter.StartProbe = () => throw new AppLifecycleException("runtime_start_failed", "Build failed before interruption.");
            f.Adapter.Health = context => new("unhealthy", context.Manifest.Services.Select(s => ServiceHealth(s.Key, "exited", exitCode: 1)).ToArray());
        }
        var first = await f.Service.ExecuteTargetAsync(request, default);
        if (failureRecorded) Assert.Equal("dev_workspace_start_failed", first.Code);
        else
        {
            Assert.Equal("completed", first.State);
            await f.Service.StopAsync(appId);
        }

        var app = (await f.Apps.GetAppAsync(appId))!;
        var op = (await AppDevStore.ReadAsync(f.Paths, app, default))!;
        var receipt = Assert.Single(op.Receipts!);
        await AppDevStore.SaveAsync(f.Paths, op with
        {
            Phase = failureRecorded ? "starting" : "bound",
            Error = null, Receipts = [receipt with { State = "pending", Error = null }]
        }, default);
        var manifest = Path.Combine(tree.Path, "manifest.json");
        var valid = await File.ReadAllTextAsync(manifest);
        await File.WriteAllTextAsync(manifest, "{ incomplete manifest");
        var recovered = f.RecreateService();
        var starts = f.Adapter.StartCount;
        var status = await recovered.ExecuteTargetAsync(request, default);
        Assert.Equal("failed", status.State);
        Assert.Equal("dev_workspace_start_failed", status.Code);
        if (failureRecorded) Assert.Equal(first.Error, status.Error);
        else Assert.False(string.IsNullOrWhiteSpace(status.Error));
        Assert.Equal(starts, f.Adapter.StartCount);
        Assert.Equal("active", (await recovered.GetDevModeAsync(appId)).Phase);
        Assert.Equal(op.BackupId, Assert.Single(await f.Backups.ListBackupsAsync(appId)).BackupId);

        await File.WriteAllTextAsync(manifest, valid);
        f.Adapter.StartProbe = null;
        f.Adapter.Health = null;
        await recovered.StartAsync(appId);
        Assert.Equal("running", (await f.Apps.GetAppAsync(appId))!.RuntimeState);
        Assert.Equal(tree.Id, (await recovered.GetDevModeAsync(appId)).WorktreeId);
        Assert.Equal(starts + 1, f.Adapter.StartCount);
    }

    [Fact]
    public async Task ExecutionTargets_LegacyInterruptedPreparationPreservesUnconfirmedLeaseAndRunningPackage()
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        await f.Service.StartAsync("test.created");
        var lease = Guid.NewGuid().ToString("D");
        await workspaces.CommandAsync(tree.Id, owner, "lease", new(Guid.NewGuid().ToString(), LeaseId: lease), default);
        var request = (await ExecutionRequest(f, owner, "workspace", tree)) with { PreparationLeaseId = lease };
        await AppExecutionStore.SaveAsync(f.Paths, request, default);
        var stops = f.Adapter.StopCount;
        var recovered = f.RecreateService();

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => recovered.ExecuteTargetAsync(request, default));
        Assert.Equal("dev_preparation_recovery_required", error.Code);
        Assert.Equal(stops, f.Adapter.StopCount);
        Assert.Contains(lease, (await workspaces.Read(tree.Id, owner, default)).Leases);
        Assert.Equal("running", (await f.Apps.GetAppAsync("test.created"))!.RuntimeState);
        Assert.Empty(await f.Backups.ListBackupsAsync("test.created"));
    }

    [Fact]
    public async Task ExecutionTargets_LegacyPreparedArtifactsAreReusedWhenResumingAfterUpgrade()
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        var manifest = await f.Manifests.LoadAsync(Path.Combine(tree.Path, "manifest.json"), "dev", default);
        var service = manifest.Services[0].Key;
        var artifact = new ArtifactLock("image", f.Adapter.RemoteDigest, "fixture/workspace:prepared", null, null, f.Clock.UtcNow);
        var prepared = new RuntimePreparation(new Dictionary<string, ArtifactLock> { [service] = artifact }, [service]);
        var request = (await ExecutionRequest(f, owner, "workspace", tree)) with
            { Prepared = prepared, Phase = "prepared", CandidateDigest = manifest.ManifestDigest };
        await AppExecutionStore.SaveAsync(f.Paths, request, default);
        f.Adapter.PreparationProbe = _ => throw new InvalidOperationException("Duplicate preparation");
        f.Adapter.StartContextProbe = (context, _) =>
        {
            Assert.Equal(artifact, context.App.ArtifactLocks![service]);
            return Task.CompletedTask;
        };
        Assert.Equal("completed", (await f.RecreateService().ExecuteTargetAsync(request, default)).State);
        Assert.Equal(tree.Path, (await f.Apps.GetAppAsync("test.created"))!.SourceState!.LocalOverridePath);
    }

    [Fact]
    public async Task ExecutionTargets_GroupReturnDoesNotDisplaceAnotherWorkspace()
    {
        var (f, owner, workspaces, first, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, first);
        var second = await AnotherExecutionTree(f, owner, workspaces, first);
        await f.Service.StartAsync("test.created");
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", second), default);
        var starts = f.Adapter.StartCount;
        var staleGroupReturn = await ExecutionRequest(f, owner, "package", onlyWorkspace: first.WorkspaceId);
        var result = await f.Service.ExecuteTargetAsync(staleGroupReturn, default);
        Assert.Equal("execution_target_unchanged", result.Code);
        Assert.Equal(second.Id, (await f.Service.GetDevModeAsync("test.created")).WorktreeId);
        Assert.Equal(starts, f.Adapter.StartCount);
    }

    [Fact]
    public async Task ExecutionTargets_RetiredPackageRequestCannotDisplaceANewerWorkspace()
    {
        var (f, owner, workspaces, first, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, first);
        var second = await AnotherExecutionTree(f, owner, workspaces, first);
        await f.Service.StartAsync("test.created");
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", first), default);
        var back = await ExecutionRequest(f, owner, "package");
        var completed = await f.Service.ExecuteTargetAsync(back, default);
        await AppExecutionStore.SaveAsync(f.Paths, completed with { State = "running", Phase = "switching" }, default);
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", second), default);
        var stops = f.Adapter.StopCount;
        Assert.Equal("dev_selection_changed", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.ExecuteTargetAsync(completed with { State = "running", Phase = "switching" }, default))).Code);
        Assert.Equal(second.Id, (await f.Service.GetDevModeAsync("test.created")).WorktreeId);
        Assert.Equal(stops, f.Adapter.StopCount);
    }

    [Fact]
    public async Task ExecutionTargets_CompletedReplayNeverChangesNewerSelection()
    {
        var (f, owner, workspaces, first, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, first);
        var second = await AnotherExecutionTree(f, owner, workspaces, first);
        await f.Service.StartAsync("test.created");
        var a = await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", first), default);
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", second), default);
        var starts = f.Adapter.StartCount;
        Assert.Equal("completed", (await f.Service.ExecuteTargetAsync(a, default)).State);
        Assert.Equal(second.Id, (await f.Service.GetDevModeAsync("test.created")).WorktreeId);
        Assert.Equal(starts, f.Adapter.StartCount);
    }

    [Fact]
    public async Task ExecutionTargets_ExplicitReleaseSelectionBecomesBaselineAcrossServiceRecovery()
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        foreach (var path in new[] { app.ManifestPath!, Path.Combine(tree.Path, "manifest.json") })
        {
            var manifest = JsonNode.Parse(await File.ReadAllTextAsync(path))!;
            manifest["runtimeProfiles"]!.AsArray().Add(new JsonObject { ["key"] = "alternate", ["type"] = "docker" });
            foreach (var service in manifest["services"]!.AsArray())
                service!["runtimes"]!["alternate"] = service["runtimes"]!["docker"]!.DeepClone();
            if (manifest["data"]?["targets"] is JsonArray targets)
            {
                var target = targets.First(t => t?["runtime"]?.GetValue<string>() == "docker")!.DeepClone();
                target["runtime"] = "alternate";
                targets.Add(target);
            }
            await File.WriteAllTextAsync(path, manifest.ToJsonString());
        }
        await f.Service.StartAsync(app.Id);
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", tree), default);
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "package", runtime: "alternate"), default);
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", tree), default);
        var recovered = f.RecreateService();
        Assert.Equal("alternate", await recovered.PackageRuntimeAsync((await f.Apps.GetAppAsync(app.Id))!, default));
        await recovered.ExecuteTargetAsync(await ExecutionRequest(f, owner, "package"), default);
        Assert.Equal("alternate", (await f.Apps.GetAppAsync(app.Id))!.SelectedRuntime);
    }

    [Fact]
    public async Task ExecutionTargets_GroupRetryAfterAuthorityRestorationKeepsItsOriginalRequestId()
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        await using var host = await CoreHttpHarness.StartAsync(f.Clock);
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var now = f.Clock.UtcNow;
        await users.WriteAsync(new(1,
            [new(owner.UserId, "operator@example.test", "Operator", "host.admin", true, now, now)], [], [],
            [new("group-browser", owner.UserId, now, now.AddHours(8), null, now, BrowserOrigin: "http://localhost:7070")]));
        var actor = new WorkspaceActivationActor(owner.UserId, "manual",
            Principal: "browser:" + DevelopmentWorkspaceService.Hash("group-browser"));
        var request = new AppExecutionTargetRequest(Guid.NewGuid().ToString("D"), "package");
        await AppExecutionStore.SaveGroupAsync(f.Paths,
            new(tree.WorkspaceId, request, actor, ["test.created"],
                DevelopmentWorkspaceService.Hash(CoreJson.Text(request) + "\n" + CoreJson.Text(actor) + "\n" + tree.WorkspaceId)), default);
        using var worker = new AppExecutionTargetService(f.Paths, f.Apps, f.Service, workspaces,
            new WorkspaceInspectionService(workspaces, f.Apps, f.Clock),
            host.Services.GetRequiredService<WorkspaceActivationAccess>(), NullLogger<AppExecutionTargetService>.Instance);
        await worker.StartAsync(default);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        async Task<WorkspaceExecutionStatus> AwaitResult()
        {
            while (true)
            {
                var result = await worker.WorkspaceStatusAsync(tree.WorkspaceId, request.RequestId, owner.UserId, timeout.Token);
                if (result.State != "running") return result;
                await Task.Delay(20, timeout.Token);
            }
        }
        try
        {
            Assert.Equal("failed", (await AwaitResult()).State);
            await users.UpdateAsync(state => state with { Users = state.Users.Select(u => u with { Disabled = false }).ToArray() });
            await worker.SubmitWorkspaceAsync(tree.WorkspaceId, request, actor, timeout.Token);
            var recovered = await AwaitResult();
            Assert.Equal("completed", recovered.State);
            Assert.Equal("completed", Assert.Single(recovered.Apps).State);
            Assert.Equal(request.RequestId, recovered.RequestId);
        }
        finally { await worker.StopAsync(CancellationToken.None); }
    }

    [Fact]
    public async Task ExecutionTargets_ReturnUsesCurrentInstalledPackage()
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        await f.Service.StartAsync("test.created");
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", tree), default);
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        var manifest = JsonNode.Parse(await File.ReadAllTextAsync(app.ManifestPath!))!;
        manifest["version"] = "0.9.0";
        await File.WriteAllTextAsync(app.ManifestPath!, manifest.ToJsonString());
        var before = await File.ReadAllTextAsync(app.ManifestPath!);
        Assert.Equal("completed", (await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "package"), default)).State);
        Assert.Equal("0.9.0", (await f.Apps.GetAppAsync(app.Id))!.Version);
        Assert.Equal(before, await File.ReadAllTextAsync(app.ManifestPath!));
    }
}
