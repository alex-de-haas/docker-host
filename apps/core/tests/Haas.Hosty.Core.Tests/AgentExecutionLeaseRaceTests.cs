using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Haas.Hosty.Core;
using Haas.Hosty.Core.Tests.Http;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData("direct")]
    [InlineData("mcp-prepare")]
    [InlineData("mcp-lease")]
    public async Task AgentLeaseCleanupWaitsForActualAcquisitionAndNeverLeavesAWriter(string route)
    {
        await using var f = await AgentLeaseRaceFixture.Create();
        var requestId = Guid.NewGuid().ToString(); var leaseId = Guid.NewGuid().ToString();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var proceed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var held = f.Workspaces.WithIdleSourceAsync(f.Tree.Owner, async () =>
        {
            entered.TrySetResult(); await proceed.Task.WaitAsync(TimeSpan.FromSeconds(15)); return true;
        }, default);
        Task? acquiring = null; Task<CoreAgentWorkspaceResult>? cleanup = null;
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            acquiring = f.Acquire(route, requestId, leaseId);
            await f.WaitFor(record => record.Leases?.Any(lease => lease.LeaseId == leaseId) == true);
            Assert.DoesNotContain(leaseId, (await f.Workspaces.Read(f.Tree.Id, null, default)).Leases);
            // The admission gate must not hold the metadata store's global gate across the effect.
            await f.Store.Change(f.Reference, record => record, default).WaitAsync(TimeSpan.FromSeconds(5));
            cleanup = f.ReleaseAll();
            await Task.WhenAny(cleanup, Task.Delay(100));
            Assert.False(cleanup.IsCompleted);
            Assert.False((await f.Store.Get(f.Reference, default)).Leases!.Single().Released);
        }
        finally
        {
            proceed.TrySetResult(); await held.WaitAsync(TimeSpan.FromSeconds(10));
            if (acquiring is not null) await acquiring.WaitAsync(TimeSpan.FromSeconds(10));
            if (cleanup is not null) await cleanup.WaitAsync(TimeSpan.FromSeconds(10));
        }
        var record = await f.Store.Get(f.Reference, default);
        Assert.True(record.WorkspaceLeasesClosed); Assert.True(Assert.Single(record.Leases!).Released);
        Assert.DoesNotContain(leaseId, (await f.Workspaces.Read(f.Tree.Id, null, default)).Leases);
        await f.AssertAcquireRejected(route, requestId, leaseId);
        Assert.DoesNotContain(leaseId, (await f.Workspaces.Read(f.Tree.Id, null, default)).Leases);
        var reopened = new CoreAgentAuthorizationStore(f.Paths);
        Assert.True((await reopened.Get(f.Reference, default)).WorkspaceLeasesClosed);
        await Assert.ThrowsAsync<CoreProviderException>(() => reopened.RecordLease(f.Reference,
            new(f.Tree.WorkspaceId, f.Tree.Id, f.Owner.SessionId, Guid.NewGuid().ToString(), Guid.NewGuid().ToString()), default));
    }

    [Fact]
    public async Task AgentMcpIndividualReleaseWaitsForAcquireAndPreservesIndependentClaims()
    {
        await using var f = await AgentLeaseRaceFixture.Create();
        var requestId = Guid.NewGuid().ToString(); var leaseId = Guid.NewGuid().ToString(); var releaseId = Guid.NewGuid().ToString();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var proceed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var held = f.Workspaces.WithIdleSourceAsync(f.Tree.Owner, async () =>
        {
            entered.TrySetResult(); await proceed.Task.WaitAsync(TimeSpan.FromSeconds(15)); return true;
        }, default);
        Task? acquiring = null; Task<JsonElement>? releasing = null;
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            acquiring = f.Acquire("mcp-lease", requestId, leaseId);
            await f.WaitFor(record => record.Leases?.Any(lease => lease.LeaseId == leaseId) == true);
            releasing = f.McpRelease(releaseId, leaseId);
            await Task.WhenAny(releasing, Task.Delay(100));
            Assert.False(releasing.IsCompleted);
        }
        finally
        {
            proceed.TrySetResult(); await held.WaitAsync(TimeSpan.FromSeconds(10));
            if (acquiring is not null) await acquiring.WaitAsync(TimeSpan.FromSeconds(10));
            if (releasing is not null)
            {
                var released = await releasing.WaitAsync(TimeSpan.FromSeconds(10));
                Assert.False(released.TryGetProperty("error", out var error), error.ToString());
            }
        }
        var record = await f.Store.Get(f.Reference, default);
        Assert.False(record.WorkspaceLeasesClosed); Assert.True(Assert.Single(record.Leases!).Released);
        Assert.DoesNotContain(leaseId, (await f.Workspaces.Read(f.Tree.Id, null, default)).Leases);
        await f.AssertAcquireRejected("mcp-lease", requestId, leaseId);
        var unrelated = Guid.NewGuid().ToString(); await f.Acquire("mcp-lease", Guid.NewGuid().ToString(), unrelated);
        var repeated = await f.McpRelease(releaseId, leaseId);
        Assert.False(repeated.TryGetProperty("error", out var repeatedError), repeatedError.ToString());
        var actual = await f.Workspaces.Read(f.Tree.Id, null, default);
        Assert.DoesNotContain(leaseId, actual.Leases); Assert.Contains(unrelated, actual.Leases);
        Assert.False((await f.Store.Get(f.Reference, default)).Leases!.Single(lease => lease.LeaseId == unrelated).Released);
        await f.ReleaseAll();
    }

    [Fact]
    public async Task AgentLeaseReleaseFencesTheOriginalUuidWithoutClosingOtherAcquisition()
    {
        await using var f = await AgentLeaseRaceFixture.Create();
        var requestId = Guid.NewGuid().ToString(); var leaseId = Guid.NewGuid().ToString();
        await f.Acquire("direct", requestId, leaseId);
        await f.Service.Workspace(f.Provider, new(f.Reference, "release", new(f.Tree.Id,
            LeaseId: leaseId, RequestId: Guid.NewGuid().ToString())), default);
        Assert.False((await f.Store.Get(f.Reference, default)).WorkspaceLeasesClosed);
        await f.AssertAcquireRejected("direct", requestId, leaseId);
        var second = Guid.NewGuid().ToString();
        await f.Acquire("direct", Guid.NewGuid().ToString(), second);
        Assert.Contains(second, (await f.Workspaces.Read(f.Tree.Id, null, default)).Leases);
        await f.ReleaseAll();
        Assert.DoesNotContain(second, (await f.Workspaces.Read(f.Tree.Id, null, default)).Leases);
    }

    [Fact]
    public async Task AgentLeaseCleanupBeforeAnyIntentDurablyRejectsLaterDirectAndMcpAcquisition()
    {
        await using var f = await AgentLeaseRaceFixture.Create();
        Assert.Empty((await f.Store.Get(f.Reference, default)).Leases ?? []);
        await f.ReleaseAll();
        var reopened = new CoreAgentAuthorizationStore(f.Paths);
        Assert.True((await reopened.Get(f.Reference, default)).WorkspaceLeasesClosed);
        var service = ActivatorUtilities.CreateInstance<CoreAgentExecution>(f.Host.Services, reopened);
        var request = new CoreAgentWorkspaceRequest(f.Reference, "lease", new(f.Tree.Id,
            LeaseId: Guid.NewGuid().ToString(), RequestId: Guid.NewGuid().ToString()));
        await Assert.ThrowsAsync<CoreProviderException>(() => service.Workspace(f.Provider, request, default));
        foreach (var route in new[] { "mcp-prepare", "mcp-lease" })
            await f.AssertAcquireRejected(route, Guid.NewGuid().ToString(), Guid.NewGuid().ToString());
        Assert.Empty((await f.Workspaces.Read(f.Tree.Id, null, default)).Leases);
    }

    [Fact]
    public async Task AgentLeaseUncertainMcpReplyRecoversOnlyItsExactClaimAfterRevocation()
    {
        await using var f = await AgentLeaseRaceFixture.Create();
        var requestId = Guid.NewGuid().ToString(); var leaseId = Guid.NewGuid().ToString(); var unrelated = Guid.NewGuid().ToString();
        var context = new DefaultHttpContext(); context.Request.Path = "/api/mcp";
        context.Request.Headers.Authorization = "Bearer " + f.McpToken;
        var caller = await f.Host.Services.GetRequiredService<CoreCapabilityAuthorization>().RequireAsync(context.Request,
            [AccessTokenScopes.McpRead, AccessTokenScopes.McpWorkspaces], [CoreAppPermissions.Sources], default);
        await Assert.ThrowsAsync<IOException>(() => f.Service.McpLease(caller.Authority, f.Owner.UserId,
            f.Owner, requestId, leaseId, async () =>
            {
                await f.Workspaces.CommandAsync(f.Tree.Id, f.Owner, "lease", new(requestId, LeaseId: leaseId), default);
                throw new IOException("The actual claim committed before its reply was lost.");
            }, default));
        Assert.Empty(Assert.Single((await f.Store.Get(f.Reference, default)).Leases!).WorktreeId);
        await f.Workspaces.CommandAsync(f.Tree.Id, f.Owner, "lease", new(Guid.NewGuid().ToString(), LeaseId: unrelated), default);
        await f.Host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(f.Consumer with { GrantedCorePermissions = [] });
        var reopened = new CoreAgentAuthorizationStore(f.Paths);
        var service = ActivatorUtilities.CreateInstance<CoreAgentExecution>(f.Host.Services, reopened);
        var cleanup = new CoreAgentWorkspaceRequest(f.Reference, "release_all", new("", RequestId: Guid.NewGuid().ToString()));
        await service.Workspace(f.Provider, cleanup, default); await service.Workspace(f.Provider, cleanup, default);
        var actual = await f.Workspaces.Read(f.Tree.Id, null, default);
        Assert.DoesNotContain(leaseId, actual.Leases); Assert.Contains(unrelated, actual.Leases);
        Assert.True((await reopened.Get(f.Reference, default)).WorkspaceLeasesClosed);
        Assert.True(Assert.Single((await reopened.Get(f.Reference, default)).Leases!).Released);
    }

    [Fact]
    public async Task AgentLeaseCanceledCleanupRetainsItsFenceAndUnreleasedIntentForExactRecovery()
    {
        await using var f = await AgentLeaseRaceFixture.Create();
        var leaseId = Guid.NewGuid().ToString(); await f.Acquire("direct", Guid.NewGuid().ToString(), leaseId);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var proceed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var held = f.Workspaces.WithPublicationAdmissionAsync(f.Owner, async _ =>
        {
            entered.TrySetResult(); await proceed.Task.WaitAsync(TimeSpan.FromSeconds(15));
        }, default);
        using var cancel = new CancellationTokenSource();
        var cleanup = new CoreAgentWorkspaceRequest(f.Reference, "release_all", new("", RequestId: Guid.NewGuid().ToString()));
        Task<CoreAgentWorkspaceResult>? pending = null;
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            pending = f.Service.Workspace(f.Provider, cleanup, cancel.Token);
            await f.WaitFor(record => record.WorkspaceLeasesClosed);
            cancel.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
            Assert.False(Assert.Single((await f.Store.Get(f.Reference, default)).Leases!).Released);
            Assert.Contains(leaseId, (await f.Workspaces.Read(f.Tree.Id, null, default)).Leases);
        }
        finally
        {
            cancel.Cancel(); proceed.TrySetResult(); await held.WaitAsync(TimeSpan.FromSeconds(10));
            if (pending is not null)
                try { await pending.WaitAsync(TimeSpan.FromSeconds(10)); } catch (OperationCanceledException) { }
        }
        var reopened = new CoreAgentAuthorizationStore(f.Paths);
        var service = ActivatorUtilities.CreateInstance<CoreAgentExecution>(f.Host.Services, reopened);
        await service.Workspace(f.Provider, cleanup, default);
        Assert.True(Assert.Single((await reopened.Get(f.Reference, default)).Leases!).Released);
        Assert.DoesNotContain(leaseId, (await f.Workspaces.Read(f.Tree.Id, null, default)).Leases);
        await f.AssertAcquireRejected("direct", Guid.NewGuid().ToString(), Guid.NewGuid().ToString());
    }

    [Fact]
    public async Task AgentMcpOwnedReleaseRejectsForeignReclaimInsideTheActualMutationLock()
    {
        await using var f = await AgentLeaseRaceFixture.Create();
        var leaseId = Guid.NewGuid().ToString(); await f.Acquire("direct", Guid.NewGuid().ToString(), leaseId);
        var context = new DefaultHttpContext(); context.Request.Path = "/api/mcp";
        context.Request.Headers.Authorization = "Bearer " + f.McpToken;
        var caller = await f.Host.Services.GetRequiredService<CoreCapabilityAuthorization>().RequireAsync(context.Request,
            [AccessTokenScopes.McpRead, AccessTokenScopes.McpWorkspaces], [CoreAppPermissions.Sources], default);
        Assert.Equal(f.Reference, caller.Authority!.Mcp!.AgentAdmissionRef);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var proceed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new WorkspaceCommand(Guid.NewGuid().ToString(), LeaseId: leaseId);
        var releasing = f.Service.McpRelease(caller.Authority, f.Owner.UserId, f.Owner, f.Tree.Id,
            release.RequestId, leaseId, async () =>
            {
                entered.TrySetResult(); await proceed.Task.WaitAsync(TimeSpan.FromSeconds(15));
                return await f.Workspaces.ReleaseAgentLeaseCommandAsync(f.Tree.Id, f.Owner, release, default);
            }, default);
        var foreign = f.Owner with { SessionId = Guid.NewGuid().ToString() };
        AppLifecycleException? rejected = null;
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await f.Workspaces.CommandAsync(f.Tree.Id, f.Owner, "release-lease", new(Guid.NewGuid().ToString(), LeaseId: leaseId), default);
            await f.Workspaces.CommandAsync(f.Tree.Id, foreign, "lease", new(Guid.NewGuid().ToString(), LeaseId: leaseId), default);
        }
        finally
        {
            proceed.TrySetResult();
            try { await releasing.WaitAsync(TimeSpan.FromSeconds(10)); } catch (AppLifecycleException error) { rejected = error; }
        }
        Assert.NotNull(rejected); Assert.Equal("workspace_lease_owner", rejected.Code);
        var actual = await f.Workspaces.Read(f.Tree.Id, null, default);
        Assert.Contains(leaseId, actual.Leases);
        Assert.True(Assert.Single(actual.LeaseClaims!, claim => claim.Id == leaseId).Session.SameIdentity(foreign));
        Assert.False(Assert.Single((await f.Store.Get(f.Reference, default)).Leases!).Released);
        var ordinary = await Assert.ThrowsAsync<AppLifecycleException>(() => f.Workspaces.CommandAsync(f.Tree.Id,
            f.Owner, "release-lease", release, default));
        Assert.Equal("workspace_request_conflict", ordinary.Code);
        Assert.Contains(leaseId, (await f.Workspaces.Read(f.Tree.Id, null, default)).Leases);
    }

    [Fact]
    public async Task AgentOwnedReleasePendingReceiptRecoversAsUnknownWithoutReplayingForeignRemoval()
    {
        await using var f = await AgentLeaseRaceFixture.Create();
        var leaseId = Guid.NewGuid().ToString(); await f.Acquire("direct", Guid.NewGuid().ToString(), leaseId);
        var foreign = f.Owner with { SessionId = Guid.NewGuid().ToString() };
        await f.Workspaces.CommandAsync(f.Tree.Id, f.Owner, "release-lease", new(Guid.NewGuid().ToString(), LeaseId: leaseId), default);
        await f.Workspaces.CommandAsync(f.Tree.Id, foreign, "lease", new(Guid.NewGuid().ToString(), LeaseId: leaseId), default);
        var input = new WorkspaceCommand(Guid.NewGuid().ToString(), LeaseId: leaseId);
        var current = await f.Workspaces.Read(f.Tree.Id, null, default);
        var pending = new WorkspaceOperation(input.RequestId, "release-agent-lease", DevelopmentWorkspaceService.Hash(CoreJson.Text(input)),
            "pending", current.OriginalBase, Command: input, Actor: f.Owner);
        var file = Path.Combine(f.Paths.CoreRoot, "development", "workspaces", f.Tree.Id + ".json");
        await JsonStorage.WriteAsync(file, current with { Operations = [.. current.Operations, pending] }, restrictToOwner: true);
        var recovered = await f.Workspaces.ReleaseAgentLeaseCommandAsync(f.Tree.Id, f.Owner, input, default);
        Assert.Equal("unknown", Assert.Single(recovered.Operations, operation => operation.Id == input.RequestId).State);
        Assert.Contains(leaseId, recovered.Leases);
        Assert.True(Assert.Single(recovered.LeaseClaims!, claim => claim.Id == leaseId).Session.SameIdentity(foreign));
        Assert.False(Assert.Single((await f.Store.Get(f.Reference, default)).Leases!).Released);
        var ordinary = await Assert.ThrowsAsync<AppLifecycleException>(() => f.Workspaces.CommandAsync(f.Tree.Id, f.Owner,
            "release-lease", input, default));
        Assert.Equal("workspace_request_conflict", ordinary.Code);
        Assert.Contains(leaseId, (await f.Workspaces.Read(f.Tree.Id, null, default)).Leases);
    }

    [Fact]
    public async Task AgentLeaseCanceledGateWaiterPreservesOwnerSerializationAndOtherAdmissionProgress()
    {
        await using var f = await AgentLeaseRaceFixture.Create();
        var other = new string('d', 64);
        await f.Store.Put((await f.Store.Get(f.Reference, default)) with { Id = other, Leases = [] }, default);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var proceed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var owning = f.Store.WithWorkspaceLease(f.Reference, async _ =>
        {
            entered.TrySetResult(); await proceed.Task.WaitAsync(TimeSpan.FromSeconds(15)); return true;
        }, default);
        using var cancel = new CancellationTokenSource();
        Task<bool>? waiting = null; Task<bool>? following = null;
        var canceledInvoked = false; var followingInvoked = false;
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            waiting = f.Store.WithWorkspaceLease(f.Reference, _ => Task.FromResult(canceledInvoked = true), cancel.Token);
            await Task.WhenAny(waiting, Task.Delay(100)); Assert.False(waiting.IsCompleted);
            cancel.Cancel(); await Assert.ThrowsAnyAsync<OperationCanceledException>(() => waiting);
            Assert.False(canceledInvoked);
            Assert.True(await f.Store.WithWorkspaceLease(other, _ => Task.FromResult(true), default).WaitAsync(TimeSpan.FromSeconds(5)));
            following = f.Store.WithWorkspaceLease(f.Reference, _ => Task.FromResult(followingInvoked = true), default);
            await Task.WhenAny(following, Task.Delay(100)); Assert.False(following.IsCompleted); Assert.False(followingInvoked);
        }
        finally
        {
            cancel.Cancel(); proceed.TrySetResult(); await owning.WaitAsync(TimeSpan.FromSeconds(10));
            if (waiting is not null) try { await waiting.WaitAsync(TimeSpan.FromSeconds(10)); } catch (OperationCanceledException) { }
            if (following is not null) Assert.True(await following.WaitAsync(TimeSpan.FromSeconds(10)));
        }
        Assert.True(followingInvoked);
        Assert.True(await f.Store.WithWorkspaceLease(f.Reference, _ => Task.FromResult(true), default).WaitAsync(TimeSpan.FromSeconds(5)));
    }

    private sealed record AgentLeaseRaceFixture(CoreHttpHarness Host, CoreAgentExecution Service,
        CoreAgentAuthorizationStore Store, DevelopmentWorkspaceService Workspaces, CoreDataPaths Paths,
        AppRecord Provider, AppRecord Consumer, WorkspaceOwner Owner, DevelopmentWorkspace Tree,
        string Reference, string McpToken) : IAsyncDisposable
    {
        internal static async Task<AgentLeaseRaceFixture> Create()
        {
            var host = await CoreHttpHarness.StartAsync();
            try
            {
                var services = host.Services; var now = services.GetRequiredService<IClock>().UtcNow;
                await services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
                    [new("admin", "admin@example.test", "Admin", "host.admin", false, now, now)], [], [], []));
                await ExternalWorkspaceMcpHttpTests.SeedSourceAsync(host);
                var consumer = AssistantMcpAccessHttpTests.Record("independent.lease.consumer", now) with
                    { GrantedCorePermissions = [CoreAppPermissions.AgentProviders, CoreAppPermissions.Sources] };
                var provider = AssistantMcpAccessHttpTests.Record("independent.lease.provider", now) with
                {
                    ConfirmedRoles = ["agent"], Endpoints = [new("api", "http", "http://127.0.0.1:3999", true)],
                    Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["agent"] = [new("native", "api", "/api/agent/v1", 1, [])] }
                };
                var apps = services.GetRequiredService<AppRegistryStore>();
                await apps.UpsertAppAsync(consumer); await apps.UpsertAppAsync(provider);
                var owner = new WorkspaceOwner(provider.Id, provider.InstalledAt, "admin", Guid.NewGuid().ToString());
                var workspaces = services.GetRequiredService<DevelopmentWorkspaceService>();
                var tree = await workspaces.PrepareAsync(owner, new(Guid.NewGuid().ToString(), owner.SessionId,
                    "com.example.external-source", null, TargetBranch: "main", Name: "Verify agent lease cleanup"), default);
                var participation = await workspaces.ParticipationAsync(tree.WorkspaceId, owner.UserId, default);
                var credential = await BrowserAuthorityFixture.Grant(host, consumer.Id, owner.UserId);
                await services.GetRequiredService<AgentPolicyStore>().ChangeAsync(AgentMcpDirectory.CoreId,
                    new(null, true, new Dictionary<string, string>(), new Dictionary<string, AssistantTargetGrant>
                        { [consumer.Id] = new(consumer.InstalledAt, "lease-review") }));
                var service = services.GetRequiredService<CoreAgentExecution>(); var run = Guid.NewGuid().ToString();
                var request = new CoreAgentAuthorizeRequest(new(provider.Id, PanelIdentity.Installation(provider), "native"),
                    "runs.start", "PUT", $"/sessions/{owner.SessionId}/runs/{run}", new string('a', 64),
                    Resources: JsonSerializer.SerializeToElement(new[] { new { kind = "worktree", id = tree.Id, revision = participation.Revision.ToString() } }),
                    SessionId: owner.SessionId, RunId: run,
                    Ceiling: JsonSerializer.SerializeToElement(new { mcp = new { targets = new[] { new { target = new { kind = "core" },
                        tools = new[] { "prepare_workspace", "acquire_workspace_lease", "release_workspace_lease" } } } } }));
                var binding = await service.Authorize(consumer, credential.AccessToken, request, default);
                await service.Admit(provider, binding.AdmissionRef, default);
                var mcp = await service.McpToken(provider, new(binding.AdmissionRef, new("core")), default);
                return new(host, service, services.GetRequiredService<CoreAgentAuthorizationStore>(), workspaces,
                    services.GetRequiredService<CoreDataPaths>(), provider, consumer, owner, tree, binding.AdmissionRef, mcp.Token);
            }
            catch { await host.DisposeAsync(); throw; }
        }

        internal async Task WaitFor(Func<CoreAgentAuthorization, bool> predicate)
        {
            var timer = Stopwatch.StartNew();
            while (!predicate(await Store.Get(Reference, default)))
            {
                Assert.True(timer.Elapsed < TimeSpan.FromSeconds(5), "The exact durable lease checkpoint was not reached.");
                await Task.Delay(10);
            }
        }
        internal Task<CoreAgentWorkspaceResult> ReleaseAll() => Service.Workspace(Provider,
            new(Reference, "release_all", new("", RequestId: Guid.NewGuid().ToString())), default);
        internal async Task Acquire(string route, string requestId, string leaseId)
        {
            if (route == "direct")
            {
                var result = await Service.Workspace(Provider, new(Reference, "lease", new(Tree.Id,
                    LeaseId: leaseId, RequestId: requestId)), default);
                Assert.Equal(leaseId, result.LeaseId); return;
            }
            var resultJson = await McpAcquire(route, requestId, leaseId);
            Assert.False(resultJson.TryGetProperty("error", out var error), error.ToString());
            Assert.Equal(Tree.Id, resultJson.GetProperty("id").GetString());
        }
        internal async Task AssertAcquireRejected(string route, string requestId, string leaseId)
        {
            if (route == "direct")
            {
                var error = await Assert.ThrowsAsync<CoreProviderException>(() => Service.Workspace(Provider,
                    new(Reference, "lease", new(Tree.Id, LeaseId: leaseId, RequestId: requestId)), default));
                Assert.Equal("execution_conflict", error.Error.Code); return;
            }
            var result = await McpAcquire(route, requestId, leaseId);
            Assert.True(result.TryGetProperty("error", out _), "A closed acquisition was unexpectedly accepted.");
        }
        private async Task<JsonElement> McpAcquire(string route, string requestId, string leaseId)
        {
            var tool = route == "mcp-prepare" ? "prepare_workspace" : "acquire_workspace_lease";
            object arguments = route == "mcp-prepare"
                ? new { requestId, taskId = Owner.SessionId, appId = "com.example.external-source", leaseId,
                    name = "Verify agent lease cleanup", targetBranch = "main" }
                : new { requestId, workspaceId = Tree.Id, leaseId };
            return await McpTool(tool, arguments);
        }
        internal Task<JsonElement> McpRelease(string requestId, string leaseId)
            => McpTool("release_workspace_lease", new { requestId, workspaceId = Tree.Id, leaseId });
        private async Task<JsonElement> McpTool(string tool, object arguments)
        {
            using var client = Host.CreateClient();
            using var request = new HttpRequestMessage(HttpMethod.Post, "/api/mcp")
                { Content = JsonContent.Create(new { jsonrpc = "2.0", id = 1, method = "tools/call", @params = new { name = tool, arguments } }) };
            request.Headers.Authorization = new("Bearer", McpToken);
            request.Headers.Accept.Add(new("application/json")); request.Headers.Accept.Add(new("text/event-stream"));
            using var response = await client.SendAsync(request);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var body = await response.Content.ReadAsStringAsync();
            var json = body.TrimStart().StartsWith('{') ? body : body.Split('\n').Select(line => line.Trim())
                .First(line => line.StartsWith("data:", StringComparison.Ordinal))["data:".Length..];
            using var envelope = JsonDocument.Parse(json);
            Assert.False(envelope.RootElement.TryGetProperty("error", out var error), error.ToString());
            return JsonDocument.Parse(envelope.RootElement.GetProperty("result").GetProperty("content")[0].GetProperty("text").GetString()!).RootElement.Clone();
        }
        public ValueTask DisposeAsync() => Host.DisposeAsync();
    }
}
