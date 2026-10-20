using System.Diagnostics;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class WorkspaceActivationSupervisorTests : IDisposable
{
    private readonly string root = Directory.CreateTempSubdirectory("hosty-supervisor-").FullName;
    private readonly string id = Guid.NewGuid().ToString();
    public WorkspaceActivationSupervisorTests() => WorkspaceRuntimeFiles.Save(root,
        new(id, "workspace", "user", "selection", "instance", "revision", null, null,
            new("release", null, null, 1, DateTimeOffset.UtcNow), [], "prepared"));

    [Fact]
    public void DuplicateDispatchAndDelayedHelpers_CannotTakeOverAnAttempt()
    {
        var spawns = 0;
        var first = WorkspaceActivationSupervisor.Dispatch(root, id, false, _ => spawns++);
        Assert.Equal(first, WorkspaceActivationSupervisor.Dispatch(root, id, false, _ => spawns++));
        Assert.Equal(1, spawns);
        using var held = CoreLaunchFiles.Lock(root);
        Assert.Throws<InvalidOperationException>(() => WorkspaceActivationSupervisor.Claim(root, id, "obsolete"));
        var claimed = WorkspaceActivationSupervisor.Claim(root, id, first.Attempt);
        Assert.Equal(Environment.ProcessId, claimed.Pid);
        Assert.Throws<InvalidOperationException>(() => WorkspaceActivationSupervisor.Claim(root, id, first.Attempt));
        Assert.Equal(claimed, WorkspaceActivationSupervisor.Dispatch(root, id, false, _ => spawns++));
        Assert.Equal(1, spawns);
    }

    [Fact]
    public void AbandonedHelper_PreservesRequestAndSelectionButUsesNewAttempt()
    {
        var first = WorkspaceActivationSupervisor.Dispatch(root, id, false, _ => { });
        WorkspaceActivationSupervisor.Save(root, first with { State = "running", Pid = int.MaxValue, StartedAt = DateTimeOffset.MinValue });
        Assert.Equal("interrupted", WorkspaceActivationSupervisor.Status(root, id).Helper!.State);
        Assert.Throws<InvalidOperationException>(() => CoreLaunchFiles.AssertNoPendingOperations(root));
        var next = WorkspaceActivationSupervisor.Dispatch(root, id, false, _ => { });
        Assert.Equal(first.Id, next.Id);
        Assert.NotEqual(first.Attempt, next.Attempt);
        Assert.Equal("selection", WorkspaceRuntimeFiles.Read(root, id).Fingerprint);
        Assert.NotEqual(first.LogPath, next.LogPath);
    }

    [Fact]
    public void Cancellation_RequiresExplicitResumeAndNeverReplaysTerminalRequest()
    {
        WorkspaceActivationSupervisor.Cancel(root, id);
        Assert.Throws<InvalidOperationException>(() => WorkspaceActivationSupervisor.Dispatch(root, id, false, _ => { }));
        var helper = WorkspaceActivationSupervisor.Dispatch(root, id, true, _ => { });
        Assert.False(WorkspaceActivationSupervisor.CancellationRequested(root, id));
        WorkspaceActivationSupervisor.Save(root, helper with { State = "completed" });
        WorkspaceRuntimeFiles.Save(root, WorkspaceRuntimeFiles.Read(root, id) with { Phase = "returned" });
        WorkspaceActivationSupervisor.Dispatch(root, id, true, _ => throw new Exception("must not spawn"));
        Assert.False(WorkspaceActivationSupervisor.Cancel(root, id).CancellationRequested);
    }

    [Fact]
    public void SpawnFailure_IsRetainedAndCanBeRetriedWithOriginalId()
    {
        Assert.Throws<IOException>(() => WorkspaceActivationSupervisor.Dispatch(root, id, false, _ => throw new IOException("spawn failed")));
        Assert.Equal("failed", WorkspaceActivationSupervisor.Status(root, id).Helper!.State);
        Assert.Equal(id, WorkspaceActivationSupervisor.Dispatch(root, id, false, _ => { }).Id);
    }

    [Fact]
    public void TerminalGroupReceiptReconcilesLostHelperAcknowledgementWithoutDispatch()
    {
        var helper = WorkspaceActivationSupervisor.Dispatch(root, id, false, _ => { });
        WorkspaceActivationSupervisor.Save(root, helper with { State = "failed", Error = "lost response" });
        WorkspaceRuntimeFiles.Save(root, WorkspaceRuntimeFiles.Read(root, id) with { Phase = "active" });
        Assert.Equal("completed", WorkspaceActivationSupervisor.Status(root, id).Helper!.State);
        var replay = WorkspaceActivationSupervisor.Dispatch(root, id, false, _ => throw new Exception("must not spawn"));
        Assert.Equal("completed", replay.State);
        Assert.Null(replay.Error);
    }

    [Fact]
    public async Task DetachedLauncher_SurvivesSpawningShellExitAndRetainsAttemptLog()
    {
        if (OperatingSystem.IsWindows()) return; // Windows launcher is exercised by native host acceptance.
        var result = Path.Combine(root, "result");
        var log = Path.Combine(root, "helper.log");
        DetachedCliProcess.SpawnDetached("/bin/sh", ["-c", "sleep 0.2; printf done > \"$1\"", "helper", result], root, "helper.log", log);
        var deadline = DateTimeOffset.UtcNow.AddSeconds(5);
        while (!File.Exists(result) && DateTimeOffset.UtcNow < deadline) await Task.Delay(20);
        Assert.Equal("done", File.ReadAllText(result));
        Assert.True(File.Exists(log));
    }
    public void Dispose() => Directory.Delete(root, true);
}
