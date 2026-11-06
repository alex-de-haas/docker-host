using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task WorkspaceInventory_ReusesRecordsButSeesOutOfBandOwnershipAndNameChanges()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var inspect = new WorkspaceInspectionService(service, f.Apps, f.Clock);
        await inspect.ListAsync("admin", default);
        var before = service.RecordCacheStatistics;
        await inspect.ListAsync("admin", default);
        if (OperatingSystem.IsLinux() || OperatingSystem.IsMacOS()) Assert.True(service.RecordCacheStatistics.Hits > before.Hits);
        await service.RenameAsync(owner, new(Guid.NewGuid().ToString(), "Updated name"), default);
        Assert.Equal("Updated name", Assert.Single((await inspect.ListAsync("admin", default)).Workspaces).Name);
        var record = Path.Combine(f.Paths.CoreRoot, "development", "workspaces", tree.Id + ".json");
        await JsonStorage.WriteAsync(record, tree with { Owner = tree.Owner with { UserId = "different-owner" } });
        Assert.Empty((await inspect.ListAsync("admin", default)).Workspaces);
        File.Delete(record);
        Assert.Empty((await service.ListAsync(null, true, default)).Workspaces);
    }

    [Fact]
    public async Task WorkspaceInventory_PublicationWritesInvalidateDetailsWithoutSchedulingSourceObservation()
    {
        var (f, _) = await SourceFixtureAsync();
        var state = new WorkspaceObservationState(new CoreEventHub());
        var workspaces = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, observationState: state);
        var tree = await workspaces.PrepareAsync(WorkspaceTestOwner(f), WorkspaceRequest(), default);
        var inspect = new WorkspaceInspectionService(workspaces, f.Apps, f.Clock, observationState: state);
        state.SetHealth(tree.Id, "watching"); state.Observed(tree.Id, state.Generation(tree.Id));
        async Task<InspectedWorktree> Inventory() => Assert.Single(Assert.Single((await inspect.ListAsync("admin", default)).Workspaces).Worktrees);
        var before = await Inventory();
        var generation = state.Generation(tree.Id);
        var scans = state.ScanCount(tree.Id);
        var written = false;
        Assert.True(await workspaces.WritePublicationAsync(tree.Id, () => { written = true; return Task.CompletedTask; }, default));
        Assert.True(written);
        var after = await Inventory();
        Assert.NotEqual(before.ObservationRevision, after.ObservationRevision);
        Assert.Equal(after.ObservationRevision, (await Inventory()).ObservationRevision);
        Assert.Equal(CoreJson.Text(before.Observation), CoreJson.Text(after.Observation));
        Assert.Equal(generation, state.Generation(tree.Id));
        Assert.Equal(scans, state.ScanCount(tree.Id));
        Assert.False(state.NeedsObservation(tree.Id));
    }

    [Fact]
    public async Task SourceDocuments_WorkspaceInventoryReusesSettledObservationsAndRefreshesEdits()
    {
        var (f, origin, _, _) = await DocumentFixtureAsync();
        await File.WriteAllTextAsync(Path.Combine(origin, ".gitignore"), "docs/ignored.md\n");
        await RunGitAsync(origin, ["add", ".gitignore"]); await CommitDocsAsync(origin);
        var state = new WorkspaceObservationState(new CoreEventHub());
        var workspaces = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, observationState: state);
        var documents = new SourceDocumentService(f.Apps, workspaces);
        var tree = await workspaces.PrepareAsync(WorkspaceTestOwner(f), WorkspaceRequest(), default);
        var entry = Assert.Single((await documents.ListRepositoriesAsync("admin", default)).Repositories);
        await documents.ListDocumentsAsync(entry.Id, "admin", false, default);
        using var observer = new DevelopmentWorkspaceObserver(workspaces, state, f.Paths, NullLogger<DevelopmentWorkspaceObserver>.Instance);
        await observer.StartAsync(default);
        try
        {
            await WaitForObservation(() => Task.FromResult(state.Health(tree.Id) == "watching" && !state.NeedsObservation(tree.Id)));
            var first = Assert.Single((await documents.ListWorkspacesAsync("admin", entry.Id, default)).Workspaces);
            Assert.Null(first.Error);
            var loads = documents.WorkspaceInventoryLoads;
            var snapshots = await Task.WhenAll(Enumerable.Range(0, 6).Select(_ => documents.ListWorkspacesAsync("admin", entry.Id, default)));
            Assert.All(snapshots, value => Assert.Equal(first.Changes, Assert.Single(value.Workspaces).Changes));
            Assert.Equal(loads, documents.WorkspaceInventoryLoads);
            Assert.Single((await documents.ListWorkspacesAsync("another-user", entry.Id, default)).Workspaces);
            await File.WriteAllTextAsync(Path.Combine(tree.Path, PlanPath), PlanText.Replace("Ready", "Draft"));
            await WaitForObservation(async () => (await workspaces.Read(tree.Id, null, default)).Observation!.Local!.Files.Any(file => file.Path == PlanPath)
                && state.Health(tree.Id) == "watching" && !state.NeedsObservation(tree.Id));
            var changed = Assert.Single((await documents.ListWorkspacesAsync("admin", entry.Id, default)).Workspaces);
            Assert.Contains(changed.Changes!, change => change.Path == PlanPath && change.Kind == "modified");
            Assert.True(documents.WorkspaceInventoryLoads > loads);
            // A target ref change must invalidate the comparison even if local source stays unchanged.
            var priorTarget = changed.TargetCommit;
            await File.WriteAllTextAsync(Path.Combine(origin, PlanPath), PlanText.Replace("Ready", "Draft"));
            await CommitDocsAsync(origin);
            await documents.ListDocumentsAsync(entry.Id, "admin", true, default);
            var advanced = Assert.Single((await documents.ListWorkspacesAsync("admin", entry.Id, default)).Workspaces);
            Assert.NotEqual(priorTarget, advanced.TargetCommit);
            Assert.DoesNotContain(advanced.Changes!, change => change.Path == PlanPath);
            var documentGeneration = state.DocumentGeneration(tree.Id);
            var ignored = Path.Combine(tree.Path, "docs", "ignored.md");
            await File.WriteAllTextAsync(ignored, "# Untracked document ignored by Git\n");
            await WaitForObservation(() => Task.FromResult(state.DocumentGeneration(tree.Id) > documentGeneration));
            var withIgnored = Assert.Single((await documents.ListWorkspacesAsync("admin", entry.Id, default)).Workspaces);
            Assert.Contains(withIgnored.Changes!, change => change.Path == "docs/ignored.md" && change.Kind == "added");
            documentGeneration = state.DocumentGeneration(tree.Id);
            File.Delete(ignored);
            await WaitForObservation(() => Task.FromResult(state.DocumentGeneration(tree.Id) > documentGeneration));
            var removed = Assert.Single((await documents.ListWorkspacesAsync("admin", entry.Id, default)).Workspaces);
            Assert.DoesNotContain(removed.Changes!, change => change.Path == "docs/ignored.md");
            await observer.StopAsync(default);
            state.SetHealth(tree.Id, "paused");
            loads = documents.WorkspaceInventoryLoads;
            await documents.ListWorkspacesAsync("admin", entry.Id, default);
            await documents.ListWorkspacesAsync("admin", entry.Id, default);
            Assert.Equal(loads + 2, documents.WorkspaceInventoryLoads);
        }
        finally { await observer.StopAsync(default); }
    }
}
