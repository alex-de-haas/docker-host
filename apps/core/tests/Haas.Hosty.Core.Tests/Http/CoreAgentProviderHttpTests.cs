using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Haas.Hosty.Core;
using HostySdk.App;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class CoreAgentProviderHttpTests
{
    [Fact]
    public async Task ExactAgentAdmissionIsInstallationBoundRetainedWithoutConsumerAndLiveRevocable()
    {
        var clock = new TestClock(DateTimeOffset.UtcNow);
        await using var host = await CoreHttpHarness.StartAsync(clock);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var now = clock.UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
            [new("owner", "owner@example.test", "Owner", "host.admin", false, now, now)], [], [], []));
        var consumer = Record("unrelated.consumer", now) with { GrantedCorePermissions = [CoreAppPermissions.AgentProviders, CoreAppPermissions.ReadSkills, CoreAppPermissions.ReadCore, CoreAppPermissions.Sources] };
        var provider = Record("independent.provider", now) with { RuntimeState = "running", ConfirmedRoles = ["agent"],
            GrantedCorePermissions = [],
            Endpoints = [new("api", "http", "http://127.0.0.1:3999", true)],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["agent"] = [new("native", "api", "/api/agent/v2", 2, [])] } };
        await apps.UpsertAppAsync(consumer); await apps.UpsertAppAsync(provider);
        var discovery = await host.Services.GetRequiredService<ProviderAccessService>().ListAsync(consumer, "agent", default);
        Assert.Equal(PanelIdentity.Installation(provider), Assert.Single(discovery.Providers).InstallationId);
        Assert.Contains("agent", PlatformCapabilities.RequestedRoles(["agent"]));
        var credential = await BrowserAuthorityFixture.Grant(host, consumer.Id, "owner");
        var service = host.Services.GetRequiredService<CoreAgentExecution>();
        await host.Services.GetRequiredService<AgentPolicyStore>().ChangeAsync(AgentMcpDirectory.CoreId,
            new(null, true, new Dictionary<string, string>(), new Dictionary<string, AssistantTargetGrant> { [consumer.Id] = new(consumer.InstalledAt, "reviewed") }));
        var session = Guid.NewGuid().ToString(); var run = Guid.NewGuid().ToString();
        var input = new CoreAgentAuthorizeRequest(new(provider.Id, PanelIdentity.Installation(provider), "native"),
            "runs.start", "PUT", $"/sessions/{session}/runs/{run}", Convert.ToHexStringLower(SHA256.HashData("exact bytes"u8)), SessionId: session, RunId: run, ConfigurationDigest: new string('b', 64),
            Ceiling: JsonSerializer.SerializeToElement(new { mcp = new { targets = new[] { new { target = new { kind = "core" }, tools = new[] { "get_host_status", "get_core_development" }, policy = new { @default = "ask", autoAllowReadOnly = true,
                tools = new Dictionary<string, object> { ["get_host_status"] = new { mode = "run", definition = new string('a', 64) }, ["get_core_development"] = new { mode = "disabled" } } } } } } }));
        using var http = host.CreateClient();
        http.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(consumer.Id));
        http.DefaultRequestHeaders.Add("X-Hosty-User-Token", credential.AccessToken);
        var response = await http.PostAsJsonAsync($"/api/internal/apps/{consumer.Id}/agent/authorize", input);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var binding = (await response.Content.ReadFromJsonAsync<JsonElement>()).Deserialize(CoreJson.TypeInfo<CoreAgentBinding>())!;
        var actor = await service.Introspect(provider, new(binding.Token, input.Operation, input.Method, input.Path, input.BodyHash), default);
        Assert.Equal(consumer.Id, actor.CallerAppId); Assert.Equal("owner", actor.UserId);
        Assert.Equal(input.ConfigurationDigest, actor.ConfigurationDigest);
        await Assert.ThrowsAsync<AppIdentityException>(() => service.Introspect(provider, new(binding.Token, input.Operation, input.Method, input.Path, new string('0', 64)), default));
        await Assert.ThrowsAsync<AppIdentityException>(() => service.Renew(provider, binding.AdmissionRef, default));
        await Assert.ThrowsAsync<AppIdentityException>(() => service.Introspect(provider with { Id = "other.provider" }, new(binding.Token, input.Operation, input.Method, input.Path, input.BodyHash), default));
        var cleanup = new CoreAgentCleanupRequest(binding.AdmissionRef, input.Provider, "runs.cancel", "PUT",
            $"/runs/{run}/stop", new string('c', 64), SessionId: session, RunId: run);
        using var serviceClient = host.CreateClient();
        serviceClient.DefaultRequestHeaders.Authorization = http.DefaultRequestHeaders.Authorization;
        var replay = new CoreAgentCleanupRequest(binding.AdmissionRef, input.Provider, input.Operation, input.Method,
            input.Path, input.BodyHash, input.SessionId, input.RunId);
        var replayPath = $"/api/internal/apps/{consumer.Id}/agent/replay/token";
        using var exactReplay = await serviceClient.PostAsJsonAsync(replayPath, replay);
        Assert.Equal(HttpStatusCode.OK, exactReplay.StatusCode);
        Assert.Equal(binding.AdmissionRef, (await service.AuthorizeReplay(consumer, replay, default)).AdmissionRef);
        await Assert.ThrowsAsync<AppIdentityException>(() => service.AuthorizeReplay(consumer, replay with { BodyHash = new string('d', 64) }, default));
        await Assert.ThrowsAsync<AppIdentityException>(() => service.AuthorizeReplay(provider, replay, default));
        var cleanupPath = $"/api/internal/apps/{consumer.Id}/agent/cleanup/token";
        using var mixed = await http.PostAsJsonAsync(cleanupPath, cleanup);
        Assert.False(mixed.IsSuccessStatusCode);
        using var cleanupResponse = await serviceClient.PostAsJsonAsync(cleanupPath, cleanup);
        Assert.Equal(HttpStatusCode.OK, cleanupResponse.StatusCode);
        var cleanupBinding = (await cleanupResponse.Content.ReadFromJsonAsync<JsonElement>()).Deserialize(CoreJson.TypeInfo<CoreAgentBinding>())!;
        var exactStop = new CoreAgentIntrospection(cleanupBinding.Token, "runs.cancel", "PUT", cleanup.Path, cleanup.BodyHash);
        var stoppedOwner = await service.Introspect(provider, exactStop, default);
        Assert.Equal(run, stoppedOwner.RunId);
        Assert.Equal(input.BodyHash, stoppedOwner.OriginalStartDigest);
        Assert.True(stoppedOwner.CleanupOnly);
        var discard = cleanup with { Operation = "runs.discard", Path = $"/runs/{run}/discard" };
        var discardToken = await service.AuthorizeCleanup(consumer, discard, default);
        var discardOwner = await service.Introspect(provider, new(discardToken.Token, "runs.discard", "PUT", discard.Path, discard.BodyHash), default);
        Assert.True(discardOwner.CleanupOnly);
        Assert.Equal(binding.AdmissionRef, discardOwner.AdmissionRef);
        await Assert.ThrowsAsync<AppIdentityException>(() => service.AuthorizeCleanup(provider, discard, default));
        await Assert.ThrowsAsync<AppIdentityException>(() => service.Introspect(provider, exactStop with { BodyHash = new string('d', 64) }, default));
        await Assert.ThrowsAsync<AppIdentityException>(() => service.AuthorizeCleanup(consumer, cleanup with { RunId = Guid.NewGuid().ToString() }, default));
        await Assert.ThrowsAsync<AppIdentityException>(() => service.AuthorizeCleanup(consumer, cleanup with { Operation = "runs.respond" }, default));
        await Assert.ThrowsAsync<AppIdentityException>(() => service.AuthorizeCleanup(provider, cleanup, default));
        await Assert.ThrowsAsync<AppIdentityException>(() => service.AuthorizeCleanup(consumer with { InstalledAt = now.AddDays(1) }, cleanup, default));
        await Assert.ThrowsAsync<CoreProviderException>(() => service.Authorize(consumer, credential.AccessToken, input with { BodyHash = new string('d', 64) }, default));
        var sessionAuthorization = await service.Authorize(consumer, credential.AccessToken, input with {
            Operation = "sessions.create", Path = "/sessions/" + session, RunId = null, Ceiling = null }, default);
        var snapshot = await service.Skills(provider, new(sessionAuthorization.AdmissionRef, Guid.NewGuid().ToString(), [new(CoreAgentSkills.PlatformId)]), default);
        Assert.Single(snapshot.Skills);
        await apps.UpsertAppAsync(consumer with { GrantedCorePermissions = [CoreAppPermissions.AgentProviders, CoreAppPermissions.ReadCore] });
        var skillDenied = await Assert.ThrowsAsync<AppIdentityException>(() => service.Skills(provider, new(sessionAuthorization.AdmissionRef, Guid.NewGuid().ToString(), [new(CoreAgentSkills.PlatformId)]), default));
        Assert.Equal("app_permission_required", skillDenied.Code);
        await apps.UpsertAppAsync(consumer);
        await service.Admit(provider, binding.AdmissionRef, default);
        var contextDenied = await Assert.ThrowsAsync<AppIdentityException>(() => service.Workspace(provider,
            new(binding.AdmissionRef, "resolve", new("another-worktree")), default));
        Assert.Contains("declared worktree context", contextDenied.Message);
        await Assert.ThrowsAsync<AppIdentityException>(() => service.McpToken(provider, new(binding.AdmissionRef, new("core"), ["list_apps"]), default));
        var mcp = await service.McpToken(provider, new(binding.AdmissionRef, new("core"), ["get_host_status"]), default);
        var mcpActor = await host.Services.GetRequiredService<AssistantMcpAccess>().ValidateAsync(mcp.Token, AgentMcpDirectory.CoreId, default);
        Assert.NotNull(mcpActor); Assert.Contains(CoreAppPermissions.ReadCore, mcpActor.EffectivePermissions!);
        Assert.DoesNotContain(CoreAppPermissions.ReadCore, provider.GrantedCorePermissions!);
        var policyToken = await service.McpToken(provider, new(binding.AdmissionRef, new("core"), ["get_core_development"]), default);
        var policyActor = await host.Services.GetRequiredService<AssistantMcpAccess>().ValidateAsync(policyToken.Token, AgentMcpDirectory.CoreId, default);
        Assert.Contains("get_core_development", policyActor!.AllowedTools!); Assert.Contains("get_core_development", policyActor.DeniedTools!);
        using var toolClient = host.CreateClient(); toolClient.DefaultRequestHeaders.Authorization = new("Bearer", mcp.Token);
        var forbiddenTool = await toolClient.PostAsJsonAsync("/api/mcp", new { jsonrpc = "2.0", id = 1, method = "tools/call", @params = new { name = "get_core_development", arguments = new { } } });
        Assert.Equal(HttpStatusCode.Forbidden, forbiddenTool.StatusCode);
        var context = new Microsoft.AspNetCore.Http.DefaultHttpContext(); context.Request.Path = "/api/mcp";
        context.Request.Headers.Authorization = "Bearer " + mcp.Token;
        var delegated = await host.Services.GetRequiredService<CoreCapabilityAuthorization>().RequireAsync(context.Request,
            [AccessTokenScopes.McpRead], [CoreAppPermissions.ReadCore], default);
        Assert.Equal(provider.Id, delegated.App!.Id);
        await Assert.ThrowsAsync<AppIdentityException>(() => host.Services.GetRequiredService<CoreCapabilityAuthorization>().RequireAsync(context.Request,
            [AccessTokenScopes.McpRead], [CoreAppPermissions.AppLifecycle], default));
        await apps.UpsertAppAsync(consumer with { RuntimeState = "stopped" });
        clock.UtcNow = now.AddMinutes(3); // The request bearer expires; admitted authority has its original lifetime.
        var expired = await Assert.ThrowsAsync<AppIdentityException>(() => service.Introspect(provider,
            new(binding.Token, input.Operation, input.Method, input.Path, input.BodyHash), default));
        Assert.Equal("token_invalid", expired.Code);
        var renewed = await service.Renew(provider, binding.AdmissionRef, default);
        Assert.Equal(run, renewed.RunId); Assert.Equal(input.ConfigurationDigest, renewed.ConfigurationDigest);
        Assert.Equal(binding.AuthorityExpiresAt, renewed.ExpiresAt);
        var renewedMcp = await service.McpToken(provider, new(binding.AdmissionRef, new("core"), ["get_host_status"]), default);
        Assert.True(renewedMcp.ExpiresAt > mcp.ExpiresAt);
        var retainedActor = await host.Services.GetRequiredService<AssistantMcpAccess>().ValidateAsync(renewedMcp.Token, AgentMcpDirectory.CoreId, default);
        Assert.NotNull(retainedActor); Assert.Contains(CoreAppPermissions.ReadCore, retainedActor.EffectivePermissions!);
        context.Request.Headers.Authorization = "Bearer " + renewedMcp.Token;
        Assert.Equal(provider.Id, (await host.Services.GetRequiredService<CoreCapabilityAuthorization>().RequireAsync(context.Request,
            [AccessTokenScopes.McpRead], [CoreAppPermissions.ReadCore], default)).App!.Id);
        await Assert.ThrowsAsync<AppIdentityException>(() => service.Renew(provider with { InstalledAt = now.AddSeconds(1) }, binding.AdmissionRef, default));
        await apps.UpsertAppAsync(consumer with { PermissionRevision = "revoked", GrantedCorePermissions = [] });
        await Assert.ThrowsAsync<AppIdentityException>(() => service.Renew(provider, binding.AdmissionRef, default));
        await Assert.ThrowsAsync<AppIdentityException>(() => service.McpToken(provider, new(binding.AdmissionRef, new("core"), ["get_host_status"]), default));
        Assert.Null(await host.Services.GetRequiredService<AssistantMcpAccess>().ValidateAsync(renewedMcp.Token, AgentMcpDirectory.CoreId, default));
    }

    [Fact]
    public async Task AgentAuthorizationBindsNamedImplementationAndExactOperationWithoutCategoryToken()
    {
        var now = DateTimeOffset.UtcNow;
        await using var host = await CoreHttpHarness.StartAsync(new TestClock(now));
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var tokens = host.Services.GetRequiredService<AppServiceTokenService>();
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
            [new("owner", "owner@example.test", "Owner", "host.admin", false, now, now)], [], [], []));
        var consumer = Record("other.consumer", now) with { GrantedCorePermissions = [CoreAppPermissions.AgentProviders] };
        var provider = Record("thirdparty.agent", now) with { RuntimeState = "running", ConfirmedRoles = ["agent"],
            Endpoints = [new("api", "http", "http://127.0.0.1:3999", true)],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> {
                ["agent"] = [new("native", "api", "/agent", 2, [NamedProviderImplementations.Capability])] } };
        await apps.UpsertAppAsync(consumer); await apps.UpsertAppAsync(provider);
        await apps.PublishImplementationsAsync(provider, "agent", new("native", 1, [new("x", "First", true), new("y", "Second", true)]), default);
        using var caller = host.CreateClient();
        caller.DefaultRequestHeaders.Authorization = new("Bearer", tokens.CreateToken(consumer.Id));
        var credential = await BrowserAuthorityFixture.Grant(host, consumer.Id, "owner");
        caller.DefaultRequestHeaders.Add("X-Hosty-User-Token", credential.AccessToken);
        var reference = new HostyProviderRef(provider.Id, PanelIdentity.Installation(provider), "native") { ImplementationId = "x" };
        var input = new CoreAgentAuthorizeRequest(reference, "capabilities", "GET", "/capabilities", Convert.ToHexStringLower(SHA256.HashData([])));
        var prefix = $"/api/internal/apps/{consumer.Id}";
        Assert.Equal(HttpStatusCode.Forbidden, (await caller.PostAsJsonAsync(prefix + "/providers/agent/token",
            new ProviderTokenRequest(provider.Id, "native", reference.InstallationId, "x"))).StatusCode);
        var result = await caller.PostAsJsonAsync(prefix + "/agent/authorize", input);
        result.EnsureSuccessStatusCode();
        var binding = (await result.Content.ReadFromJsonAsync<JsonElement>()).Deserialize(CoreJson.TypeInfo<CoreAgentBinding>())!;
        var agent = host.Services.GetRequiredService<CoreAgentExecution>();
        var target = (await apps.GetAppAsync(provider.Id))!;
        var check = new CoreAgentIntrospection(binding.Token, input.Operation, input.Method, input.Path, input.BodyHash);
        Assert.Equal(reference, (await agent.Introspect(target, check, default)).Provider);
        await Assert.ThrowsAsync<AppIdentityException>(() => agent.Introspect(target, check with { BodyHash = new string('0', 64) }, default));
        await apps.PublishImplementationsAsync(provider, "agent", new("native", 2, [new("y", "Second", true)]), default);
        await apps.PublishImplementationsAsync(provider, "agent", new("native", 3, [new("x", "First", true)]), default);
        target = (await apps.GetAppAsync(provider.Id))!;
        await Assert.ThrowsAsync<AppIdentityException>(() => agent.Introspect(target, check, default));
    }

    [Fact]
    public async Task ProviderRevisionChangeAllowsFreshOperationsAndKeepsOldRunAdmissionFenced()
    {
        var now = DateTimeOffset.UtcNow;
        await using var host = await CoreHttpHarness.StartAsync(new TestClock(now));
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
            [new("owner", "owner@example.test", "Owner", "host.admin", false, now, now)], [], [], []));
        var consumer = Record("unrelated.consumer", now) with { GrantedCorePermissions = [CoreAppPermissions.AgentProviders] };
        var provider = Record("independent.provider", now) with
        {
            PermissionRevision = Guid.NewGuid().ToString("N"),
            RuntimeState = "running",
            ConfirmedRoles = ["agent"],
            Endpoints = [new("api", "http", "http://127.0.0.1:3999", true)],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["agent"] = [new("native", "api", "/api/agent/v2", 2, [])] },
        };
        await apps.UpsertAppAsync(consumer);
        await apps.UpsertAppAsync(provider);
        var credential = await BrowserAuthorityFixture.Grant(host, consumer.Id, "owner");
        var tokens = host.Services.GetRequiredService<AppServiceTokenService>();
        using var callerHttp = host.CreateClient();
        callerHttp.DefaultRequestHeaders.Authorization = new("Bearer", tokens.CreateToken(consumer.Id));
        callerHttp.DefaultRequestHeaders.Add("X-Hosty-User-Token", credential.AccessToken);
        using var providerHttp = host.CreateClient();
        providerHttp.DefaultRequestHeaders.Authorization = new("Bearer", tokens.CreateToken(provider.Id));
        var callerRoute = $"/api/internal/apps/{consumer.Id}/agent/authorize";
        var providerRoute = $"/api/internal/apps/{provider.Id}/agent";
        var reference = new HostyProviderRef(provider.Id, PanelIdentity.Installation(provider), "native");
        var bodyHash = Convert.ToHexStringLower(SHA256.HashData([]));
        var reads = new CoreAgentAuthorizeRequest[]
        {
            new(reference, "capabilities", "GET", "/capabilities", bodyHash),
            new(reference, "connections.list", "GET", "/connections?limit=100", bodyHash),
        };
        async Task<CoreAgentBinding> Authorize(CoreAgentAuthorizeRequest request)
        {
            using var response = await callerHttp.PostAsJsonAsync(callerRoute, request);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            return (await response.Content.ReadFromJsonAsync<JsonElement>()).Deserialize(CoreJson.TypeInfo<CoreAgentBinding>())!;
        }
        Task<HttpResponseMessage> Introspect(CoreAgentAuthorizeRequest request, CoreAgentBinding binding) => providerHttp.PostAsJsonAsync(
            providerRoute + "/introspect", new CoreAgentIntrospection(binding.Token, request.Operation, request.Method, request.Path, request.BodyHash));
        var session = Guid.NewGuid().ToString();
        CoreAgentAuthorizeRequest StartRun(string run) => new(reference, "runs.start", "PUT", $"/sessions/{session}/runs/{run}",
            new string('b', 64), SessionId: session, RunId: run);

        var originalReads = await Task.WhenAll(reads.Select(Authorize));
        var originalRun = StartRun(Guid.NewGuid().ToString());
        var originalAdmission = await Authorize(originalRun);
        using var admit = await providerHttp.PostAsJsonAsync(providerRoute + "/admit", new CoreAgentReference(originalAdmission.AdmissionRef));
        Assert.Equal(HttpStatusCode.OK, admit.StatusCode);

        await apps.UpsertAppAsync(provider with { Version = "0.1.1", PermissionRevision = Guid.NewGuid().ToString("N") });
        foreach (var (request, original) in reads.Zip(originalReads))
        {
            using var stale = await Introspect(request, original);
            Assert.Equal(HttpStatusCode.Forbidden, stale.StatusCode);
            var current = await Authorize(request);
            Assert.NotEqual(original.AdmissionRef, current.AdmissionRef);
            Assert.Equal(current.AdmissionRef, (await Authorize(request)).AdmissionRef);
            using var accepted = await Introspect(request, current);
            Assert.Equal(HttpStatusCode.OK, accepted.StatusCode);
        }

        using var replay = await callerHttp.PostAsJsonAsync(callerRoute, originalRun);
        Assert.Equal(HttpStatusCode.Forbidden, replay.StatusCode);
        foreach (var operation in new[] { "admit", "renew" })
        {
            using var stale = await providerHttp.PostAsJsonAsync(providerRoute + "/" + operation, new CoreAgentReference(originalAdmission.AdmissionRef));
            Assert.Equal(HttpStatusCode.Forbidden, stale.StatusCode);
        }
        var freshAdmission = await Authorize(StartRun(Guid.NewGuid().ToString()));
        using var fresh = await providerHttp.PostAsJsonAsync(providerRoute + "/admit", new CoreAgentReference(freshAdmission.AdmissionRef));
        Assert.Equal(HttpStatusCode.OK, fresh.StatusCode);
    }

    [Fact]
    public async Task MetadataCannotRelayPromptsAndNativeExecutionRequiresCurrentAdministrator()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var service = host.Services.GetRequiredService<CoreAgentExecution>();
        var now = DateTimeOffset.UtcNow; var caller = Record("unrelated.consumer", now);
        var provider = new HostyProviderRef("unrelated.provider", now.ToString("O"), "native");
        var invalid = new CoreAgentAuthorizeRequest(provider, "capabilities", "GET", "/capabilities", new string('0', 64),
            Ceiling: JsonSerializer.SerializeToElement(new { prompt = "content must stay with provider" }));
        var error = await Assert.ThrowsAsync<CoreProviderException>(() => service.Authorize(caller, "", invalid, default));
        Assert.Equal("invalid_input", error.Error.Code);
        foreach (var digest in new[] { "prompt content", new string('A', 64), new string('a', 65) })
        {
            var digestError = await Assert.ThrowsAsync<CoreProviderException>(() => service.Authorize(caller, "",
                invalid with { Ceiling = null, ConfigurationDigest = digest }, default));
            Assert.Equal("invalid_input", digestError.Error.Code);
        }
        await Assert.ThrowsAsync<CoreProviderException>(() => service.Authorize(caller, "", invalid with { Ceiling = null, Operation = "runs.start" }, default));
    }

    [Theory]
    [InlineData("connections.usage", "usage")]
    [InlineData("connections.models", "models")]
    public async Task ConnectionMetadataAuthorizesTheBoundedPublicOpaqueIdContract(string operation, string suffix)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var now = DateTimeOffset.UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
            [new("owner", "owner@example.test", "Owner", "host.admin", false, now, now)], [], [], []));
        var consumer = Record("unrelated.consumer", now) with { GrantedCorePermissions = [CoreAppPermissions.AgentProviders] };
        var provider = Record("independent.provider", now) with { RuntimeState = "running", ConfirmedRoles = ["agent"],
            Endpoints = [new("api", "http", "http://127.0.0.1:3999", true)],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["agent"] = [new("native", "api", "/api/agent/v2", 2, [])] } };
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync(consumer); await apps.UpsertAppAsync(provider);
        var credential = await BrowserAuthorityFixture.Grant(host, consumer.Id, "owner");
        using var http = host.CreateClient();
        http.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(consumer.Id));
        http.DefaultRequestHeaders.Add("X-Hosty-User-Token", credential.AccessToken);
        foreach (var id in new[] { "account_one-A9", "_", new string('a', 256), "", new string('a', 257), "account/one", "account%2Fone", "account.one", "account one", "аккаунт" })
        {
            var valid = id is "account_one-A9" or "_" || id.Length == 256;
            var input = new CoreAgentAuthorizeRequest(new(provider.Id, PanelIdentity.Installation(provider), "native"),
                operation, "GET", $"/connections/{id}/{suffix}", new string('0', 64));
            using var response = await http.PostAsJsonAsync($"/api/internal/apps/{consumer.Id}/agent/authorize", input);
            Assert.Equal(valid ? HttpStatusCode.OK : HttpStatusCode.BadRequest, response.StatusCode);
            if (valid)
            {
                var binding = (await response.Content.ReadFromJsonAsync<JsonElement>()).Deserialize(CoreJson.TypeInfo<CoreAgentBinding>())!;
                var actor = await host.Services.GetRequiredService<CoreAgentExecution>().Introspect(provider,
                    new(binding.Token, operation, "GET", input.Path, input.BodyHash), default);
                Assert.Equal(consumer.Id, actor.CallerAppId);
            }
            else
                Assert.Contains("invalid_input", await response.Content.ReadAsStringAsync());
        }
    }

    [Theory]
    [InlineData("cancelled")]
    [InlineData("failed")]
    [InlineData("completed")]
    public async Task ExpiredExecutionCanSettleOwnDecisionMetadataWithoutAdmittingNewEffects(string terminalState)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var apps = host.Services.GetRequiredService<AppRegistryStore>(); var now = DateTimeOffset.UtcNow;
        var user = new HostUserRecord("owner", "owner@example.test", "Owner", "host.admin", false, now, now);
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1, [user], [], [], []));
        var consumer = Record("other.consumer", now) with { GrantedCorePermissions = [CoreAppPermissions.AgentProviders] };
        var provider = Record("other.provider", now) with { RuntimeState = "running", ConfirmedRoles = ["agent"],
            GrantedCorePermissions = [CoreAppPermissions.DecisionsRead, CoreAppPermissions.DecisionsRequest, CoreAppPermissions.DecisionsRespond],
            Endpoints = [new("api", "http", "http://127.0.0.1:3999", true)],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["agent"] = [new("native", "api", "/api/agent/v2", 2, [])] } };
        await apps.UpsertAppAsync(consumer); await apps.UpsertAppAsync(provider);
        var credential = await BrowserAuthorityFixture.Grant(host, consumer.Id, user.Id);
        var agent = host.Services.GetRequiredService<CoreAgentExecution>();
        var sessionId = Guid.NewGuid().ToString(); var runId = Guid.NewGuid().ToString();
        var request = new CoreAgentAuthorizeRequest(new(provider.Id, PanelIdentity.Installation(provider), "native"), "runs.start", "PUT",
            $"/sessions/{sessionId}/runs/{runId}", new string('d', 64), SessionId: sessionId, RunId: runId);
        var binding = await agent.Authorize(consumer, credential.AccessToken, request, default);
        await agent.Admit(provider, binding.AdmissionRef, default);
        var decisions = host.Services.GetRequiredService<CoreDecisionService>();
        var decisionInput = new HostyDecisionCreate(Guid.NewGuid().ToString(), new("original-question", "Input required", [new("q", "Continue?")]));
        var created = await decisions.CreateAsync(await agent.DecisionCaller(provider, binding.AdmissionRef, default), decisionInput);
        var other = await decisions.CreateAsync(new(user, "another-source", provider, null), decisionInput with { RequestId = Guid.NewGuid().ToString(), Input = decisionInput.Input with { CorrelationKey = "another-question" } });
        var source = await agent.DecisionCaller(provider, binding.AdmissionRef, default);
        var running = await decisions.CreateAsync(source, decisionInput with { RequestId = Guid.NewGuid().ToString(), Input = decisionInput.Input with { CorrelationKey = "running-question" } });
        running = await decisions.ResolveAsync(new(user, "operator", null, null, true), running.Id,
            new(Guid.NewGuid().ToString(), running.Revision, new Dictionary<string, HostyDecisionAnswer> { ["q"] = new(Text: "Yes") }));
        running = await decisions.AckAsync(source, running.Id, new(Guid.NewGuid().ToString(), running.Resolution!.Revision));
        var continuation = Guid.NewGuid().ToString();
        running = await decisions.ContinueAsync(source, running.Id, new(Guid.NewGuid().ToString(), continuation, running.Continuation!.Revision, "admitted"));
        running = await decisions.ContinueAsync(source, running.Id, new(Guid.NewGuid().ToString(), continuation, running.Continuation!.Revision, "running"));
        await host.Services.GetRequiredService<CoreAgentAuthorizationStore>().Change(binding.AdmissionRef, row => row with { ExpiresAt = now.AddMinutes(-1) }, default);
        var retained = await agent.DecisionCaller(provider, binding.AdmissionRef, default, metadataOnly: true);
        Assert.Equal(created.Id, (await decisions.GetAsync(retained, created.Id)).Id);
        await Assert.ThrowsAsync<CoreProviderException>(() => decisions.GetAsync(retained, other.Id));
        await Assert.ThrowsAsync<AppIdentityException>(() => decisions.CreateAsync(retained, decisionInput));
        await Assert.ThrowsAsync<AppIdentityException>(() => agent.DecisionCaller(provider, binding.AdmissionRef, default));
        using var http = host.CreateClient();
        http.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(provider.Id));
        http.DefaultRequestHeaders.Add(CoreAgentExecution.ExecutionHeader, binding.AdmissionRef);
        var root = $"/api/internal/apps/{provider.Id}/decisions/v1";
        Assert.Equal(HttpStatusCode.OK, (await http.GetAsync(root + "/requests/" + created.Id)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await http.PostAsJsonAsync(root + "/requests", decisionInput)).StatusCode);
        var resolved = await decisions.ResolveAsync(new(user, "operator", null, null, true), created.Id,
            new(Guid.NewGuid().ToString(), created.Revision, new Dictionary<string, HostyDecisionAnswer> { ["q"] = new(Text: "Yes") }));
        var ack = await http.PostAsJsonAsync(root + "/responses/" + created.Id + "/ack", new HostyDecisionAck(Guid.NewGuid().ToString(), resolved.Resolution!.Revision));
        Assert.Equal(HttpStatusCode.OK, ack.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await http.PostAsJsonAsync(root + "/requests/" + created.Id + "/resolve",
            new HostyDecisionResolve(Guid.NewGuid().ToString(), resolved.Revision, new Dictionary<string, HostyDecisionAnswer> { ["q"] = new(Text: "Again") }))).StatusCode);
        var late = new HostyDecisionContinue(Guid.NewGuid().ToString(), continuation, running.Continuation!.Revision, terminalState,
            terminalState == "cancelled" ? "cancelled" : terminalState == "failed" ? "provider_failed" : null);
        var reportRoute = root + "/requests/" + running.Id + "/continuation";
        var report = await http.PostAsJsonAsync(reportRoute, late);
        Assert.Equal(HttpStatusCode.OK, report.StatusCode);
        var reportedJson = await report.Content.ReadAsStringAsync();
        var settled = JsonSerializer.Deserialize(reportedJson, CoreJson.TypeInfo<HostyDecisionRecord>());
        Assert.Equal(terminalState, settled!.Continuation!.State);
        Assert.Equal(reportedJson, await (await http.PostAsJsonAsync(reportRoute, late)).Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.NotFound, (await http.PostAsJsonAsync(root + "/requests/" + other.Id + "/continuation", late)).StatusCode);
        await Assert.ThrowsAsync<AppIdentityException>(() => agent.DecisionCaller(provider with { Id = "different.provider" }, binding.AdmissionRef, default, metadataOnly: true));
        await Assert.ThrowsAsync<AppIdentityException>(() => agent.DecisionCaller(provider with { InstalledAt = now.AddSeconds(1) }, binding.AdmissionRef, default, metadataOnly: true));
        await Assert.ThrowsAsync<AppIdentityException>(() => agent.Admit(provider, binding.AdmissionRef, default));
        await Assert.ThrowsAsync<AppIdentityException>(() => agent.Renew(provider, binding.AdmissionRef, default));
        await Assert.ThrowsAsync<AppIdentityException>(() => agent.McpToken(provider, new(binding.AdmissionRef, new("core")), default));
    }

    [Fact]
    public async Task HistoryDeliveryAuthenticatesBothInstallationsIndependentlyOfBrowserSessions()
    {
        var clock = new TestClock(DateTimeOffset.UtcNow);
        await using var host = await CoreHttpHarness.StartAsync(clock);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var tokens = host.Services.GetRequiredService<AppServiceTokenService>();
        var consumer = Record("consumer.one", clock.UtcNow) with { GrantedCorePermissions = [CoreAppPermissions.AgentProviders] };
        var otherConsumer = consumer with { Id = "consumer.two" };
        var provider = Record("independent.runtime", clock.UtcNow) with
        {
            RuntimeState = "running", ConfirmedRoles = ["agent"],
            Endpoints = [new("api", "http", "http://127.0.0.1:3999", true)],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["agent"] = [new("native", "api", "/api/agent/v2", 2, [])] },
        };
        var otherProvider = provider with { Id = "other.runtime" };
        foreach (var app in new[] { consumer, otherConsumer, provider, otherProvider }) await apps.UpsertAppAsync(app);
        using var http = host.CreateClient();
        var reference = new HostyProviderRef(provider.Id, PanelIdentity.Installation(provider), "native");
        async Task<HttpResponseMessage> Post(string targetApp, string serviceApp, string operation, object body)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/internal/apps/{targetApp}/agent/{operation}")
                { Content = JsonContent.Create(body) };
            request.Headers.Authorization = new("Bearer", tokens.CreateToken(serviceApp));
            return await http.SendAsync(request);
        }
        async Task<CoreAgentHistoryBinding> Issue(AppRecord caller)
        {
            using var response = await Post(caller.Id, caller.Id, "history/token", new CoreAgentHistoryRequest(reference));
            response.EnsureSuccessStatusCode();
            return (await response.Content.ReadFromJsonAsync<CoreAgentHistoryBinding>())!;
        }
        Task<HttpResponseMessage> Inspect(CoreAgentHistoryBinding binding, string key = "native") =>
            Post(provider.Id, provider.Id, "history/introspect", new CoreAgentHistoryIntrospection(binding.Token, key));

        var first = await Issue(consumer);
        var second = await Issue(otherConsumer);
        foreach (var (caller, binding) in new[] { (consumer, first), (otherConsumer, second) })
        {
            using var response = await Inspect(binding);
            response.EnsureSuccessStatusCode();
            var identity = (await response.Content.ReadFromJsonAsync<CoreAgentHistoryInvocation>())!;
            Assert.Equal(caller.Id, identity.CallerAppId);
            Assert.Equal(caller.InstalledAt.ToString("O"), identity.CallerInstallation);
            Assert.Equal(reference, identity.Provider);
            Assert.Equal(clock.UtcNow.AddHours(4), identity.ExpiresAt);
            Assert.Equal(binding.ExpiresAt, identity.ExpiresAt);
            Assert.Equal("http://127.0.0.1:3999/api/agent/v2", binding.Endpoint);
        }
        using var impersonation = await Post(consumer.Id, otherConsumer.Id, "history/token", new CoreAgentHistoryRequest(reference));
        Assert.Equal(HttpStatusCode.Unauthorized, impersonation.StatusCode);
        using var wrongAudience = await Post(otherProvider.Id, otherProvider.Id, "history/introspect", new CoreAgentHistoryIntrospection(first.Token, "native"));
        Assert.Equal(HttpStatusCode.Unauthorized, wrongAudience.StatusCode);
        using var wrongKey = await Inspect(first, "another");
        Assert.Equal(HttpStatusCode.Unauthorized, wrongKey.StatusCode);
        using var execution = await Post(provider.Id, provider.Id, "introspect",
            new CoreAgentIntrospection(first.Token, "runs.cancel", "POST", $"/runs/{Guid.NewGuid()}/cancel", new string('0', 64)));
        Assert.Equal(HttpStatusCode.Unauthorized, execution.StatusCode);

        await apps.UpsertAppAsync(consumer with { GrantedCorePermissions = [] });
        using var revoked = await Inspect(first);
        Assert.Equal(HttpStatusCode.Forbidden, revoked.StatusCode);
        using var cannotRenew = await Post(consumer.Id, consumer.Id, "history/token", new CoreAgentHistoryRequest(reference));
        Assert.Equal(HttpStatusCode.Forbidden, cannotRenew.StatusCode);
        using var unrelated = await Inspect(second);
        Assert.Equal(HttpStatusCode.OK, unrelated.StatusCode);
        await apps.UpsertAppAsync(consumer with { InstalledAt = clock.UtcNow.AddMinutes(1) });
        using var reinstalled = await Inspect(first);
        Assert.Equal(HttpStatusCode.Forbidden, reinstalled.StatusCode);
        await apps.UpsertAppAsync(provider with { PermissionRevision = "changed" });
        using var staleProvider = await Inspect(second);
        Assert.Equal(HttpStatusCode.Unauthorized, staleProvider.StatusCode);
        var current = await Issue(otherConsumer);
        clock.UtcNow = current.ExpiresAt;
        using var expired = await Inspect(current);
        Assert.Equal(HttpStatusCode.Unauthorized, expired.StatusCode);
    }

    private sealed class TestClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow { get; set; } = now;
    }

    private static AppRecord Record(string id, DateTimeOffset now) => new(id, id, null, "0.1.0", "runtime", false, "installed", null, null,
        "local", "installed", "stopped", null, null, [], new Dictionary<string, AppSettingValue>(), [], [], [], now, now);
}
