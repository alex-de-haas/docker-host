using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class SandboxHttpTests
{
    [Fact]
    public async Task RecoveryRevokesOrphanBrowserJournalEvenBeforeAContainerWasRecorded()
    {
        await using var fixture = await Fixture.Create();
        var view = await fixture.ReadyWithUser();
        var instance = (await fixture.Store.ReadAsync(view.Id, default))!;
        var job = Guid.NewGuid().ToString("N");
        var login = await fixture.Realm.ProvisionAsync(new("actor"), instance.Id, instance.Users.Single().Id, job, default);
        var path = Path.Combine(fixture.Store.DataPath(instance.Id, "evidence"), job + ".json");
        await JsonStorage.WriteAsync(path, new SandboxBrowserJournal("request-hash", new(job, instance.Id, instance.Generation,
            instance.DataRevision, instance.Input.Digest, instance.Users.Single().Id, "running", DateTimeOffset.UtcNow)), true, default);
        var browser = fixture.Host.Services.GetRequiredService<SandboxBrowser>();
        var gate = fixture.Store.Gate(instance.Id); await gate.WaitAsync();
        try { await browser.RecoverLockedAsync(instance, default); }
        finally { gate.Release(); }
        var journal = (await JsonStorage.ReadAsync<SandboxBrowserJournal>(path, default))!;
        Assert.Equal("unknown", journal.Report.State);
        Assert.Equal("sandbox_browser_interrupted", journal.Report.ErrorCode);
        await Assert.ThrowsAsync<SandboxException>(() => fixture.Realm.LoginAsync(instance.Id, login.LoginId, login.Password,
            AuthCodeProof.Challenge, view.PreviewUrl + "/_hosty/callback", new('a', 64), default));
        Assert.Equal("ready", (await fixture.Store.ReadAsync(instance.Id, default))!.State);
    }

    [Fact]
    public async Task CrossClientInspectionAndOperationRequireExplicitOperatorPermissions()
    {
        await using var fixture = await Fixture.Create();
        var instance = await fixture.Prepare();
        using var inspector = await AppManagementHttpTests.CreateAppClient(fixture.Host, "inspector", [CoreAppPermissions.SandboxesRead, CoreAppPermissions.SandboxesManage]);
        Assert.Equal(HttpStatusCode.Forbidden, (await inspector.GetAsync("/api/sandbox-instances")).StatusCode);
        var apps = fixture.Host.Services.GetRequiredService<AppRegistryStore>();
        var app = (await apps.GetAppAsync("inspector"))!;
        await apps.UpsertAppAsync(app with { GrantedCorePermissions = [CoreAppPermissions.SandboxesInspect] });
        var response = await inspector.GetAsync("/api/sandbox-instances"); response.EnsureSuccessStatusCode();
        Assert.Contains((await response.Content.ReadFromJsonAsync<SandboxInventory>())!.Instances, item => item.Id == instance.Id);
        (await inspector.GetAsync("/api/sandbox-instances/" + instance.Id + "/diagnostics")).EnsureSuccessStatusCode();
        var command = new SandboxCommand(Guid.NewGuid().ToString(), instance.Revision);
        Assert.Equal(HttpStatusCode.Forbidden, (await inspector.PostAsJsonAsync("/api/sandbox-instances/" + instance.Id + "/operations/dispose", command)).StatusCode);
        await apps.UpsertAppAsync(app with { GrantedCorePermissions = [CoreAppPermissions.SandboxesInspect, CoreAppPermissions.SandboxesOperate] });
        (await inspector.PostAsJsonAsync("/api/sandbox-instances/" + instance.Id + "/operations/dispose", command)).EnsureSuccessStatusCode();
        Assert.Null(await fixture.Store.ReadAsync(instance.Id, default));
    }

    [Fact]
    public async Task IndependentClient_CompletesLifecycleWithoutWorkspace_AndCannotCrossOwners()
    {
        await using var fixture = await Fixture.Create();
        var instance = await fixture.Prepare();
        Assert.Equal("appArtifact", instance.Source.Kind);
        Assert.Null(instance.Context);
        Assert.False(Directory.Exists(Path.Combine(fixture.Host.Services.GetRequiredService<CoreDataPaths>().CoreRoot, "development")));
        instance = await fixture.Command(instance, "start");
        Assert.Equal("ready", instance.State);
        using var intruder = fixture.Host.CreateClient();
        intruder.DefaultRequestHeaders.Authorization = new("Bearer", fixture.Host.Services.GetRequiredService<AppServiceTokenService>().CreateToken("another.client"));
        intruder.DefaultRequestHeaders.Add("X-Hosty-User-Token", fixture.Client.DefaultRequestHeaders.GetValues("X-Hosty-User-Token").Single());
        Assert.Equal(HttpStatusCode.Forbidden, (await intruder.GetAsync("/api/internal/apps/another.client/sandbox-instances/" + instance.Id)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await intruder.GetAsync("/api/internal/apps/another.client/sandbox-instances/" + instance.Id + "/diagnostics")).StatusCode);
        instance = await fixture.Command(instance, "stop");
        Assert.Equal("stopped", instance.State);
        instance = await fixture.Command(instance, "dispose");
        Assert.Equal("disposed", instance.State);
        Assert.False(Directory.Exists(fixture.Store.DataRoot(instance.Id)));
        Assert.False(Directory.Exists(fixture.Store.InstanceRoot(instance.Id)));
    }

    [Fact]
    public async Task SandboxAdministrator_UsesActualLoginAndPkce_AndCannotBecomeCoreActor()
    {
        await using var fixture = await Fixture.Create();
        var instance = await fixture.ReadyWithUser();
        var grant = await fixture.Login(instance);
        using var app = fixture.RuntimeClient(instance);
        using var response = await app.PostAsJsonAsync(fixture.Runtime(instance, "revalidate"), new { accessToken = grant });
        response.EnsureSuccessStatusCode();
        var identity = (await response.Content.ReadFromJsonAsync<SandboxIdentity>())!;
        Assert.Equal("sandbox", identity.IdentityRealm);
        Assert.Equal("admin", identity.AppRole);
        Assert.Null(identity.HostRole);
        Assert.Equal(instance.Id, identity.RuntimeInstanceId);
        using var core = fixture.Host.CreateClient();
        core.DefaultRequestHeaders.Authorization = new("Bearer", grant);
        Assert.Equal(HttpStatusCode.Unauthorized, (await core.GetAsync("/api/users")).StatusCode);
        core.DefaultRequestHeaders.Authorization = new("Bearer", fixture.Credentials.Create((await fixture.Store.ReadAsync(instance.Id, default))!));
        core.DefaultRequestHeaders.Add("X-Hosty-User-Token", grant);
        Assert.Equal(HttpStatusCode.Unauthorized, (await core.GetAsync(Fixture.Root)).StatusCode);
        Assert.Null(fixture.Host.Services.GetRequiredService<AppServiceTokenService>().ResolveAppId(core.DefaultRequestHeaders.Authorization.Parameter!));
        using var global = await app.PostAsJsonAsync("/api/auth/apps/revalidate", new { accessToken = grant });
        Assert.False(global.IsSuccessStatusCode);
        Assert.DoesNotContain((await fixture.Host.Services.GetRequiredService<UserDirectoryStore>().ReadAsync()).Users, u => u.Id == identity.UserId);
    }

    [Fact]
    public async Task InstanceServiceAndUserGrants_RejectSiblingGenerationAndUpdatedSubject()
    {
        await using var fixture = await Fixture.Create();
        var first = await fixture.ReadyWithUser();
        var second = await fixture.ReadyWithUser();
        var grant = await fixture.Login(first);
        using var a = fixture.RuntimeClient(first);
        using var b = fixture.RuntimeClient(second);
        Assert.Equal(HttpStatusCode.Unauthorized, (await a.PostAsJsonAsync(fixture.Runtime(second, "revalidate"), new { accessToken = grant })).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await b.PostAsJsonAsync(fixture.Runtime(second, "revalidate"), new { accessToken = grant })).StatusCode);
        using var change = await fixture.Client.PostAsJsonAsync(Fixture.Root + "/" + first.Id + "/users",
            new SandboxUserRequest(Guid.NewGuid().ToString(), first.Revision, "administrator", "Changed role", "member"));
        change.EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.Forbidden, (await a.PostAsJsonAsync(fixture.Runtime(first, "revalidate"), new { accessToken = grant })).StatusCode);
        first = (await change.Content.ReadFromJsonAsync<SandboxView>())!;
        var newGrant = await fixture.Login(first);
        first = await fixture.Command(first, "restart");
        Assert.Equal(HttpStatusCode.Unauthorized, (await a.PostAsJsonAsync(fixture.Runtime(first, "revalidate"), new { accessToken = newGrant })).StatusCode);
        using var freshService = fixture.RuntimeClient(first);
        Assert.Equal(HttpStatusCode.Unauthorized, (await freshService.PostAsJsonAsync(fixture.Runtime(first, "revalidate"), new { accessToken = newGrant })).StatusCode);
    }

    [Fact]
    public async Task PasswordAndCodeAreSingleUse_ProofAndOriginAreRequired()
    {
        await using var fixture = await Fixture.Create();
        var instance = await fixture.ReadyWithUser();
        var secret = await fixture.Realm.ProvisionAsync(new("actor"), instance.Id, instance.Users.Single().Id, "job", default);
        using var runtime = fixture.RuntimeClient(instance);
        var record = (await fixture.Store.ReadAsync(instance.Id, default))!;
        runtime.DefaultRequestHeaders.Add("X-Hosty-Sandbox-Origin", record.AuthOrigin);
        var form = new Dictionary<string, string> { ["loginId"] = secret.LoginId, ["password"] = secret.Password,
            ["codeChallenge"] = AuthCodeProof.Challenge, ["state"] = new('a', 64), ["redirectUri"] = record.PreviewUrl + "/_hosty/callback" };
        Assert.Equal(HttpStatusCode.Forbidden, (await runtime.PostAsync(fixture.Runtime(instance, "browser/login"), new FormUrlEncodedContent(form))).StatusCode);
        using var page = await runtime.GetAsync(fixture.Runtime(instance, "browser/login") + "?codeChallenge=" + AuthCodeProof.Challenge
            + "&state=" + new string('a', 64) + "&redirectUri=" + Uri.EscapeDataString(record.PreviewUrl + "/_hosty/callback"));
        page.EnsureSuccessStatusCode();
        Assert.Equal("origin", page.Headers.GetValues("Referrer-Policy").Single());
        Assert.Contains("form-action 'self' " + new Uri(record.PreviewUrl!).GetLeftPart(UriPartial.Authority) + ";", page.Headers.GetValues("Content-Security-Policy").Single());
        runtime.DefaultRequestHeaders.Add("Origin", record.AuthOrigin);
        using var login = await runtime.PostAsync(fixture.Runtime(instance, "browser/login"), new FormUrlEncodedContent(form));
        Assert.Equal(HttpStatusCode.Found, login.StatusCode);
        Assert.False(login.Headers.Contains("Set-Cookie"));
        Assert.Equal(HttpStatusCode.Unauthorized, (await runtime.PostAsync(fixture.Runtime(instance, "browser/login"), new FormUrlEncodedContent(form))).StatusCode);
        var code = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(login.Headers.Location!.Query)["code"].ToString();
        Assert.Equal(HttpStatusCode.Unauthorized, (await runtime.PostAsJsonAsync(fixture.Runtime(instance, "token"), new SandboxCodeRequest(code, new('z', 43)))).StatusCode);
        (await runtime.PostAsJsonAsync(fixture.Runtime(instance, "token"), new SandboxCodeRequest(code, AuthCodeProof.Verifier))).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.Unauthorized, (await runtime.PostAsJsonAsync(fixture.Runtime(instance, "token"), new SandboxCodeRequest(code, AuthCodeProof.Verifier))).StatusCode);
    }

    [Fact]
    public async Task DirectoryRequiresUserGrant_AndContainsNoUnrelatedCoreUsers()
    {
        await using var fixture = await Fixture.Create();
        var instance = await fixture.ReadyWithUser();
        using var runtime = fixture.RuntimeClient(instance);
        Assert.Equal(HttpStatusCode.Unauthorized, (await runtime.GetAsync(fixture.Runtime(instance, "directory"))).StatusCode);
        runtime.DefaultRequestHeaders.Add("X-Hosty-User-Token", await fixture.Login(instance));
        using var response = await runtime.GetAsync(fixture.Runtime(instance, "directory"));
        response.EnsureSuccessStatusCode();
        var body = (await response.Content.ReadFromJsonAsync<SandboxDirectory>())!;
        Assert.Single(body.Users);
        Assert.All(body.Users, u => Assert.Equal("sandbox", u.IdentityRealm));
        Assert.DoesNotContain(body.Users, u => u.UserId == "actor");
    }

    [Fact]
    public async Task OwnerRevocation_DeniesRuntimeImmediately_AndBrowserMutationsRequireCsrf()
    {
        await using var fixture = await Fixture.Create();
        var instance = await fixture.ReadyWithUser();
        var grant = await fixture.Login(instance);
        using var runtime = fixture.RuntimeClient(instance);
        using var browser = fixture.Host.CreateClient();
        browser.DefaultRequestHeaders.Add("Cookie", "hosty_session=operator");
        Assert.Equal(HttpStatusCode.Forbidden, (await browser.PostAsJsonAsync("/api/sandbox-instances/" + instance.Id + "/operations/dispose",
            new SandboxCommand(Guid.NewGuid().ToString(), instance.Revision))).StatusCode);
        var users = fixture.Host.Services.GetRequiredService<UserDirectoryStore>();
        var state = await users.ReadAsync();
        await users.WriteAsync(state with { Users = state.Users.Select(u => u with { Disabled = true }).ToArray() });
        Assert.Equal(HttpStatusCode.Forbidden, (await runtime.PostAsJsonAsync(fixture.Runtime(instance, "revalidate"), new { accessToken = grant })).StatusCode);
    }

    [Fact]
    public async Task PreviewViewerAclDoesNotGrantControl_AndRemovalRevokesTheRealmGrant()
    {
        await using var fixture = await Fixture.Create();
        var instance = await fixture.ReadyWithUser();
        var users = fixture.Host.Services.GetRequiredService<UserDirectoryStore>();
        var state = await users.ReadAsync();
        var viewer = state.Users.Single() with { Id = "viewer", Email = "viewer@example.test", Role = "host.user" };
        await users.WriteAsync(state with { Users = state.Users.Append(viewer).ToArray() });
        using var response = await fixture.Client.PostAsJsonAsync(Fixture.Root + "/" + instance.Id + "/viewers",
            new SandboxViewersRequest(Guid.NewGuid().ToString(), instance.Revision, [viewer.Id]));
        response.EnsureSuccessStatusCode(); instance = (await response.Content.ReadFromJsonAsync<SandboxView>())!;
        var redirect = await fixture.Realm.AuthorizeOperatorAsync(instance.Id, viewer.Id, AuthCodeProof.Challenge,
            instance.PreviewUrl + "/_hosty/callback", new('a', 64), default);
        var code = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(new Uri(redirect).Query)["code"].ToString();
        var token = await fixture.Realm.ExchangeAsync(instance.Id, new(code, AuthCodeProof.Verifier), default);
        var identity = await fixture.Realm.RevalidateAsync(instance.Id, token.AccessToken, default);
        Assert.Equal("core", identity.IdentityRealm); Assert.Equal("host.user", identity.HostRole);
        Assert.Equal(403, (await Assert.ThrowsAsync<SandboxException>(() => fixture.Host.Services.GetRequiredService<SandboxService>()
            .ReadAsync(new(viewer.Id), instance.Id, default))).Status);
        using var removed = await fixture.Client.PostAsJsonAsync(Fixture.Root + "/" + instance.Id + "/viewers",
            new SandboxViewersRequest(Guid.NewGuid().ToString(), instance.Revision, []));
        removed.EnsureSuccessStatusCode();
        await Assert.ThrowsAsync<SandboxException>(() => fixture.Realm.RevalidateAsync(instance.Id, token.AccessToken, default));
    }

    [Fact]
    public async Task DeletingTemporaryUserRevokesExistingGrantsWithoutTouchingRealUsers()
    {
        await using var fixture = await Fixture.Create();
        var instance = await fixture.ReadyWithUser(); var grant = await fixture.Login(instance);
        using var response = await fixture.Client.PostAsJsonAsync(Fixture.Root + "/" + instance.Id + "/users/delete",
            new SandboxUserDeleteRequest(Guid.NewGuid().ToString(), instance.Revision, instance.Users.Single().Id));
        response.EnsureSuccessStatusCode();
        Assert.Empty((await response.Content.ReadFromJsonAsync<SandboxView>())!.Users);
        await Assert.ThrowsAsync<SandboxException>(() => fixture.Realm.RevalidateAsync(instance.Id, grant, default));
        Assert.Single((await fixture.Host.Services.GetRequiredService<UserDirectoryStore>().ReadAsync()).Users);
    }

    [Fact]
    public async Task ExplicitBackgroundSandboxScopePinsInputsActionsAndOwner_AndRevokesOnline()
    {
        await using var fixture = await Fixture.Create();
        var background = fixture.Host.Services.GetRequiredService<BackgroundGrantService>();
        var grant = await background.CreateAsync("actor", new("qa.client", "Independent QA",
            [new("qa", "sandbox", "demo.app", ["plan", "prepare", "read", "start", "stop", "dispose"],
                Sandbox: new(new('a', 64), new()))]), default);
        var token = await background.IssueAsync("qa.client", new(grant.Id, "qa"), default);
        fixture.Client.DefaultRequestHeaders.Remove("X-Hosty-User-Token");
        fixture.Client.DefaultRequestHeaders.Add("X-Hosty-User-Token", token.AccessToken);
        using var denied = await fixture.Client.PostAsJsonAsync(Fixture.Root + "/plans",
            new SandboxPlanRequest("demo.app", "sandbox", new("appArtifact", ArtifactDigest: new('b', 64))));
        Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        using var planned = await fixture.Client.PostAsJsonAsync(Fixture.Root + "/plans",
            new SandboxPlanRequest("demo.app", "sandbox", new("appArtifact", ArtifactDigest: new('a', 64))));
        planned.EnsureSuccessStatusCode(); var plan = (await planned.Content.ReadFromJsonAsync<SandboxPlan>())!;
        using var prepared = await fixture.Client.PostAsJsonAsync(Fixture.Root, new SandboxPrepareRequest(Guid.NewGuid().ToString(), plan.Id, plan.Digest));
        prepared.EnsureSuccessStatusCode(); var instance = (await prepared.Content.ReadFromJsonAsync<SandboxView>())!;
        Assert.Equal(grant.Id, instance.Owner.GrantId); Assert.Null(instance.Context);
        instance = await fixture.Command(instance, "start");
        using var deniedUser = await fixture.Client.PostAsJsonAsync(Fixture.Root + "/" + instance.Id + "/users",
            new SandboxUserRequest(Guid.NewGuid().ToString(), instance.Revision, "admin", "Test", "admin"));
        Assert.Equal(HttpStatusCode.Forbidden, deniedUser.StatusCode);
        await background.RevokeAsync("actor", grant.Id, default);
        Assert.False((await fixture.Client.GetAsync(Fixture.Root + "/" + instance.Id)).IsSuccessStatusCode);
        var stored = (await fixture.Store.ReadAsync(instance.Id, default))!;
        await Assert.ThrowsAsync<SandboxException>(() => fixture.Credentials.RequireAsync(instance.Id, fixture.Credentials.Create(stored), default));
        var service = fixture.Host.Services.GetRequiredService<SandboxService>();
        var disposed = await service.CommandAsync(new("actor"), instance.Id, "dispose", new(Guid.NewGuid().ToString(), instance.Revision), default);
        Assert.Equal("disposed", disposed.State);
    }

    [Fact]
    public async Task OperatorPersonaConfirmationIsSessionBoundSingleUseAndInstanceOnly()
    {
        await using var fixture = await Fixture.Create(); var instance = await fixture.ReadyWithUser();
        var actor = (await fixture.Host.Services.GetRequiredService<UserDirectoryStore>().ReadAsync()).Users.Single();
        var choice = await fixture.Realm.BeginPersonaAsync(instance.Id, actor, "session-a", instance.Users.Single().Id,
            AuthCodeProof.Challenge, instance.PreviewUrl + "/_hosty/callback", new('a', 64), default);
        await Assert.ThrowsAsync<SandboxException>(() => fixture.Realm.ConfirmPersonaAsync(instance.Id, actor, "session-b", choice.Nonce, default));
        var redirect = await fixture.Realm.ConfirmPersonaAsync(instance.Id, actor, "session-a", choice.Nonce, default);
        await Assert.ThrowsAsync<SandboxException>(() => fixture.Realm.ConfirmPersonaAsync(instance.Id, actor, "session-a", choice.Nonce, default));
        var code = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(new Uri(redirect).Query)["code"].ToString();
        var grant = await fixture.Realm.ExchangeAsync(instance.Id, new(code, AuthCodeProof.Verifier), default);
        var identity = await fixture.Realm.RevalidateAsync(instance.Id, grant.AccessToken, default);
        Assert.Equal("sandbox", identity.IdentityRealm); Assert.Null(identity.HostRole);
        Assert.Equal(instance.Users.Single().Id, identity.UserId);
        var retained = (await fixture.Host.Services.GetRequiredService<UserDirectoryStore>().ReadAsync()).Users.Single();
        Assert.Equal(actor, retained);
        using var outsider = fixture.Host.CreateClient();
        Assert.False((await outsider.PostAsync("/api/sandbox-instances/" + instance.Id + "/persona/confirm",
            new FormUrlEncodedContent(new Dictionary<string, string> { ["nonce"] = choice.Nonce }))).IsSuccessStatusCode);
    }

    private sealed class Fixture(CoreHttpHarness host, HttpClient client) : IAsyncDisposable
    {
        internal const string Root = "/api/internal/apps/qa.client/sandbox-instances";
        public CoreHttpHarness Host => host;
        public HttpClient Client => client;
        public SandboxStore Store => host.Services.GetRequiredService<SandboxStore>();
        public SandboxRealm Realm => host.Services.GetRequiredService<SandboxRealm>();
        public SandboxServiceCredentials Credentials => host.Services.GetRequiredService<SandboxServiceCredentials>();
        public static async Task<Fixture> Create()
        {
            var host = await CoreHttpHarness.StartAsync(configure: services =>
            {
                services.RemoveAll<ISandboxRuntime>(); services.AddSingleton<ISandboxRuntime, Runtime>();
                services.RemoveAll<ISandboxInputs>(); services.AddSingleton<ISandboxInputs, Inputs>();
            });
            var client = await AppManagementHttpTests.CreateAppClient(host, "qa.client", [CoreAppPermissions.SandboxesRead, CoreAppPermissions.SandboxesManage]);
            var token = client.DefaultRequestHeaders.GetValues(AppManagementAuthorization.IdentityHeader).Single();
            client.DefaultRequestHeaders.Remove(AppManagementAuthorization.IdentityHeader);
            client.DefaultRequestHeaders.Add("X-Hosty-User-Token", token);
            var apps = host.Services.GetRequiredService<AppRegistryStore>();
            var app = (await apps.GetAppAsync("qa.client"))!;
            await apps.UpsertAppAsync(app with { Id = "demo.app" });
            return new(host, client);
        }
        public async Task<SandboxView> Prepare()
        {
            using var response = await client.PostAsJsonAsync(Root + "/plans", new SandboxPlanRequest("demo.app", "sandbox", new("appArtifact")));
            response.EnsureSuccessStatusCode();
            var plan = (await response.Content.ReadFromJsonAsync<SandboxPlan>())!;
            using var prepared = await client.PostAsJsonAsync(Root, new SandboxPrepareRequest(Guid.NewGuid().ToString(), plan.Id, plan.Digest));
            prepared.EnsureSuccessStatusCode(); return (await prepared.Content.ReadFromJsonAsync<SandboxView>())!;
        }
        public async Task<SandboxView> Command(SandboxView instance, string kind)
        {
            var requestId = Guid.NewGuid().ToString();
            using var response = await client.PostAsJsonAsync(Root + "/" + instance.Id + "/operations/" + kind, new SandboxCommand(requestId, instance.Revision));
            response.EnsureSuccessStatusCode();
            var observed = (await response.Content.ReadFromJsonAsync<SandboxView>())!;
            // The HTTP contract can acknowledge a durable operation before it completes.
            // Do not depend on the fake runtime finishing within the first 200 ms under load.
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            while (observed.Operations.Single(o => o.Id == requestId).State == "running")
            {
                await Task.Delay(20, timeout.Token);
                observed = (await client.GetFromJsonAsync<SandboxView>(Root + "/" + instance.Id, timeout.Token))!;
            }
            Assert.Equal("succeeded", observed.Operations.Single(o => o.Id == requestId).State);
            return observed;
        }
        public async Task<SandboxView> ReadyWithUser()
        {
            var instance = await Prepare();
            using var response = await client.PostAsJsonAsync(Root + "/" + instance.Id + "/users", new SandboxUserRequest(Guid.NewGuid().ToString(), instance.Revision, "administrator", "Test administrator", "admin"));
            response.EnsureSuccessStatusCode(); return await Command((await response.Content.ReadFromJsonAsync<SandboxView>())!, "start");
        }
        public HttpClient RuntimeClient(SandboxView instance)
        {
            var result = host.CreateClient();
            var state = Store.ReadAsync(instance.Id, default).GetAwaiter().GetResult()!;
            result.DefaultRequestHeaders.Authorization = new("Bearer", Credentials.Create(state));
            return result;
        }
        public string Runtime(SandboxView instance, string path) => "/api/sandbox-runtime/" + instance.Id + "/" + path;
        public async Task<string> Login(SandboxView instance)
        {
            var login = await Realm.ProvisionAsync(new("actor"), instance.Id, instance.Users.Single().Id, Guid.NewGuid().ToString(), default);
            var redirect = await Realm.LoginAsync(instance.Id, login.LoginId, login.Password, AuthCodeProof.Challenge,
                instance.PreviewUrl + "/_hosty/callback", new('a', 64), default);
            var code = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(new Uri(redirect).Query)["code"].ToString();
            using var runtime = RuntimeClient(instance);
            using var exchanged = await runtime.PostAsJsonAsync(Runtime(instance, "token"), new SandboxCodeRequest(code, AuthCodeProof.Verifier));
            exchanged.EnsureSuccessStatusCode(); return (await exchanged.Content.ReadFromJsonAsync<SandboxTokenResponse>())!.AccessToken;
        }
        public async ValueTask DisposeAsync() { client.Dispose(); await host.DisposeAsync(); }
    }
    private sealed class Inputs(AppRegistryStore apps) : ISandboxInputs
    {
        public async Task<SandboxResolvedInput> ResolveAsync(SandboxActor actor, SandboxPlanRequest request, CancellationToken ct)
        {
            var target = (await apps.GetAppAsync(request.AppId, ct))!;
            return new(request.AppId, target.InstalledAt, new('a', 64), new(new() { Id = request.AppId }, "/reviewed/manifest.json", new('a', 64),
                new() { Key = "sandbox", Type = "docker" }, [], null, "{}", null), null, ["admin", "member"], [], new Dictionary<string, string>(), true);
        }
        public Task AcquireAsync(SandboxInstance instance, CancellationToken ct) => Task.CompletedTask;
        public Task ReleaseAsync(SandboxInstance instance, CancellationToken ct) => Task.CompletedTask;
    }
    private sealed class Runtime : ISandboxRuntime
    {
        public Task<SandboxRuntimeStart> StartAsync(SandboxInstance instance, Func<SandboxResource, Task> record, CancellationToken ct)
        {
            var url = $"http://s-{instance.Id}.d-{instance.DataRevision}.hosty.localhost:19000";
            return Task.FromResult(new SandboxRuntimeStart(url, url.Replace("http://", "http://auth."), [new("http", url)]));
        }
        public Task StopAsync(SandboxInstance instance, CancellationToken ct) => Task.CompletedTask;
        public Task RemoveAsync(SandboxInstance instance, CancellationToken ct) => Task.CompletedTask;
        public Task<string> ObserveAsync(SandboxInstance instance, CancellationToken ct) => Task.FromResult(instance.State);
    }
}
