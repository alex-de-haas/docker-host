using Haas.Hosty.Launch;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class WorkspaceActivationReturnTests : IDisposable
{
    private readonly string root = Directory.CreateTempSubdirectory("hosty-return-").FullName;
    private readonly string id = Guid.NewGuid().ToString();
    private readonly CoreLaunchIdentity previous = new("dev", "/previous/project.csproj", "/previous/generation", 42, DateTimeOffset.UtcNow.AddHours(-1));
    private FakeRuntime Prepare()
    {
        var executable = Path.Combine(root, "prior"); File.WriteAllText(executable, "immutable executable");
        File.WriteAllText(Path.Combine(root, "current-data"), "new state");
        File.WriteAllText(Path.Combine(root, "source"), "uncommitted changes");
        var a = new WorkspaceRuntimeActivation(id, "workspace", "user", "fingerprint", "instance", "revision", "tree",
            "/candidate/project.csproj", previous, ["one", "two"], "active", executable, "/candidate/generation", "retained-snapshot",
            PreviousExecutable: executable, PreviousExecutableHash: WorkspaceActivationReturn.ExecutableHash(executable));
        WorkspaceRuntimeFiles.Save(root, a);
        return new(root, id, new(new("dev", a.CoreProject, a.Generation, 43, DateTimeOffset.UtcNow), "http://localhost:3333"));
    }
    private WorkspaceReturnRequest Request(string[] apps, bool core = false, bool accept = true) => new(Guid.NewGuid().ToString(), apps, core, accept);

    [Fact]
    public async Task IndividualThenGroupReturn_ReleasesOnlySelectedBindingsAndPreservesDataSource()
    {
        var runtime = Prepare(); var first = Request(["one"]);
        WorkspaceActivationReturn.Prepare(root, id, first);
        await new WorkspaceActivationHandover(root, runtime).RunAsync(id);
        var a = WorkspaceRuntimeFiles.Read(root, id);
        Assert.Equal("active", a.Phase); Assert.Equal(new[] { "one" }, a.ReturnedApps); Assert.False(a.CoreReturned);
        Assert.Equal(0, runtime.Stops); Assert.Equal(0, runtime.Restores);
        var second = Request(["two"], core: true);
        WorkspaceActivationReturn.Prepare(root, id, second);
        await new WorkspaceActivationHandover(root, runtime).RunAsync(id);
        a = WorkspaceRuntimeFiles.Read(root, id);
        Assert.Equal("returned", a.Phase); Assert.True(a.CoreReturned); Assert.Equal(1, runtime.Restores);
        Assert.Equal(1, runtime.AppStateRestores);
        Assert.Equal(new[] { "one", "two" }, a.Returns!.Last().AppsBeforeCoreReturn!.Select(app => app.AppId));
        Assert.True(WorkspaceActivationHandover.SameTarget(previous, runtime.Current!.Launch));
        Assert.Equal("new state", File.ReadAllText(Path.Combine(root, "current-data")));
        Assert.Equal("uncommitted changes", File.ReadAllText(Path.Combine(root, "source")));
        WorkspaceActivationReturn.Prepare(root, id, first);
        await new WorkspaceActivationHandover(root, runtime).RunAsync(id);
        Assert.Equal(1, runtime.Restores); Assert.Equal(2, runtime.AppReturns);
    }

    [Theory]
    [InlineData("stop")]
    [InlineData("restore")]
    public async Task LostCoreResponse_ResumesCapturedGenerationWithoutRepeatingEffects(string boundary)
    {
        var runtime = Prepare(); runtime.FailAfter = boundary;
        var request = Request([], core: true);
        WorkspaceActivationReturn.Prepare(root, id, request);
        await Assert.ThrowsAsync<IOException>(() => new WorkspaceActivationHandover(root, runtime).RunAsync(id));
        runtime.FailAfter = null;
        WorkspaceActivationReturn.Prepare(root, id, request);
        await new WorkspaceActivationHandover(root, runtime).RunAsync(id);
        Assert.True(WorkspaceRuntimeFiles.Read(root, id).CoreReturned);
        Assert.Equal(1, runtime.Stops); Assert.Equal(1, runtime.Restores);
    }

    [Fact]
    public async Task AppStateRecoveryFailureKeepsReturnPendingAndResumesWithoutAnotherCoreRestart()
    {
        var runtime = Prepare(); runtime.FailAppState = true;
        var request = Request(["one", "two"], true);
        WorkspaceActivationReturn.Prepare(root, id, request);
        await Assert.ThrowsAsync<IOException>(() => new WorkspaceActivationHandover(root, runtime).RunAsync(id));
        var a = WorkspaceRuntimeFiles.Read(root, id);
        Assert.Equal("return-core-starting", a.Phase); Assert.Equal("pending", a.Returns!.Last().State);
        Assert.False(a.CoreReturned); Assert.Equal(2, a.Returns.Last().AppsBeforeCoreReturn!.Length);
        runtime.FailAppState = false;
        await new WorkspaceActivationHandover(root, runtime).RunAsync(id);
        Assert.Equal("returned", WorkspaceRuntimeFiles.Read(root, id).Phase);
        Assert.Equal(1, runtime.Stops); Assert.Equal(1, runtime.Restores);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ReturnWithoutCompatibilityAcceptance_LeavesReceiptAndProcessesUntouched(bool core)
    {
        var runtime = Prepare(); var before = File.ReadAllText(WorkspaceRuntimeFiles.PathFor(root, id));
        Assert.Throws<InvalidOperationException>(() => WorkspaceActivationReturn.Prepare(root, id, Request(core ? [] : ["one"], core, false)));
        Assert.Equal(before, File.ReadAllText(WorkspaceRuntimeFiles.PathFor(root, id)));
        Assert.Equal(0, runtime.Stops); Assert.Equal(0, runtime.AppReturns);
    }

    [Fact]
    public async Task RetainedUnacknowledgedAppReturnDoesNotStopParticipantsOnResume()
    {
        var runtime = Prepare(); var a = WorkspaceRuntimeFiles.Read(root, id);
        WorkspaceRuntimeFiles.Save(root, a with { Phase = "return-apps", Returns = [new(Request(["one"], accept: false), "pending")] });
        await Assert.ThrowsAsync<InvalidOperationException>(() => new WorkspaceActivationHandover(root, runtime).RunAsync(id));
        Assert.Equal(0, runtime.AppReturns); Assert.Equal(0, runtime.Stops);
        Assert.Equal("pending", WorkspaceRuntimeFiles.Read(root, id).Returns![0].State);
    }

    [Fact]
    public async Task AlreadyRestoredCoreAtStopBoundary_EntersGuardedAppRecoveryPhaseWithoutRestarting()
    {
        var runtime = Prepare(); WorkspaceActivationReturn.Prepare(root, id, Request([], true));
        var a = WorkspaceRuntimeFiles.Read(root, id);
        WorkspaceRuntimeFiles.Save(root, a with { Phase = "return-core-stopping", ReturnedApps = ["one"],
            Returns = [a.Returns![0] with { AppsBeforeCoreReturn = [new("one", "captured", true, false)] }] });
        runtime.Current = new(previous with { ProcessId = 900, StartedAt = DateTimeOffset.UtcNow }, "http://localhost:3333");
        await new WorkspaceActivationHandover(root, runtime).RunAsync(id);
        Assert.True(WorkspaceRuntimeFiles.Read(root, id).CoreReturned);
        Assert.Equal(1, runtime.AppStateRestores); Assert.Equal(0, runtime.Stops); Assert.Equal(0, runtime.Restores);
    }

    [Fact]
    public async Task ChangedPreviousExecutable_RefusesBeforeStoppingCandidate()
    {
        var runtime = Prepare(); WorkspaceActivationReturn.Prepare(root, id, Request([], true));
        File.WriteAllText(Path.Combine(root, "prior"), "different executable");
        await Assert.ThrowsAsync<IOException>(() => new WorkspaceActivationHandover(root, runtime).RunAsync(id));
        Assert.Equal(0, runtime.Stops); Assert.Equal(0, runtime.Restores);
    }

    [Fact]
    public async Task UnrelatedCore_RefusesBeforeStoppingIt()
    {
        var runtime = Prepare(); WorkspaceActivationReturn.Prepare(root, id, Request([], true));
        runtime.Current = new(new("release", null, null, 999, DateTimeOffset.UtcNow), "http://localhost");
        await Assert.ThrowsAsync<InvalidOperationException>(() => new WorkspaceActivationHandover(root, runtime).RunAsync(id));
        Assert.Equal(0, runtime.Stops);
    }

    [Fact]
    public async Task PartialAppFailure_RetainsCompletedParticipantsAndDoesNotStopCore()
    {
        var runtime = Prepare(); runtime.FailApp = true;
        var request = Request(["one", "two"], true);
        WorkspaceActivationReturn.Prepare(root, id, request);
        await Assert.ThrowsAsync<IOException>(() => new WorkspaceActivationHandover(root, runtime).RunAsync(id));
        Assert.Equal(new[] { "one" }, WorkspaceRuntimeFiles.Read(root, id).ReturnedApps);
        Assert.Equal(0, runtime.Stops);
        runtime.FailApp = false;
        await new WorkspaceActivationHandover(root, runtime).RunAsync(id);
        Assert.Equal("returned", WorkspaceRuntimeFiles.Read(root, id).Phase); Assert.Equal(2, runtime.AppReturns);
    }

    [Fact]
    public void ChangedReplaySelectionAndForeignParticipants_AreRefused()
    {
        Prepare(); var request = Request(["one"]); WorkspaceActivationReturn.Prepare(root, id, request);
        Assert.Throws<InvalidOperationException>(() => WorkspaceActivationReturn.Prepare(root, id, request with { Apps = ["two"] }));
        Assert.Throws<InvalidOperationException>(() => WorkspaceActivationReturn.Prepare(root, id, Request(["foreign"])));
    }

    private sealed class FakeRuntime(string root, string id, WorkspaceCoreObservation current) : IWorkspaceActivationRuntime
    {
        internal WorkspaceCoreObservation? Current = current;
        internal string? FailAfter; internal bool FailApp, FailAppState; internal int Stops, Restores, AppReturns, AppStateRestores;
        public Task<WorkspaceCoreObservation?> ObserveAsync() => Task.FromResult(Current);
        public Task<WorkspaceCoreOutput> BuildAsync(string project) => throw new Exception("Return must never rebuild.");
        public Task ApplyAppsAsync(string id) => throw new Exception("Return must never activate apps.");
        public Task VerifyAppsAsync(string id) => throw new Exception("Return verifies previous targets.");
        public Task ReleasePreparationAsync(string id) => throw new Exception("Unexpected release.");
        public Task StartAsync(WorkspaceRuntimeActivation a) => throw new Exception("Unexpected candidate restart.");
        public Task StopAsync() { Stops++; Current = null; if (FailAfter == "stop") throw new IOException("response lost"); return Task.CompletedTask; }
        public Task RestorePreviousAsync(WorkspaceRuntimeActivation a)
        {
            Restores++; Current = new(a.PreviousCore with { ProcessId = 900, StartedAt = DateTimeOffset.UtcNow }, "http://localhost:3333");
            if (FailAfter == "restore") throw new IOException("response lost"); return Task.CompletedTask;
        }
        public Task<WorkspaceReturnAppState[]> CaptureReturnAppsAsync(WorkspaceRuntimeActivation a)
            => Task.FromResult((a.ReturnedApps ?? []).Select(app => new WorkspaceReturnAppState(app, "captured", true, false)).ToArray());
        public Task RestoreReturnAppsAsync(WorkspaceRuntimeActivation a, WorkspaceReturnAppState[] apps)
        { AppStateRestores++; Assert.Equal("return-core-starting", WorkspaceRuntimeFiles.Read(root, a.Id).Phase); Assert.True(WorkspaceActivationHandover.SameTarget(a.PreviousCore, Current!.Launch)); if (FailAppState) throw new IOException("app readiness failed"); return Task.CompletedTask; }
        public Task ReturnAppsAsync(string value)
        {
            Assert.Equal(id, value);
            var a = WorkspaceRuntimeFiles.Read(root, id);
            foreach (var app in a.Returns!.Last().Request.Apps)
            {
                if ((a.ReturnedApps ?? []).Contains(app)) continue;
                if (app == "two" && FailApp) throw new IOException("second app failed");
                AppReturns++; a = a with { ReturnedApps = [.. a.ReturnedApps ?? [], app] }; WorkspaceRuntimeFiles.Save(root, a);
            }
            return Task.CompletedTask;
        }
    }
    public void Dispose() => Directory.Delete(root, true);
}
