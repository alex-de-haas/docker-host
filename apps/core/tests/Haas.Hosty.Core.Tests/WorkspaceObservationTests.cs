using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static async Task WaitForObservation(Func<Task<bool>> ready)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(12));
        while (!await ready()) await Task.Delay(40, deadline.Token);
    }

    [Fact]
    public async Task WorkspaceEvents_ObserveEditsAndIndexChangesWithoutIdleScansOrRewrites()
    {
        var (f, _) = await SourceFixtureAsync();
        var state = new WorkspaceObservationState(new CoreEventHub());
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, observationState: state);
        var tree = await service.PrepareAsync(WorkspaceTestOwner(f), WorkspaceRequest(), default);
        using var observer = new DevelopmentWorkspaceObserver(service, state, f.Paths,
            NullLogger<DevelopmentWorkspaceObserver>.Instance, TimeSpan.FromMilliseconds(100));
        await observer.StartAsync(default);
        try
        {
            await WaitForObservation(() => Task.FromResult(state.Health(tree.Id) == "watching" && !state.NeedsObservation(tree.Id)));
            var inspection = new WorkspaceInspectionService(service, f.Apps, f.Clock, observationState: state);
            var first = await inspection.ReadAsync(tree.WorkspaceId, tree.Id, "admin", default);
            var scans = state.ScanCount(tree.Id);
            var record = Path.Combine(f.Paths.CoreRoot, "development/workspaces", tree.Id + ".json");
            var modified = File.GetLastWriteTimeUtc(record);
            for (var i = 0; i < 5; i++)
            {
                await Task.Delay(100);
                var current = await inspection.ReadAsync(tree.WorkspaceId, tree.Id, "admin", default);
                Assert.Equal(first.SessionChanges, current.SessionChanges);
            }
            Assert.Equal(scans, state.ScanCount(tree.Id));
            Assert.Equal(modified, File.GetLastWriteTimeUtc(record));
            await File.WriteAllTextAsync(Path.Combine(tree.Path, "README.md"), "changed by an external editor\n");
            await WaitForObservation(async () => (await service.Read(tree.Id, null, default)).Observation!.Local!.Files.Any(x => x.Path == "README.md"));
            var changed = await inspection.ReadAsync(tree.WorkspaceId, tree.Id, "admin", default);
            Assert.Single(changed.SessionChanges);
            Assert.NotEqual(first.ObservationRevision, changed.ObservationRevision);
            await RunGitAsync(tree.Path, ["add", "README.md"]);
            await WaitForObservation(async () => (await service.Read(tree.Id, null, default)).Observation!.Local!.Files.Any(x => x.Path == "README.md" && x.Status == "M "));
        }
        finally { await observer.StopAsync(default); }
    }

    [Fact]
    public async Task WorkspaceEvents_BusyOwnerRetainsChangesAndPauseResumeReconcilesFreshSource()
    {
        var (f, _) = await SourceFixtureAsync();
        var state = new WorkspaceObservationState(new CoreEventHub());
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, observationState: state);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        using var observer = new DevelopmentWorkspaceObserver(service, state, f.Paths, NullLogger<DevelopmentWorkspaceObserver>.Instance);
        await observer.StartAsync(default);
        try
        {
            await WaitForObservation(() => Task.FromResult(state.Health(tree.Id) == "watching" && !state.NeedsObservation(tree.Id)));
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var held = service.WithIdleSourceAsync(owner, async () => { entered.SetResult(); await release.Task; return true; }, default);
            await entered.Task;
            try
            {
                await File.WriteAllTextAsync(Path.Combine(tree.Path, "new.txt"), "pending while owner is busy");
                await WaitForObservation(() => Task.FromResult(state.NeedsObservation(tree.Id)));
                Assert.DoesNotContain((await service.Read(tree.Id, null, default)).Observation!.Local!.Files, x => x.Path == "new.txt");
            }
            finally { release.SetResult(); await held; }
            await WaitForObservation(async () => (await service.Read(tree.Id, null, default)).Observation!.Local!.Files.Any(x => x.Path == "new.txt"));
            var paused = await service.ChangeWorkflowAsync(owner, "admin", "pause", new(Guid.NewGuid().ToString(), 0), new Dictionary<string, string>(), default);
            await WaitForObservation(() => Task.FromResult(state.Health(tree.Id) == "paused"));
            var scans = state.ScanCount(tree.Id);
            await File.WriteAllTextAsync(Path.Combine(tree.Path, "paused.txt"), "retained changes");
            await Task.Delay(700);
            Assert.Equal(scans, state.ScanCount(tree.Id));
            await service.ChangeWorkflowAsync(owner, "admin", "resume", new(Guid.NewGuid().ToString(), paused.Revision), new Dictionary<string, string>(), default);
            await WaitForObservation(async () => state.Health(tree.Id) == "watching" && (await service.Read(tree.Id, null, default)).Observation!.Local!.Files.Any(x => x.Path == "paused.txt"));
            var workflow = await service.WorkflowAsync(owner, default);
            await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeWorkflowAsync(owner, "admin", "complete", new(Guid.NewGuid().ToString(), workflow.Revision), new Dictionary<string, string>(), default));
        }
        finally { await observer.StopAsync(default); }
    }

    [Fact]
    public async Task WorkspaceEvents_PausedReadsBeforeObserverStartupKeepCachedSourceUntilExplicitRefresh()
    {
        var (f, _) = await SourceFixtureAsync();
        var state = new WorkspaceObservationState(new CoreEventHub());
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, observationState: state);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        await service.ChangeWorkflowAsync(owner, "admin", "pause", new(Guid.NewGuid().ToString(), 0), new Dictionary<string, string>(), default);
        state.Invalidate(tree.Id);
        var scans = state.ScanCount(tree.Id);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "paused-startup.txt"), "external change while paused");
        var cached = await service.ReadObservedAsync(tree.Id, default);
        Assert.Equal(scans, state.ScanCount(tree.Id));
        Assert.DoesNotContain(cached.Observation!.Local!.Files, f => f.Path == "paused-startup.txt");
        var fresh = await service.ReadObservedAsync(tree.Id, default, refresh: true);
        Assert.Contains(fresh.Observation!.Local!.Files, f => f.Path == "paused-startup.txt");
    }

    [Fact]
    public async Task WorkspaceEvents_RootReplacementRecoversAndIgnoredOutputDoesNotScan()
    {
        var (f, _) = await SourceFixtureAsync();
        var state = new WorkspaceObservationState(new CoreEventHub());
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, observationState: state);
        var tree = await service.PrepareAsync(WorkspaceTestOwner(f), WorkspaceRequest(), default);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, ".gitignore"), "output/\n");
        var log = new ObservationTestLog();
        using var observer = new DevelopmentWorkspaceObserver(service, state, f.Paths,
            log, TimeSpan.FromMilliseconds(150));
        await observer.StartAsync(default);
        try
        {
            await WaitForObservation(() => Task.FromResult(state.Health(tree.Id) == "watching" && !state.NeedsObservation(tree.Id)));
            var scans = state.ScanCount(tree.Id);
            Directory.CreateDirectory(Path.Combine(tree.Path, "output"));
            for (var i = 0; i < 500; i++) await File.WriteAllTextAsync(Path.Combine(tree.Path, "output", i + ".txt"), "generated");
            await Task.Delay(1000);
            Assert.True(scans == state.ScanCount(tree.Id), string.Join("\n", log.Lines));
            Directory.Move(tree.Path, tree.Path + "-moved");
            await WaitForObservation(async () => (await service.Read(tree.Id, null, default)).Observation!.State == "unavailable");
            Directory.Move(tree.Path + "-moved", tree.Path);
            await File.WriteAllTextAsync(Path.Combine(tree.Path, "recovered.txt"), "source is back");
            await WaitForObservation(async () => state.Health(tree.Id) == "watching" && (await service.Read(tree.Id, null, default)).Observation!.Local!.Files.Any(x => x.Path == "recovered.txt"));
        }
        finally { await observer.StopAsync(default); }
    }

    [Fact]
    public async Task WorkspaceEvents_AtomicRenameDeleteSharedRefsAndRestartResynchronize()
    {
        var (f, _) = await SourceFixtureAsync();
        var state = new WorkspaceObservationState(new CoreEventHub());
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, observationState: state);
        var tree = await service.PrepareAsync(WorkspaceTestOwner(f), WorkspaceRequest(), default);
        using (var observer = new DevelopmentWorkspaceObserver(service, state, f.Paths, NullLogger<DevelopmentWorkspaceObserver>.Instance))
        {
            await observer.StartAsync(default);
            try
            {
                await WaitForObservation(() => Task.FromResult(state.Health(tree.Id) == "watching" && !state.NeedsObservation(tree.Id)));
                await File.WriteAllTextAsync(Path.Combine(tree.Path, "atomic.tmp"), "atomic replacement");
                File.Move(Path.Combine(tree.Path, "atomic.tmp"), Path.Combine(tree.Path, "README.md"), true);
                await WaitForObservation(async () => (await service.Read(tree.Id, null, default)).Observation!.Local!.Files.Any(f => f.Path == "README.md"));
                File.Move(Path.Combine(tree.Path, "README.md"), Path.Combine(tree.Path, "renamed.md"));
                await WaitForObservation(async () => (await service.Read(tree.Id, null, default)).Observation!.Local!.Files.Any(f => f.Path == "renamed.md"));
                File.Delete(Path.Combine(tree.Path, "renamed.md"));
                await WaitForObservation(async () => !(await service.Read(tree.Id, null, default)).Observation!.Local!.Files.Any(f => f.Path == "renamed.md"));
                await RunGitAsync(tree.Path, ["add", "--all"]);
                await RunGitAsync(tree.Path, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Test event observation"]);
                var head = (await DevelopmentWorkspaceService.Git(tree.Path, ["rev-parse", "HEAD"], default)).StandardOutput.Trim();
                var reference = (await DevelopmentWorkspaceService.Git(service.RepositoryPath(tree.Repository), ["for-each-ref", "--format=%(refname)", "refs/hosty/targets/"], default)).StandardOutput.Trim();
                Assert.StartsWith("refs/hosty/targets/", reference);
                await RunGitAsync(service.RepositoryPath(tree.Repository), ["update-ref", reference, head]);
                await WaitForObservation(async () => (await service.Read(tree.Id, null, default)).Observation!.TargetHead == head);
            }
            finally { await observer.StopAsync(default); }
        }
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "offline.txt"), "changed while Core was stopped");
        var restarted = new WorkspaceObservationState(new CoreEventHub());
        var restartedService = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, observationState: restarted);
        using var replacement = new DevelopmentWorkspaceObserver(restartedService, restarted, f.Paths, NullLogger<DevelopmentWorkspaceObserver>.Instance);
        await replacement.StartAsync(default);
        try { await WaitForObservation(async () => (await restartedService.Read(tree.Id, null, default)).Observation!.Local!.Files.Any(f => f.Path == "offline.txt")); }
        finally { await replacement.StopAsync(default); }
    }

    [Fact]
    public async Task WorkspaceEvents_IgnoredDirectoryWithTrackedFileCannotSuppressChanges()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var tree = await service.PrepareAsync(WorkspaceTestOwner(f), WorkspaceRequest(), default);
        Directory.CreateDirectory(Path.Combine(tree.Path, "output"));
        await File.WriteAllTextAsync(Path.Combine(tree.Path, ".gitignore"), "output/\n");
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "output", "tracked.txt"), "source");
        await RunGitAsync(tree.Path, ["add", "--force", "output/tracked.txt"]);
        Assert.True(await DevelopmentWorkspaceObserver.RelevantAsync(tree.Path, ["subtree:output"], default));
        Assert.True(await DevelopmentWorkspaceObserver.RelevantAsync(tree.Path, ["output/tracked.txt"], default));
    }

    [Fact]
    public void WorkspaceEvents_GenerationAndStreamOverflowPreserveRecoveryEvidence()
    {
        var events = new CoreEventHub();
        var state = new WorkspaceObservationState(events);
        var captured = state.Generation("one");
        state.Invalidate("one");
        state.Observed("one", captured);
        Assert.True(state.NeedsObservation("one"));
        using var ordinary = events.Subscribe("admin", true);
        using var workspace = events.Subscribe("admin", false, workspaces: true);
        for (var i = 0; i < 100; i++) events.PublishWorkspaceChange("one");
        Assert.False(ordinary.Reader.TryRead(out _));
        Assert.True(workspace.Dropped > 0);
        Assert.True(workspace.Reader.TryRead(out var change));
        Assert.Equal(CoreEventHub.WorkspaceChanged, change.Name);
    }
}

internal sealed class ObservationTestLog : Microsoft.Extensions.Logging.ILogger<DevelopmentWorkspaceObserver>
{
    public System.Collections.Concurrent.ConcurrentQueue<string> Lines { get; } = new();
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(Microsoft.Extensions.Logging.LogLevel level) => true;
    public void Log<TState>(Microsoft.Extensions.Logging.LogLevel level, Microsoft.Extensions.Logging.EventId id, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        => Lines.Enqueue(formatter(state, exception));
}
