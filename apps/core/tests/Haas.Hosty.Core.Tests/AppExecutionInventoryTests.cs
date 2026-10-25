using Haas.Hosty.Core;
using Haas.Hosty.Core.Tests.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task ExecutionInventory_ExplicitlySharedWorkspaceIsInspectableButRuntimeAuthorityStaysSeparate()
    {
        var (f, owner, workspaces, owned, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, owned);
        var foreignOwner = owner with { UserId = "another-operator", SessionId = "another-session" };
        var foreign = await workspaces.PrepareAsync(foreignOwner, new(Guid.NewGuid().ToString(), foreignOwner.SessionId,
            "test.created", "/assistant", "main", Name: "Another operator's work"), default);
        await File.WriteAllTextAsync(Path.Combine(foreign.Path, "manifest.json"),
            await File.ReadAllTextAsync(Path.Combine(owned.Path, "manifest.json")));
        var inspection = new WorkspaceInspectionService(workspaces, f.Apps, f.Clock);
        Assert.DoesNotContain((await inspection.ListAsync(owner.UserId, default)).Workspaces, w => w.Id == foreign.WorkspaceId);
        var membership = await workspaces.ParticipationAsync(foreign.WorkspaceId, foreignOwner.UserId, default);
        await workspaces.ChangeMemberAsync(foreign.WorkspaceId, foreignOwner.UserId, "grant",
            new(Guid.NewGuid().ToString(), membership.Revision, owner.UserId, [foreign.Id]), default);
        Assert.Contains((await inspection.ListAsync(owner.UserId, default)).Workspaces, w => w.Id == foreign.WorkspaceId);
        await using var host = await CoreHttpHarness.StartAsync(f.Clock);
        using var service = new AppExecutionTargetService(f.Paths, f.Apps, f.Service, workspaces, inspection,
            host.Services.GetRequiredService<WorkspaceActivationAccess>(), NullLogger<AppExecutionTargetService>.Instance);
        var choices = await service.ChoicesAsync("test.created", owner.UserId, default);
        Assert.Equal(owned.WorkspaceId, Assert.Single(choices.Choices, c => c.Kind == "workspace").WorkspaceId);
        var inventory = await service.InventoryAsync(owner.UserId, default);
        Assert.DoesNotContain(Assert.Single(inventory.Apps).Choices, c => c.WorkspaceId == foreign.WorkspaceId);
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, foreignOwner, "workspace", foreign), default);
        var starts = f.Adapter.StartCount;
        choices = await service.ChoicesAsync("test.created", owner.UserId, default);
        Assert.Equal("workspace", choices.Current.Kind);
        Assert.Equal(foreign.WorkspaceId, choices.Current.WorkspaceId);
        Assert.Equal(foreign.Id, choices.Current.WorktreeId);
        Assert.Equal("Another operator's work", choices.Current.Name);
        Assert.False(choices.Current.Available);
        Assert.DoesNotContain(choices.Choices, c => c.WorkspaceId == foreign.WorkspaceId);
        Assert.Equal(starts, f.Adapter.StartCount);
    }

    [Theory]
    [InlineData("oauth:")]
    [InlineData("manual:")]
    public async Task ExecutionInventory_DirectCredentialOnlyOffersItsOwnWorkspacesAndPreservesOtherCurrent(string prefix)
    {
        var (f, owner, workspaces, original, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, original);
        async Task<DevelopmentWorkspace> Prepare(string grant, string name)
        {
            var external = WorkspaceOwner.ForExternal(owner.UserId, prefix + grant, "execution-task", "Agent");
            var tree = await workspaces.PrepareAsync(external, new(Guid.NewGuid().ToString(), external.SessionId,
                "test.created", null, "main", LeaseId: Guid.NewGuid().ToString(), Name: name), default);
            await File.WriteAllTextAsync(Path.Combine(tree.Path, "manifest.json"),
                await File.ReadAllTextAsync(Path.Combine(original.Path, "manifest.json")));
            return tree;
        }
        var first = await Prepare("first", "First credential work");
        var second = await Prepare("second", "Second credential work");
        var inspection = new WorkspaceInspectionService(workspaces, f.Apps, f.Clock);
        await using var host = await CoreHttpHarness.StartAsync(f.Clock);
        using var service = new AppExecutionTargetService(f.Paths, f.Apps, f.Service, workspaces, inspection,
            host.Services.GetRequiredService<WorkspaceActivationAccess>(), NullLogger<AppExecutionTargetService>.Instance);
        var browserChoices = await service.ChoicesAsync("test.created", owner.UserId, default);
        Assert.Equal(3, browserChoices.Choices.Count(c => c.Kind == "workspace"));
        var choices = await service.ChoicesAsync("test.created", owner.UserId, default, prefix + "first");
        Assert.Equal(first.WorkspaceId, Assert.Single(choices.Choices, c => c.Kind == "workspace").WorkspaceId);
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, second.Owner, "workspace", second), default);
        choices = await service.ChoicesAsync("test.created", owner.UserId, default, prefix + "first");
        Assert.Equal(second.WorkspaceId, choices.Current.WorkspaceId);
        Assert.Equal("Second credential work", choices.Current.Name);
        Assert.False(choices.Current.Available);
        Assert.Equal(first.WorkspaceId, Assert.Single(choices.Choices, c => c.Kind == "workspace").WorkspaceId);
        Assert.Equal(3, (await inspection.ListAsync(owner.UserId, default)).Workspaces.Length);
    }
}
