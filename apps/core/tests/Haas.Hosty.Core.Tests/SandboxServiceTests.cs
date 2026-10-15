using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class SandboxServiceTests
{
    [Fact]
    public async Task AdmissionCountsBrowserAndProbeMemoryBeyondTheAppReservation()
    {
        using var fixture = new Fixture(); var view = await fixture.Prepare();
        var instance = (await fixture.Store.ReadAsync(view.Id, default))!;
        instance = instance with { Resources = [new("container", "app", instance.Generation, "app", new('a', 64)),
            new("container", "relay", instance.Generation, "relay", new('b', 64)),
            new("container", "browser", instance.Generation, "browser-job", new('c', 64)),
            new("container", "probe", instance.Generation, "probe-disk", new('d', 64))] };
        Assert.True(SandboxDockerRuntime.CoveredByAppReservation([instance], new('a', 64)));
        Assert.True(SandboxDockerRuntime.CoveredByAppReservation([instance], new('b', 64)));
        Assert.False(SandboxDockerRuntime.CoveredByAppReservation([instance], new('c', 64)));
        Assert.False(SandboxDockerRuntime.CoveredByAppReservation([instance], new('d', 64)));
        Assert.False(SandboxDockerRuntime.CoveredByAppReservation([instance], new('e', 64)));
    }

    [Theory]
    [InlineData(false, false, false)]
    [InlineData(true, false, false)]
    [InlineData(true, true, true)]
    public async Task DockerCleanupRequiresRecordedEngineIdentityEvenWhenLabelsMatch(bool recorded, bool sameEngine, bool mayStop)
    {
        using var fixture = new Fixture(); var view = await fixture.Prepare();
        var instance = (await fixture.Store.ReadAsync(view.Id, default))!;
        var resource = new SandboxResource("container", "owned-container", instance.Generation, "app");
        if (recorded) instance = instance with { Resources = [resource with { EngineId = new('a', 64) }] };
        await fixture.Store.WriteAsync(instance, default);
        var inspect = System.Text.Json.JsonSerializer.Serialize(new[] { new {
            Id = new string(sameEngine ? 'a' : 'b', 64), State = new { Running = false },
            Config = new { Labels = new Dictionary<string, string> { ["hosty.instance"] = "test-core", ["hosty.sandbox"] = instance.Id,
                ["hosty.sandbox.generation"] = instance.Generation, ["hosty.app"] = instance.Input.AppId, ["hosty.sandbox.owner"] = instance.Owner.Key } }
        } });
        var runner = new InspectRunner(inspect);
        var config = new HostyCoreRuntimeConfig(fixture.Root, fixture.Root, "", 7070, "http://localhost:7070", null, "localhost", null, false, InstanceId: "test-core");
        var runtime = new SandboxDockerRuntime(runner, fixture.Store, config, null!);
        // Use the older intent snapshot to exercise durable identity lookup after a creation callback.
        var older = instance with { Resources = [resource] };
        if (mayStop) await runtime.StopAsync(older, default);
        else await Assert.ThrowsAsync<SandboxException>(() => runtime.StopAsync(older, default));
        Assert.Equal(mayStop ? 1 : 0, runner.Stops);
    }

    private sealed class InspectRunner(string inspection) : IDockerCommandRunner
    {
        public int Stops { get; private set; }
        public Task<DockerCommandResult> RunAsync(IReadOnlyList<string> args, IReadOnlyDictionary<string, string>? environment, CancellationToken cancellationToken)
        {
            if (args[0] == "stop") Stops++;
            return Task.FromResult(new DockerCommandResult(0, args[0] == "container" ? inspection : "", ""));
        }
    }

    [Fact]
    public async Task AcceptedLifecycleContinuesAfterObserverDisconnectAndReplaysItsJournal()
    {
        using var fixture = new Fixture(); var instance = await fixture.Prepare();
        fixture.Runtime.ResumeStart = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var operations = new SandboxOperations(fixture.Service, new TestLifetime());
        var input = new SandboxCommand(Guid.NewGuid().ToString(), instance.Revision);
        using var observer = new CancellationTokenSource();
        var pending = operations.CommandAsync(fixture.Actor, instance.Id, "start", input, observer.Token);
        await fixture.Runtime.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        observer.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
        fixture.Runtime.ResumeStart.SetResult();
        SandboxView result;
        do { result = await operations.CommandAsync(fixture.Actor, instance.Id, "start", input, default); }
        while (result.Operations.Single(o => o.Id == input.RequestId).State == "running");
        Assert.Equal("ready", result.State); Assert.Equal(1, fixture.Runtime.StartCount);
        Assert.Equal("succeeded", result.Operations.Single(o => o.Id == input.RequestId).State);
        await Assert.ThrowsAsync<SandboxException>(() => operations.CommandAsync(fixture.Actor, instance.Id, "stop", input, default));
    }

    [Theory]
    [InlineData("start")]
    [InlineData("restart")]
    public async Task RestartRemovesRetainedGenerationBeforeRuntimeAdmission(string command)
    {
        using var fixture = new Fixture();
        var ready = await fixture.Command(await fixture.Prepare(), "start");
        var previous = (await fixture.Store.ReadAsync(ready.Id, default))!;
        var stopped = await fixture.Command(ready, "stop");
        Assert.Equal("stopped", stopped.State);
        Assert.Equal(previous.Resources, (await fixture.Store.ReadAsync(ready.Id, default))!.Resources);
        fixture.Runtime.Calls.Clear();

        var restarted = await fixture.Command(stopped, command);

        Assert.Equal("ready", restarted.State);
        Assert.Equal(new[] { "stop", "remove", "start" }, fixture.Runtime.Calls.Select(c => c.Kind));
        var removed = fixture.Runtime.Calls[1].Instance;
        Assert.Equal(previous.Generation, removed.Generation);
        Assert.Equal(previous.Resources, removed.Resources);
        // Docker admission is inside runtime.StartAsync, so the retained containers have already
        // been removed when it inventories the child. Never exempt orphaned containers by label.
        var starting = fixture.Runtime.Calls[2].Instance;
        Assert.NotEqual(previous.Generation, starting.Generation);
        Assert.Empty(starting.Resources);
    }

    [Fact]
    public async Task FailedPreparationCanBeDisposedAndEmergencyRevocationSurvivesStoreRecreation()
    {
        using var fixture = new Fixture(); fixture.Inputs.FailAcquire = true;
        await Assert.ThrowsAsync<SandboxException>(() => fixture.Prepare());
        var instance = Assert.Single(await fixture.Store.ListAsync(default));
        Assert.Equal("unknown", instance.State); Assert.Equal("failed", instance.Operations.Single().State);
        await fixture.Store.RevokeEmergencyAsync(instance.Id, default);
        Assert.Throws<SandboxException>(() => fixture.Store.RequireNotRevoked(instance.Id));
        var disposed = await fixture.Service.CommandAsync(fixture.Actor, instance.Id, "dispose", new(Guid.NewGuid().ToString(), instance.Revision), default);
        Assert.Equal("disposed", disposed.State); Assert.False(Directory.Exists(fixture.Store.InstanceRoot(instance.Id)));
    }

    [Fact]
    public async Task EvidenceTracksSourceEditsAndDeletionsButNotIgnoredBuildCaches()
    {
        using var fixture = new Fixture(); var prepared = await fixture.Prepare();
        var root = Path.Combine(fixture.Root, "source"); Directory.CreateDirectory(root);
        await DevelopmentWorkspaceService.Git(root, ["init", "--quiet"], default);
        await File.WriteAllTextAsync(Path.Combine(root, ".gitignore"), "cache/\n");
        await File.WriteAllTextAsync(Path.Combine(root, "app.txt"), "one");
        await DevelopmentWorkspaceService.Git(root, ["add", "app.txt", ".gitignore"], default);
        var instance = (await fixture.Store.ReadAsync(prepared.Id, default))!;
        instance = instance with { Input = instance.Input with { SourceRoot = root } };
        var first = await SandboxEvidence.SourceRevisionAsync(instance, default);
        Directory.CreateDirectory(Path.Combine(root, "cache")); await File.WriteAllTextAsync(Path.Combine(root, "cache", "build"), "output");
        Assert.Equal(first, await SandboxEvidence.SourceRevisionAsync(instance, default));
        await File.WriteAllTextAsync(Path.Combine(root, "app.txt"), "two");
        var changed = await SandboxEvidence.SourceRevisionAsync(instance, default); Assert.NotEqual(first, changed);
        File.Delete(Path.Combine(root, "app.txt"));
        Assert.NotEqual(changed, await SandboxEvidence.SourceRevisionAsync(instance, default));
    }

    private sealed class TestLifetime : Microsoft.Extensions.Hosting.IHostApplicationLifetime
    {
        public CancellationToken ApplicationStarted => default;
        public CancellationToken ApplicationStopping => default;
        public CancellationToken ApplicationStopped => default;
        public void StopApplication() { }
    }

    [Theory]
    [InlineData("172.22.0.0/16", "172.22.0.2")]
    [InlineData("192.168.10.4/30", "192.168.10.6")]
    public void BrowserRelayUsesAReservedAddressInsideItsOwnNetwork(string subnet, string expected)
        => Assert.Equal(expected, SandboxDockerRuntime.BrowserRelayAddress(subnet));

    [Theory]
    [InlineData("::1/64")]
    [InlineData("172.22.0.1/16")]
    [InlineData("172.22.0.0/31")]
    public void BrowserRelayRejectsUnknownOrTooSmallAddressRanges(string subnet)
        => Assert.Throws<SandboxException>(() => SandboxDockerRuntime.BrowserRelayAddress(subnet));

    [Fact]
    public async Task InvalidResetPreservesRunningInstanceAndStorageDoesNotFollowLinks()
    {
        using var fixture = new Fixture();
        var view = await fixture.Command(await fixture.Prepare(), "start");
        await Assert.ThrowsAsync<SandboxException>(() => fixture.Service.CommandAsync(fixture.Actor, view.Id, "reset", new(Guid.NewGuid().ToString(), view.Revision), default));
        var retained = (await fixture.Store.ReadAsync(view.Id, default))!;
        Assert.Equal("ready", retained.State);
        Assert.False(retained.AccessRevoked);
        var outside = Path.Combine(fixture.Root, "outside"); Directory.CreateDirectory(outside);
        await File.WriteAllTextAsync(Path.Combine(outside, "large.txt"), new string('a', 10000));
        var data = fixture.Store.DataPath(view.Id, "data");
        Directory.CreateSymbolicLink(Path.Combine(data, "link"), outside);
        Assert.Equal(4096, SandboxSupervisor.Size(data));
        Assert.True(File.Exists(Path.Combine(outside, "large.txt")));
    }

    [Theory]
    [InlineData("evaluate")]
    [InlineData("cookies")]
    [InlineData("storageState")]
    [InlineData("upload")]
    public void BrowserActionsCannotRequestArbitraryCodeOrAuthenticationState(string kind)
        => Assert.Throws<SandboxException>(() => SandboxBrowser.Validate([new(kind)]));

    [Fact]
    public async Task ArtifactAllocationDoesNotCreateWorkspaceAndReplaysAcrossServiceRestart()
    {
        using var fixture = new Fixture();
        var plan = await fixture.Service.PlanAsync(fixture.Actor, fixture.Request, default);
        var request = new SandboxPrepareRequest(Guid.NewGuid().ToString(), plan.Id, plan.Digest);
        var results = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => fixture.Service.PrepareAsync(fixture.Actor, request, default)));
        Assert.Single(results.Select(r => r.Id).Distinct());
        Assert.All(results, r => { Assert.Null(r.Source.WorktreeId); Assert.Null(r.Context); Assert.Equal("prepared", r.State); });
        Assert.Equal(0, fixture.Inputs.Acquisitions);
        var restarted = fixture.NewService();
        var replay = await restarted.PrepareAsync(fixture.Actor, request, default);
        Assert.Equal(results[0].Id, replay.Id);
        Assert.Single((await restarted.ListAsync(fixture.Actor, default)).Instances);
        Assert.False(Directory.Exists(Path.Combine(fixture.Root, "core", "development")));
    }

    [Fact]
    public async Task LostAllocationIndexRecoversPersistedPreparationInsteadOfDuplicatingIt()
    {
        using var fixture = new Fixture();
        var plan = await fixture.Service.PlanAsync(fixture.Actor, fixture.Request, default);
        var request = new SandboxPrepareRequest(Guid.NewGuid().ToString(), plan.Id, plan.Digest);
        var first = await fixture.Service.PrepareAsync(fixture.Actor, request, default);
        File.Delete(fixture.Store.AllocationPath(fixture.Actor));
        var replay = await fixture.NewService().PrepareAsync(fixture.Actor, request, default);
        Assert.Equal(first.Id, replay.Id);
        Assert.Single((await fixture.Store.ListAsync(default)));
        var conflict = await Assert.ThrowsAsync<SandboxException>(() => fixture.Service.PrepareAsync(fixture.Actor,
            request with { Digest = "different" }, default));
        Assert.Equal("sandbox_replay_conflict", conflict.Code);
    }

    [Fact]
    public async Task CallerAndBackgroundGrantOwnershipIsNotDerivedFromContext()
    {
        using var fixture = new Fixture();
        var created = await fixture.Prepare();
        var otherApp = fixture.Actor with { AppId = "other.qa" };
        Assert.Empty((await fixture.Service.ListAsync(otherApp, default)).Instances);
        Assert.Equal(403, (await Assert.ThrowsAsync<SandboxException>(() => fixture.Service.ReadAsync(otherApp, created.Id, default))).Status);
        var background = fixture.Actor with { GrantId = "grant-b", ScopeId = "scope-b" };
        Assert.Empty((await fixture.Service.ListAsync(background, default)).Instances);
        var operatorView = await fixture.Service.ReadAsync(new(fixture.Actor.UserId), created.Id, default);
        Assert.Equal(created.Id, operatorView.Id);
    }

    [Fact]
    public async Task ChangedInputsOrUnapprovedRecipesCannotBePrepared()
    {
        using var fixture = new Fixture();
        fixture.Inputs.Reviewed = false;
        var plan = await fixture.Service.PlanAsync(fixture.Actor, fixture.Request, default);
        var request = new SandboxPrepareRequest(Guid.NewGuid().ToString(), plan.Id, plan.Digest);
        Assert.Equal("sandbox_plan_unapproved", (await Assert.ThrowsAsync<SandboxException>(() => fixture.Service.PrepareAsync(fixture.Actor, request, default))).Code);
        await Assert.ThrowsAsync<SandboxException>(() => fixture.Service.ApproveAsync(plan.Id, plan.Digest, fixture.Actor, default));
        await fixture.Service.ApproveAsync(plan.Id, plan.Digest, new(fixture.Actor.UserId), default);
        fixture.Inputs.Digest = new('b', 64);
        Assert.Equal("sandbox_input_changed", (await Assert.ThrowsAsync<SandboxException>(() => fixture.Service.PrepareAsync(fixture.Actor, request, default))).Code);
        Assert.Empty(await fixture.Store.ListAsync(default));
    }

    [Fact]
    public async Task WorktreeLeaseSurvivesStopAndIsReleasedOnlyOnVerifiedDisposal()
    {
        using var fixture = new Fixture();
        var instance = await fixture.Prepare(fixture.Request with { Source = new("worktree", "registered-tree"), Context = new("workspace", "session") });
        Assert.Equal(1, fixture.Inputs.Acquisitions);
        instance = await fixture.Command(instance, "start");
        instance = await fixture.Command(instance, "stop");
        Assert.Equal("stopped", instance.State);
        Assert.Equal(0, fixture.Inputs.Releases);
        instance = await fixture.Command(instance, "dispose");
        Assert.Equal("disposed", instance.State);
        Assert.Equal(1, fixture.Inputs.Releases);
    }

    [Fact]
    public async Task ResetRecreatesSyntheticRealmAndExpandsFixtureReferences()
    {
        using var fixture = new Fixture();
        var instance = await fixture.Prepare();
        instance = await fixture.Service.UserAsync(fixture.Actor, instance.Id,
            new(Guid.NewGuid().ToString(), instance.Revision, "admin", "Temporary admin", "admin"), default);
        var originalUser = instance.Users.Single().Id;
        var seedId = Guid.NewGuid();
        instance = await fixture.Service.SeedAsync(fixture.Actor, instance.Id,
            new(seedId.ToString(), instance.Revision, [new("test.json", "{\"owner\":\"{{sandbox.user.admin}}\"}")]), default);
        instance = await fixture.Service.CommandAsync(fixture.Actor, instance.Id, "reset",
            new(Guid.NewGuid().ToString(), instance.Revision, seedId.ToString("N")), default);
        Assert.Equal("stopped", instance.State);
        var restored = instance.Users.Single();
        Assert.NotEqual(originalUser, restored.Id);
        var data = await File.ReadAllTextAsync(Path.Combine(fixture.Store.DataPath(instance.Id, "data"), "test.json"));
        Assert.Contains(restored.Id, data);
        Assert.DoesNotContain(originalUser, data);
        instance = await fixture.Command(instance, "start");
        instance = await fixture.Command(instance, "stop");
        Assert.Equal(restored.Id, instance.Users.Single().Id);
    }

    [Theory]
    [InlineData("../outside")]
    [InlineData("/tmp/outside")]
    [InlineData("nested/../../outside")]
    [InlineData("nested\\outside")]
    public async Task SeedPathsCannotEscapeTheSelectedInstance(string path)
    {
        using var fixture = new Fixture();
        var instance = await fixture.Prepare();
        var ex = await Assert.ThrowsAsync<SandboxException>(() => fixture.Service.SeedAsync(fixture.Actor, instance.Id,
            new(Guid.NewGuid().ToString(), instance.Revision, [new(path, "synthetic")]), default));
        Assert.Equal("sandbox_seed_path_invalid", ex.Code);
        Assert.Empty(Directory.EnumerateFileSystemEntries(fixture.Store.DataPath(instance.Id, "data")));
    }

    [Fact]
    public async Task PartialStartKeepsResourceJournalAndDisposalFailureRemainsRevokedAndRetryable()
    {
        using var fixture = new Fixture();
        var instance = await fixture.Prepare();
        instance = await fixture.Service.UserAsync(fixture.Actor, instance.Id,
            new(Guid.NewGuid().ToString(), instance.Revision, "admin", "Discard this user", "admin"), default);
        fixture.Runtime.FailStart = true;
        await Assert.ThrowsAsync<SandboxException>(() => fixture.Command(instance, "start"));
        var stored = (await fixture.Store.ReadAsync(instance.Id, default))!;
        Assert.Single(stored.Resources);
        Assert.True(stored.AccessRevoked);
        Assert.Equal("failed", stored.Operations.Last().State);
        fixture.Runtime.FailStop = true;
        var dispose = new SandboxCommand(Guid.NewGuid().ToString(), stored.Revision);
        await Assert.ThrowsAsync<SandboxException>(() => fixture.Service.CommandAsync(fixture.Actor, instance.Id, "dispose", dispose, default));
        stored = (await fixture.Store.ReadAsync(instance.Id, default))!;
        Assert.Equal("disposing", stored.State);
        Assert.True(stored.AccessRevoked);
        Assert.Empty(stored.Users);
        Assert.True(Directory.Exists(fixture.Store.DataRoot(instance.Id)));
        fixture.Runtime.FailStop = false;
        var done = await fixture.NewService().CommandAsync(fixture.Actor, instance.Id, "dispose", dispose, default);
        Assert.Equal("disposed", done.State);
        Assert.False(Directory.Exists(fixture.Store.DataRoot(instance.Id)));
        Assert.False(Directory.Exists(fixture.Store.InstanceRoot(instance.Id)));
        Assert.DoesNotContain("Discard this user", await File.ReadAllTextAsync(fixture.Store.ReceiptPath(instance.Id)));
        Assert.Equal("disposed", (await fixture.NewService().CommandAsync(fixture.Actor, instance.Id, "dispose", dispose, default)).State);
    }

    [Fact]
    public async Task StaleRevisionsAndUndeclaredRolesAreRejectedWithoutWideningAuthority()
    {
        using var fixture = new Fixture();
        var instance = await fixture.Prepare();
        Assert.Equal("sandbox_revision_stale", (await Assert.ThrowsAsync<SandboxException>(() => fixture.Service.UserAsync(fixture.Actor,
            instance.Id, new(Guid.NewGuid().ToString(), 0, "bad", "No", "admin"), default))).Code);
        Assert.Equal("sandbox_role_unsupported", (await Assert.ThrowsAsync<SandboxException>(() => fixture.Service.UserAsync(fixture.Actor,
            instance.Id, new(Guid.NewGuid().ToString(), instance.Revision, "bad", "No", "core.admin", ["*"]), default))).Code);
        Assert.Empty((await fixture.Service.ReadAsync(fixture.Actor, instance.Id, default)).Users);
    }

    [Fact]
    public async Task SlowRuntimeObservationDoesNotBlockRealmGateOrOverwriteConcurrentLifecycle()
    {
        using var fixture = new Fixture(); var view = await fixture.Prepare();
        var instance = (await fixture.Store.ReadAsync(view.Id, default))!;
        await fixture.Store.WriteAsync(instance with { State = "unknown" }, default);
        fixture.Runtime.ResumeObserve = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var browser = new SandboxBrowser(fixture.Store, fixture.Service, null!, null!, new Clock());
        var supervisor = new SandboxSupervisor(fixture.Store, fixture.Runtime, null!, browser, new Clock(),
            Microsoft.Extensions.Logging.Abstractions.NullLogger<SandboxSupervisor>.Instance);
        var pending = supervisor.ObserveAsync(view.Id, default);
        await fixture.Runtime.Observing.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var gate = fixture.Store.Gate(view.Id);
        Assert.True(await gate.WaitAsync(TimeSpan.FromSeconds(1)));
        try { await fixture.Store.WriteAsync(instance with { State = "stopped", Revision = instance.Revision + 1 }, default); }
        finally { gate.Release(); }
        fixture.Runtime.ResumeObserve.SetResult(); await pending;
        Assert.Equal("stopped", (await fixture.Store.ReadAsync(view.Id, default))!.State);
    }

    [Fact]
    public void RuntimeAdoptionChecksConfigurationButIgnoresLiveCountersAndNetworkMembers()
    {
        static System.Text.Json.JsonElement Json(string input) => System.Text.Json.JsonDocument.Parse(input).RootElement.Clone();
        var original = Json("""{"Image":"sha256:pinned","Config":{"Env":["PRIVATE=secret"],"User":"1000"},"HostConfig":{"Memory":4096,"ReadonlyRootfs":true,"OomKillDisable":null},"Mounts":[],"NetworkSettings":{"Networks":{"inner":{"NetworkID":"network-id","IPAddress":"172.20.0.2"}}},"State":{"Running":true}}""");
        var resource = new SandboxResource("container", "owned", "generation", ConfigurationDigest: SandboxDockerRuntime.ConfigurationDigest("container", original));
        SandboxDockerRuntime.RequireConfiguration(resource, original);
        var moved = Json(original.GetRawText().Replace("172.20.0.2", "172.20.0.3")
            .Replace("null", "false"));
        SandboxDockerRuntime.RequireConfiguration(resource, moved);
        var changed = Json(original.GetRawText().Replace("4096", "8192"));
        Assert.Equal("sandbox_configuration_changed", Assert.Throws<SandboxException>(() => SandboxDockerRuntime.RequireConfiguration(resource, changed)).Code);
        Assert.Throws<SandboxException>(() => SandboxDockerRuntime.RequireConfiguration(resource with { ConfigurationDigest = null }, original));
        Assert.DoesNotContain("secret", resource.ConfigurationDigest!);
    }

    [Fact]
    public async Task MetadataCapacityRefusesNewAllocationsButRetainsReplayAndDisposal()
    {
        using var fixture = new Fixture(); var plan = await fixture.Service.PlanAsync(fixture.Actor, fixture.Request, default);
        var request = new SandboxPrepareRequest(Guid.NewGuid().ToString(), plan.Id, plan.Digest);
        var instance = await fixture.Service.PrepareAsync(fixture.Actor, request, default);
        var path = fixture.Store.AllocationPath(fixture.Actor);
        var state = (await JsonStorage.ReadAsync<SandboxAllocationState>(path, default))!;
        await JsonStorage.WriteAsync(path, new SandboxAllocationState(state.Allocations.Concat(Enumerable.Range(1, 4095)
            .Select(n => new SandboxAllocation(n.ToString(), "unused", "unused"))).ToArray()), true, default);
        Assert.Equal(instance.Id, (await fixture.Service.PrepareAsync(fixture.Actor, request, default)).Id);
        Assert.Equal("sandbox_metadata_quota", (await Assert.ThrowsAsync<SandboxException>(() => fixture.Service.PrepareAsync(fixture.Actor,
            request with { RequestId = Guid.NewGuid().ToString() }, default))).Code);
        Assert.Equal("disposed", (await fixture.Command(instance, "dispose")).State);
    }

    private sealed class Clock : IClock { public DateTimeOffset UtcNow => new(2026, 10, 13, 0, 0, 0, TimeSpan.Zero); }
    [Fact]
    public async Task Plan_ManagedChildDefaultsLeaveRoomForRelayAndBrowser_ExplicitLimitsArePreserved()
    {
        using var f = new Fixture();
        var config = new HostyCoreRuntimeConfig(f.Root, f.Root, "", 7070, "http://localhost:7070", null, "localhost", null, false);
        var parent = new CoreEnvironmentStore(CoreDataPaths.FromConfig(config));
        var id = Guid.NewGuid().ToString("N");
        Directory.CreateDirectory(Path.Combine(parent.Root(id), "core"));
        File.WriteAllText(CoreInstanceId.BuildPath(parent.Root(id)), id);
        await parent.WriteAsync(new(id, f.Actor, new(Guid.NewGuid().ToString(), "QA"), "hash", 7071, 1, "running", DateTimeOffset.UtcNow), default);
        var childConfig = config with { DataRoot = parent.Root(id), InstanceId = id };
        var service = new SandboxService(new(CoreDataPaths.FromConfig(childConfig)), f.Inputs, f.Runtime, new Clock(), config: childConfig);
        var plan = await service.PlanAsync(f.Actor, f.Request, default);
        var limits = plan.Request.Limits!;
        Assert.Equal(2147483648, limits.MemoryBytes); Assert.Equal(.5, limits.Cpus); Assert.Equal(128, limits.Pids);
        var child = new CoreEnvironmentLimits();
        Assert.True(limits.MemoryBytes + 335544320 + 1677721600 <= child.MemoryBytes);
        Assert.True(limits.Cpus + .35 + 1.1 <= child.Cpus);
        Assert.True(limits.Pids + 80 + 272 <= child.Pids);
        var prepared = await service.PrepareAsync(f.Actor, new(Guid.NewGuid().ToString(), plan.Id, plan.Digest), default);
        Assert.Equal(limits, prepared.Limits);
        var explicitLimits = new SandboxLimits();
        Assert.Equal(explicitLimits, (await service.PlanAsync(f.Actor, f.Request with { Limits = explicitLimits }, default)).Request.Limits);
        Assert.Equal(explicitLimits, (await f.Service.PlanAsync(f.Actor, f.Request, default)).Request.Limits);
    }

    private sealed class Fixture : IDisposable
    {
        public string Root { get; } = Path.Combine(Path.GetTempPath(), "hosty-sandbox-test-" + Guid.NewGuid().ToString("N"));
        public SandboxActor Actor { get; } = new("operator", "qa.app", DateTimeOffset.UnixEpoch);
        public SandboxPlanRequest Request { get; } = new("demo.app", "sandbox", new("appArtifact"));
        public FakeInputs Inputs { get; } = new();
        public FakeRuntime Runtime { get; } = new();
        public SandboxStore Store { get; }
        public SandboxService Service { get; }
        public Fixture()
        {
            Directory.CreateDirectory(Root);
            Store = new(new(Root, Path.Combine(Root, "core"), Path.Combine(Root, "apps"), Path.Combine(Root, "backups"),
                Path.Combine(Root, "sources"), Path.Combine(Root, "core", "auth"), Path.Combine(Root, "audit.ndjson")));
            Service = NewService();
        }
        public SandboxService NewService() => new(Store, Inputs, Runtime, new Clock());
        public async Task<SandboxView> Prepare(SandboxPlanRequest? request = null)
        {
            var plan = await Service.PlanAsync(Actor, request ?? Request, default);
            return await Service.PrepareAsync(Actor, new(Guid.NewGuid().ToString(), plan.Id, plan.Digest), default);
        }
        public Task<SandboxView> Command(SandboxView instance, string kind) => Service.CommandAsync(Actor, instance.Id, kind,
            new(Guid.NewGuid().ToString(), instance.Revision), default);
        public void Dispose() { if (Directory.Exists(Root)) Directory.Delete(Root, true); }
    }
    private sealed class FakeInputs : ISandboxInputs
    {
        public string Digest { get; set; } = new('a', 64);
        public bool Reviewed { get; set; } = true;
        public bool FailAcquire { get; set; }
        public int Acquisitions { get; private set; }
        public int Releases { get; private set; }
        public Task<SandboxResolvedInput> ResolveAsync(SandboxActor actor, SandboxPlanRequest request, CancellationToken ct)
            => Task.FromResult(new SandboxResolvedInput(request.AppId, DateTimeOffset.UnixEpoch, Digest,
                new(new RuntimeAppManifest { Id = request.AppId }, "/reviewed/manifest.json", Digest,
                    new() { Key = request.Profile, Type = "docker" }, [], null, "{}", null),
                request.Source.Kind == "worktree" ? "/registered/source" : null,
                ["admin", "member"], [], new Dictionary<string, string>(), Reviewed));
        public Task AcquireAsync(SandboxInstance instance, CancellationToken ct) { if (FailAcquire) throw new SandboxException("test_acquire_failed", "Test failure"); if (instance.SourceLeaseId is not null) Acquisitions++; return Task.CompletedTask; }
        public Task ReleaseAsync(SandboxInstance instance, CancellationToken ct) { if (instance.SourceLeaseId is not null) Releases++; return Task.CompletedTask; }
    }
    private sealed class FakeRuntime : ISandboxRuntime
    {
        public List<(string Kind, SandboxInstance Instance)> Calls { get; } = [];
        public bool FailStart { get; set; }
        public int StartCount { get; private set; }
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource? ResumeStart { get; set; }
        public bool FailStop { get; set; }
        public TaskCompletionSource Observing { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource? ResumeObserve { get; set; }
        public async Task<SandboxRuntimeStart> StartAsync(SandboxInstance instance, Func<SandboxResource, Task> record, CancellationToken ct)
        {
            Calls.Add(("start", instance));
            StartCount++;
            await record(new("container", "owned-test-container", instance.Generation));
            Started.TrySetResult();
            if (ResumeStart is not null) await ResumeStart.Task.WaitAsync(ct);
            if (FailStart) throw new SandboxException("sandbox_start_failed", "Simulated interrupted start.");
            return new("http://sandbox.hosty.localhost:19000", "http://auth.sandbox.hosty.localhost:19000", []);
        }
        public Task StopAsync(SandboxInstance instance, CancellationToken ct)
        {
            Calls.Add(("stop", instance));
            return FailStop ? Task.FromException(new SandboxException("sandbox_stop_failed", "Simulated unavailable daemon.")) : Task.CompletedTask;
        }
        public Task RemoveAsync(SandboxInstance instance, CancellationToken ct)
        {
            Calls.Add(("remove", instance));
            return Task.CompletedTask;
        }
        public async Task<string> ObserveAsync(SandboxInstance instance, CancellationToken ct)
        {
            Observing.TrySetResult();
            if (ResumeObserve is not null) await ResumeObserve.Task.WaitAsync(ct);
            return instance.State;
        }
    }
}
