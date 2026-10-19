using Haas.Hosty.Launch;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class WorkspaceActivationHandoverTests : IDisposable
{
    private readonly string root = Directory.CreateTempSubdirectory("hosty-handover-").FullName;
    private readonly string id = Guid.NewGuid().ToString();
    private readonly CoreLaunchIdentity previous = new("release", null, null, 101, DateTimeOffset.UtcNow.AddHours(-1));

    private FakeRuntime Prepare()
    {
        Directory.CreateDirectory(Path.Combine(root, "core", "run"));
        File.WriteAllText(Path.Combine(root, "core", "settings.json"), "ordinary state");
        var project = Path.Combine(root, "source", "core.csproj");
        Directory.CreateDirectory(Path.GetDirectoryName(project)!);
        File.WriteAllText(project, "uncommitted source");
        WorkspaceRuntimeFiles.Save(root, new(id, "workspace", "user", "fingerprint", "instance", "revision", "tree",
            project, previous, ["app"], "prepared"));
        return new(root, id, new(previous, "http://localhost:7171", Path.Combine(root, "prior-core")));
    }

    [Theory]
    [InlineData("apply")]
    [InlineData("stop")]
    [InlineData("start")]
    [InlineData("verify")]
    public async Task LostReceipt_ResumesOriginalTargetWithoutRepeatingCompletedEffects(string boundary)
    {
        var runtime = Prepare();
        runtime.FailAfter = boundary;
        var handover = new WorkspaceActivationHandover(root, runtime);
        await Assert.ThrowsAsync<IOException>(() => handover.RunAsync(id));
        runtime.FailAfter = null;
        await handover.RunAsync(id);
        var final = WorkspaceRuntimeFiles.Read(root, id);
        Assert.Equal("active", final.Phase);
        Assert.Equal(runtime.Current!.Launch, final.ActivatedCore);
        Assert.Equal(1, runtime.Builds);
        Assert.Equal(1, runtime.AppMutations);
        Assert.Equal(1, runtime.Stops);
        Assert.Equal(1, runtime.Starts);
        Assert.Single(Directory.GetFiles(Path.Combine(root, "core", "workspace-snapshots"), "*.zip"));
        Assert.Equal("ordinary state", File.ReadAllText(Path.Combine(root, "core", "settings.json")));
        Assert.Equal("uncommitted source", File.ReadAllText(final.CoreProject!));
        await handover.RunAsync(id);
        Assert.Equal(1, runtime.Starts);
        Assert.Equal(1, runtime.Stops);
    }

    [Fact]
    public async Task DeadPreviousCoreDuringApply_RestartsOnlyCapturedTargetAndResumesRequest()
    {
        var runtime = Prepare(); runtime.FailAfter = "apply";
        var handover = new WorkspaceActivationHandover(root, runtime);
        await Assert.ThrowsAsync<IOException>(() => handover.RunAsync(id));
        runtime.Current = null; runtime.FailAfter = null;
        await handover.RunAsync(id);
        Assert.Equal(1, runtime.PreviousRestarts);
        Assert.Equal(1, runtime.AppMutations);
        Assert.Equal(1, runtime.Builds);
        Assert.Equal("active", WorkspaceRuntimeFiles.Read(root, id).Phase);
    }

    [Fact]
    public async Task BuildFailure_ReleasesPreparationWithoutStoppingAnyWriter()
    {
        var runtime = Prepare(); runtime.FailAfter = "build";
        await Assert.ThrowsAsync<IOException>(() => new WorkspaceActivationHandover(root, runtime).RunAsync(id));
        Assert.Equal(0, runtime.Stops);
        Assert.Equal(0, runtime.AppMutations);
        Assert.Equal(previous, runtime.Current!.Launch);
        Assert.Equal("preparing", WorkspaceRuntimeFiles.Read(root, id).Phase);
    }

    [Fact]
    public async Task ChangedBuildAuthority_RefusesBeforeBuildingOrStoppingParticipants()
    {
        var runtime = Prepare(); runtime.FailAfter = "authority";
        await Assert.ThrowsAsync<IOException>(() => new WorkspaceActivationHandover(root, runtime).RunAsync(id));
        Assert.Equal(0, runtime.Builds); Assert.Equal(0, runtime.Stops); Assert.Equal(0, runtime.AppMutations);
        Assert.Equal(previous, runtime.Current!.Launch);
        Assert.Equal("preparing", WorkspaceRuntimeFiles.Read(root, id).Phase);
    }

    [Fact]
    public async Task CancellationDuringBuild_RetiresPreStopRequestWithoutDiscardingSource()
    {
        var runtime = Prepare(); runtime.CancelDuringBuild = true;
        await Assert.ThrowsAsync<OperationCanceledException>(() => new WorkspaceActivationHandover(root, runtime).RunAsync(id));
        Assert.Equal("cancelled", WorkspaceRuntimeFiles.Read(root, id).Phase);
        Assert.Equal(0, runtime.Stops);
        Assert.Equal(0, runtime.AppMutations);
        Assert.True(File.Exists(WorkspaceRuntimeFiles.Read(root, id).CoreProject));
        await new WorkspaceActivationHandover(root, runtime).RunAsync(id);
        Assert.Equal(0, runtime.Starts);
    }

    [Fact]
    public async Task DifferentCoreAfterStop_IsNeverStoppedOrReportedAsCandidate()
    {
        var runtime = Prepare(); runtime.FailAfter = "stop";
        var handover = new WorkspaceActivationHandover(root, runtime);
        await Assert.ThrowsAsync<IOException>(() => handover.RunAsync(id));
        runtime.FailAfter = null;
        runtime.Current = new(new("dev", "other.csproj", "other-generation", 202, DateTimeOffset.UtcNow), "http://localhost:7171");
        await Assert.ThrowsAsync<InvalidOperationException>(() => handover.RunAsync(id));
        Assert.Equal(1, runtime.Stops);
        Assert.Equal(0, runtime.Starts);
        Assert.NotEqual("active", WorkspaceRuntimeFiles.Read(root, id).Phase);
    }

    [Fact]
    public async Task LiveButUnresponsiveCandidate_IsNotStartedAgain()
    {
        var runtime = Prepare(); runtime.FailAfter = "start";
        var handover = new WorkspaceActivationHandover(root, runtime);
        await Assert.ThrowsAsync<IOException>(() => handover.RunAsync(id));
        runtime.Current = null; runtime.FailAfter = null;
        using var processLock = new FileStream(Path.Combine(root, "core", "run", "core.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        await Assert.ThrowsAsync<IOException>(() => handover.RunAsync(id));
        Assert.Equal(1, runtime.Starts);
        Assert.Equal("core-starting", WorkspaceRuntimeFiles.Read(root, id).Phase);
    }

    [Fact]
    public async Task CandidateDiesDuringFinalVerification_ResumesRetainedGenerationWithoutRebuilding()
    {
        var runtime = Prepare(); runtime.FailAfter = "verify";
        var handover = new WorkspaceActivationHandover(root, runtime);
        await Assert.ThrowsAsync<IOException>(() => handover.RunAsync(id));
        var candidate = WorkspaceRuntimeFiles.Read(root, id);
        runtime.Current = null; runtime.FailAfter = null;
        await handover.RunAsync(id);
        var recovered = WorkspaceRuntimeFiles.Read(root, id);
        Assert.Equal("active", recovered.Phase);
        Assert.Equal(candidate.Generation, recovered.Generation);
        Assert.Equal(candidate.Snapshot, recovered.Snapshot);
        Assert.Equal(1, runtime.Builds);
        Assert.Equal(1, runtime.Stops);
        Assert.Equal(2, runtime.Starts);
    }

    [Fact]
    public async Task FailedReadinessAfterHandover_KeepsCandidateAndPartialState()
    {
        var runtime = Prepare(); runtime.FailAfter = "verify";
        await Assert.ThrowsAsync<IOException>(() => new WorkspaceActivationHandover(root, runtime).RunAsync(id));
        Assert.Equal("verifying", WorkspaceRuntimeFiles.Read(root, id).Phase);
        Assert.NotNull(runtime.Current);
        Assert.Equal(1, runtime.Starts);
        Assert.Equal(1, runtime.Stops);
    }

    private sealed class FakeRuntime(string root, string id, WorkspaceCoreObservation initial) : IWorkspaceActivationRuntime
    {
        private readonly WorkspaceCoreObservation initialTarget = initial;
        internal WorkspaceCoreObservation? Current = initial;
        internal string? FailAfter;
        internal bool CancelDuringBuild;
        internal int Builds, Stops, Starts, AppMutations, PreviousRestarts;
        public Task<WorkspaceCoreObservation?> ObserveAsync() => Task.FromResult(Current);
        public Task ValidateAuthorityAsync(string requestId)
        { Assert.Equal(id, requestId); Fail("authority"); return Task.CompletedTask; }
        public Task<WorkspaceCoreOutput> BuildAsync(string project)
        {
            Builds++;
            var generation = Path.Combine(root, "core", "builds", "candidate");
            Directory.CreateDirectory(generation);
            var executable = Path.Combine(generation, "hosty-core"); File.WriteAllText(executable, "compiled target");
            if (CancelDuringBuild) WorkspaceActivationSupervisor.Cancel(root, id);
            Fail("build"); return Task.FromResult(new WorkspaceCoreOutput(executable, generation));
        }
        public Task ApplyAppsAsync(string requestId)
        {
            Assert.Equal(id, requestId);
            var a = WorkspaceRuntimeFiles.Read(root, id);
            if (a.Phase == "prepared") { AppMutations++; WorkspaceRuntimeFiles.Save(root, a with { Phase = "apps-active" }); }
            Fail("apply"); return Task.CompletedTask;
        }
        public Task VerifyAppsAsync(string requestId)
        {
            if (Starts > 0) Fail("verify");
            return Task.CompletedTask;
        }
        public Task StopAsync() { Stops++; Current = null; Fail("stop"); return Task.CompletedTask; }
        public Task StartAsync(WorkspaceRuntimeActivation a)
        {
            Starts++;
            Current = new(new("dev", a.CoreProject, a.Generation, 999, DateTimeOffset.UtcNow), a.ListenUrl!);
            Fail("start"); return Task.CompletedTask;
        }
        public Task RestorePreviousAsync(WorkspaceRuntimeActivation activation)
        {
            PreviousRestarts++;
            Assert.Equal(initialTarget.Executable, activation.PreviousExecutable);
            Current = initialTarget with { Launch = initialTarget.Launch with { ProcessId = 303, StartedAt = DateTimeOffset.UtcNow } };
            return Task.CompletedTask;
        }
        public Task ReleasePreparationAsync(string requestId)
        {
            WorkspaceRuntimeFiles.Save(root, WorkspaceRuntimeFiles.Read(root, id) with { Phase = "preparing", PreparedExecutable = null, Generation = null });
            return Task.CompletedTask;
        }
        private void Fail(string at) { if (FailAfter == at) throw new IOException("Injected lost response after " + at); }
    }
    public void Dispose() => Directory.Delete(root, true);
}
