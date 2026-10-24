using System.Diagnostics;
using System.Text.Json;
using Haas.Hosty.Cli.Commands;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class WorkspaceCoreLaunchContinuationTests : IDisposable
{
    private readonly string root = Directory.CreateTempSubdirectory("hosty-workspace-continuation-").FullName;
    private readonly string id = Guid.NewGuid().ToString("D");
    private readonly string project;
    private readonly CoreLaunchIdentity before;
    private readonly CoreLaunchIdentity baseline = new("release", null, null, 123, DateTimeOffset.UtcNow.AddDays(-2));
    public WorkspaceCoreLaunchContinuationTests()
    {
        project = Path.Combine(root, "core.csproj");
        File.WriteAllText(project, "project");
        var generation = Generation("old", "ready");
        before = new("dev", project, generation, 567, DateTimeOffset.UtcNow.AddDays(-1));
        WorkspaceRuntimeFiles.Save(root, new(id, "workspace", "user", "fingerprint", "instance", "revision", "tree", project,
            baseline, ["third.party"], "active", Executable(generation), generation, "snapshot", ActivatedCore: before,
            PreviousExecutable: "previous-release", CoreReserved: true, PreviousExecutableHash: "original-hash",
            CoreReturnTarget: new(baseline, "baseline-release", "baseline-hash"), ReplacesCoreActivationId: "earlier"));
    }
    private string Generation(string contents, string state)
    {
        var path = Path.Combine(root, "core", "builds", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        File.WriteAllText(Executable(path), contents);
        using var process = Process.GetCurrentProcess();
        CoreLaunchFiles.Write(Path.Combine(path, CoreBuildRetention.Marker), new CoreBuildGeneration(Path.GetFileName(path), state,
            DateTimeOffset.UtcNow, process.Id, process.StartTime.ToUniversalTime(), project), CoreLaunchJson.Default.CoreBuildGeneration);
        return path;
    }
    private static string Executable(string generation) => Path.Combine(generation, "hosty-core");
    private CoreLaunchIdentity Ready(string generation)
    {
        using var process = Process.GetCurrentProcess();
        var launch = new CoreLaunchIdentity("dev", project, generation, process.Id, process.StartTime.ToUniversalTime());
        CoreBuildRetention.Mark(generation, "ready", project, launch.ProcessId, launch.StartedAt);
        return launch;
    }

    [Fact]
    public void SameWorkspaceRebuild_PromotesOnlyReadyGenerationAndPreservesReturnAndAppOwnership()
    {
        var a = WorkspaceRuntimeFiles.Read(root, id);
        var generation = Generation("new", "prepared");
        var receipt = WorkspaceCoreLaunchContinuation.Prepare(root, Guid.NewGuid().ToString("N"), before, project, Executable(generation), generation)!;
        Assert.Equal(before, WorkspaceRuntimeFiles.Read(root, id).ActivatedCore);
        Assert.Equal([generation], WorkspaceCoreLaunchContinuation.PendingGenerations(root));
        var ready = Ready(generation);
        WorkspaceCoreLaunchContinuation.Reconcile(root, ready);
        var result = WorkspaceRuntimeFiles.Read(root, id);
        Assert.Equal(ready, result.ActivatedCore);
        Assert.Equal(generation, result.Generation);
        Assert.Equal(a.PreviousCore, result.PreviousCore);
        Assert.Equal(a.PreviousExecutable, result.PreviousExecutable);
        Assert.Equal(a.PreviousExecutableHash, result.PreviousExecutableHash);
        Assert.Equal(a.CoreReturnTarget, result.CoreReturnTarget);
        Assert.Equal(a.ReplacesCoreActivationId, result.ReplacesCoreActivationId);
        Assert.Equal(a.Apps, result.Apps);
        Assert.Equal(a.Snapshot, result.Snapshot);
        Assert.Empty(WorkspaceCoreLaunchContinuation.PendingGenerations(root));
        Assert.Equal("completed", WorkspaceCoreLaunchContinuation.List(root).Single().State);
        WorkspaceCoreLaunchContinuation.Reconcile(root, ready);
        Assert.Single(WorkspaceCoreLaunchContinuation.List(root));
    }

    [Fact]
    public void InterruptedBeforeStop_RecoversExactPreparedExecutableWithoutRebuilding()
    {
        var generation = Generation("prepared", "prepared");
        var receipt = WorkspaceCoreLaunchContinuation.Prepare(root, Guid.NewGuid().ToString("N"), before, project, Executable(generation), generation);
        Assert.Equal(receipt, WorkspaceCoreLaunchContinuation.RecoverTarget(root, project, before));
        Assert.Equal(before, WorkspaceRuntimeFiles.Read(root, id).ActivatedCore);
    }

    [Fact]
    public void InterruptedAfterStart_RecoversReadinessFromExactGenerationMarker()
    {
        var generation = Generation("prepared", "prepared");
        WorkspaceCoreLaunchContinuation.Prepare(root, Guid.NewGuid().ToString("N"), before, project, Executable(generation), generation);
        var ready = Ready(generation);
        Assert.Null(WorkspaceCoreLaunchContinuation.RecoverTarget(root, project, ready));
        Assert.Equal(ready, WorkspaceRuntimeFiles.Read(root, id).ActivatedCore);
    }

    [Fact]
    public void SameProjectWithoutReceipt_DoesNotClaimUnrelatedGenerationOrProcess()
    {
        var generation = Generation("unrelated", "prepared");
        var current = Ready(generation);
        WorkspaceCoreLaunchContinuation.Reconcile(root, current);
        Assert.Equal(before, WorkspaceRuntimeFiles.Read(root, id).ActivatedCore);
        Assert.Throws<InvalidOperationException>(() => WorkspaceCoreLaunchContinuation.Owner(root, current, project));
        Assert.Throws<InvalidOperationException>(() => WorkspaceCoreLaunchContinuation.Owner(root, before with { ProcessId = 999 }, project));
    }

    [Fact]
    public void DifferentProjectOrRelease_IsRefusedBeforeStoppingCurrentWorkspace()
    {
        Assert.Throws<InvalidOperationException>(() => WorkspaceCoreLaunchContinuation.Owner(root, before, null));
        Assert.Throws<InvalidOperationException>(() => WorkspaceCoreLaunchContinuation.Owner(root, before, "other-project"));
    }

    [Fact]
    public void ChangedExecutableOrReadyMarker_RefusesAdoption()
    {
        var generation = Generation("prepared", "prepared");
        WorkspaceCoreLaunchContinuation.Prepare(root, Guid.NewGuid().ToString("N"), before, project, Executable(generation), generation);
        var ready = Ready(generation);
        File.WriteAllText(Executable(generation), "changed executable");
        Assert.Throws<IOException>(() => WorkspaceCoreLaunchContinuation.Reconcile(root, ready));
        Assert.Equal(before, WorkspaceRuntimeFiles.Read(root, id).ActivatedCore);
        Assert.Throws<IOException>(() => WorkspaceCoreLaunchContinuation.RecoverTarget(root, project, before));
    }

    [Fact]
    public void ChangedActivationOwnership_RefusesPendingContinuation()
    {
        var generation = Generation("prepared", "prepared");
        WorkspaceCoreLaunchContinuation.Prepare(root, Guid.NewGuid().ToString("N"), before, project, Executable(generation), generation);
        var a = WorkspaceRuntimeFiles.Read(root, id);
        WorkspaceRuntimeFiles.Save(root, a with { CoreReturned = true, CoreSupersededBy = "replacement" });
        Assert.Throws<InvalidOperationException>(() => WorkspaceCoreLaunchContinuation.Reconcile(root, Ready(generation)));
        Assert.Equal(before, WorkspaceRuntimeFiles.Read(root, id).ActivatedCore);
    }

    [Fact]
    public void ExplicitAdoption_RecordsNewBoundaryAndPreservesOriginalReturnTarget()
    {
        var a = WorkspaceRuntimeFiles.Read(root, id);
        var generation = Generation("admin-reviewed", "prepared");
        var launch = Ready(generation);
        WorkspaceCoreLaunchContinuation.Adopt(root, Guid.NewGuid().ToString("N"), a, launch, Executable(generation));
        var result = WorkspaceRuntimeFiles.Read(root, id);
        Assert.Equal(launch, result.ActivatedCore);
        Assert.Equal(a.CoreReturnTarget, result.CoreReturnTarget);
        Assert.Equal(a.PreviousCore, result.PreviousCore);
        var receipt = WorkspaceCoreLaunchContinuation.List(root).Single();
        Assert.True(receipt.ExplicitAdoption);
        Assert.Equal(before, receipt.Before);
        Assert.Equal(launch, receipt.Ready);
    }

    [Fact]
    public void ExplicitAdoption_RequiresExactFactualInstanceGenerationAndRoot()
    {
        var generation = Generation("reviewed", "prepared");
        var launch = Ready(generation);
        var status = new CoreCommand.CoreStatusDocument("running", "hosty-core", root, "http://localhost:7070", 7070, null, null, [], launch);
        var instance = $"{launch.ProcessId}:{launch.StartedAt.UtcTicks}";
        Assert.Equal(launch, CoreCommand.RequireAdoptionInstance(status, root, instance, generation));
        Assert.Throws<InvalidOperationException>(() => CoreCommand.RequireAdoptionInstance(status, root, "wrong", generation));
        Assert.Throws<InvalidOperationException>(() => CoreCommand.RequireAdoptionInstance(status, root, instance, "other-generation"));
        Assert.Throws<InvalidOperationException>(() => CoreCommand.RequireAdoptionInstance(status, "other-root", instance, generation));
    }

    [Fact]
    public void AdministratorAdoption_RequiresActiveRegisteredWorkspaceAndSourceOwner()
    {
        var treeId = new string('a', 64);
        var tree = Path.Combine(root, "core", "development", "trees", treeId);
        Directory.CreateDirectory(tree);
        var source = new CoreSourceSettings(null, "revision", RepositoryUrl: "https://example.com/independent.git", ProjectPath: "platform/core.csproj");
        CoreLaunchFiles.Write(CoreLaunchFiles.SourcePath(root), source, CoreLaunchJson.Default.CoreSourceSettings);
        var selected = Path.Combine(tree, source.ProjectPath);
        var a = WorkspaceRuntimeFiles.Read(root, id) with { CoreWorktreeId = treeId, CoreProject = selected,
            Authority = new("user", "browser", Principal: "browser:reviewed") };
        var launch = before with { ProjectPath = selected };
        var registration = Path.Combine(root, "core", "development", "workspaces", treeId + ".json");
        Directory.CreateDirectory(Path.GetDirectoryName(registration)!);
        // A generic app-bound shared repository is eligible; it needs no special Core app flag.
        File.WriteAllText(registration, JsonSerializer.Serialize(new { id = treeId, workspaceId = "workspace", path = tree,
            owner = new { userId = "user" }, state = "active", repository = "https://example.com/independent", apps = new[] { new { appId = "third.party" } } }));
        CoreCommand.ValidateAdoptionBinding(root, a, launch);
        Assert.Throws<InvalidOperationException>(() => CoreCommand.ValidateAdoptionBinding(root, a with { UserId = "different-user" }, launch));
        Assert.Throws<InvalidOperationException>(() => CoreCommand.ValidateAdoptionBinding(root, a with { CoreSupersededBy = "new-owner" }, launch));
        CoreLaunchFiles.Write(CoreLaunchFiles.SourcePath(root), source with { ConnectionId = "private", ConnectionOwnerId = "other-user" }, CoreLaunchJson.Default.CoreSourceSettings);
        Assert.Throws<InvalidOperationException>(() => CoreCommand.ValidateAdoptionBinding(root, a, launch));
    }

    [Fact]
    public void UnreadyOrForeignGeneration_NeverPromotesWorkspaceOwnership()
    {
        var generation = Generation("prepared", "prepared");
        WorkspaceCoreLaunchContinuation.Prepare(root, Guid.NewGuid().ToString("N"), before, project, Executable(generation), generation);
        using var process = Process.GetCurrentProcess();
        var launch = new CoreLaunchIdentity("dev", project, generation, process.Id, process.StartTime.ToUniversalTime());
        Assert.Throws<IOException>(() => WorkspaceCoreLaunchContinuation.Reconcile(root, launch));
        Assert.Equal(before, WorkspaceRuntimeFiles.Read(root, id).ActivatedCore);
        Assert.Throws<IOException>(() => WorkspaceCoreLaunchContinuation.ValidateManaged(root, project, Executable(generation), Path.Combine(root, "outside")));
    }

    public void Dispose() => Directory.Delete(root, true);
}
