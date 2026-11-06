using Haas.Hosty.Core;
using Haas.Hosty.Launch;
using Haas.Hosty.Core.Tests.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData("revoked")]
    [InlineData("missing")]
    public async Task ExecutionTargets_GroupPackageReturnNeedsCurrentAuthorityButNotReadableSource(string failure)
    {
        var (f, _, initialWorkspaces, initialTree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, initialTree);
        const string credential = "group-return-owner";
        var principal = "manual:" + DevelopmentWorkspaceService.Hash(credential);
        var owner = WorkspaceOwner.ForExternal("admin", principal, "group-return", "Agent");
        var tree = await initialWorkspaces.PrepareAsync(owner,
            new(Guid.NewGuid().ToString(), owner.SessionId, "test.created", null, "main", LeaseId: Guid.NewGuid().ToString(), Name: "Group Return"), default);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "manifest.json"),
            await File.ReadAllTextAsync(Path.Combine(initialTree.Path, "manifest.json")));
        await f.Service.StartAsync("test.created");
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", tree), default);
        var data = Path.Combine(f.Paths.AppsRoot, "test.created", "data", "sentinel");
        await File.WriteAllTextAsync(data, "ordinary workspace data");

        var (sourceUsers, sourceAccess, grant) = await PrivateDocumentAccessAsync(f, tree.Repository);
        await f.Apps.UpdateAppAsync("test.created", app => app with { PrivateSources = new(Git: grant) });
        await JsonStorage.WriteAsync(Path.Combine(f.Paths.CoreRoot, "development/workspaces", tree.Id + ".json"),
            tree with { SourceGrant = grant });
        var workspaces = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, privateSources: sourceAccess);
        var inspection = new WorkspaceInspectionService(workspaces, f.Apps, f.Clock, privateSources: sourceAccess);
        if (failure == "revoked") await sourceUsers.UpdateAsync(state => state with { ProviderConnections = [] });
        else Directory.Move(tree.Path, tree.Path + "-unavailable");

        await using var host = await CoreHttpHarness.StartAsync(f.Clock);
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var now = f.Clock.UtcNow;
        var scopes = new[] { AccessTokenScopes.McpRead, AccessTokenScopes.McpWorkspaces, AccessTokenScopes.McpLifecycle };
        await users.WriteAsync(new(1,
            [new("admin", "admin@example.test", "Admin", "host.admin", false, now, now),
             new("bob", "bob@example.test", "Bob", "host.admin", false, now, now)], [], [],
            [new(credential, "admin", now, now.AddHours(8), null, now, Kind: AccessTokenKinds.Manual,
                Audience: AccessTokenScopes.CoreAudience, Scopes: scopes),
             new("group-return-other", "admin", now, now.AddHours(8), null, now, Kind: AccessTokenKinds.Manual,
                Audience: AccessTokenScopes.CoreAudience, Scopes: scopes),
             new("group-return-foreign", "bob", now, now.AddHours(8), null, now, Kind: AccessTokenKinds.Manual,
                Audience: AccessTokenScopes.CoreAudience, Scopes: scopes)]));
        var actor = new WorkspaceActivationActor("admin", "direct-mcp", Principal: principal);
        using var worker = new AppExecutionTargetService(f.Paths, f.Apps, f.RecreateService(privateSources: sourceAccess),
            workspaces, inspection, host.Services.GetRequiredService<WorkspaceActivationAccess>(),
            NullLogger<AppExecutionTargetService>.Instance);
        var request = new AppExecutionTargetRequest(Guid.NewGuid().ToString("D"), "package");
        Assert.Equal(tree.Owner, await inspection.WorkflowOwnerAsync(tree.WorkspaceId, actor.UserId, default));

        await worker.StartAsync(default);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        try
        {
            await worker.SubmitWorkspaceAsync(tree.WorkspaceId, request, actor, timeout.Token);
            WorkspaceExecutionStatus status;
            do
            {
                status = await worker.WorkspaceStatusAsync(tree.WorkspaceId, request.RequestId, "admin", timeout.Token);
                if (status.State == "running") await Task.Delay(20, timeout.Token);
            } while (status.State == "running");
            Assert.Equal("completed", status.State);
            Assert.Equal("completed", Assert.Single(status.Apps).State);
            Assert.Equal("docker", (await f.Apps.GetAppAsync("test.created"))!.SelectedRuntime);
            Assert.Equal("ordinary workspace data", await File.ReadAllTextAsync(data));
            var starts = f.Adapter.StartCount;
            var stops = f.Adapter.StopCount;
            await Assert.ThrowsAsync<AppLifecycleException>(() => worker.SubmitWorkspaceAsync(tree.WorkspaceId, request,
                actor with { UserId = "bob", Principal = "manual:" + DevelopmentWorkspaceService.Hash("group-return-foreign") }, default));
            Assert.Equal("execution_request_conflict", (await Assert.ThrowsAsync<AppLifecycleException>(() => worker.SubmitWorkspaceAsync(tree.WorkspaceId, request,
                actor with { Principal = "manual:" + DevelopmentWorkspaceService.Hash("group-return-other") }, default))).Code);
            Assert.Equal(stops, f.Adapter.StopCount);
            Assert.Equal("completed", (await worker.SubmitWorkspaceAsync(tree.WorkspaceId, request, actor, timeout.Token)).State);
            Assert.Equal(starts, f.Adapter.StartCount);
            Assert.Equal(stops, f.Adapter.StopCount);
        }
        finally { await worker.StopAsync(CancellationToken.None); }
    }
}
