using System.Net;
using System.Net.Http.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class CoreEnvironmentConsentHttpTests
{
    private const string Root = "/api/internal/apps/qa.client/core-environments";
    internal static async Task Approve(CoreHttpHarness host, HttpClient caller, CoreEnvironmentCreate input, bool saved,
        string expected = "succeeded", Func<Task>? beforeDecision = null)
    {
        using var prepared = await caller.PostAsJsonAsync(Root + "/consent", input);
        Assert.True(prepared.IsSuccessStatusCode, await prepared.Content.ReadAsStringAsync());
        var view = (await prepared.Content.ReadFromJsonAsync<InstallationRequestView>())!;
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(s => s with {
            Sessions = s.Sessions.Select(session => session with { BrowserOrigin = "http://localhost" }).ToArray(),
        });
        using var browser = host.CreateClient(); browser.DefaultRequestHeaders.Add("Cookie", "hosty_session=operator");
        var html = await browser.GetStringAsync("/install/confirm/" + view.Id);
        Assert.Contains("Approve trusted Core launch", html);
        Assert.Contains("ordinary administrator rights", html);
        Assert.DoesNotContain("name=saveEnvironmentConsent value=true checked", html);
        var nonce = Regex.Match(html, "name=nonce value=\"([^\"]+)\"").Groups[1].Value;
        Assert.NotEmpty(nonce);
        if (beforeDecision is not null) await beforeDecision();
        using var request = new HttpRequestMessage(HttpMethod.Post, "/install/confirm/" + view.Id) {
            Content = new FormUrlEncodedContent(new Dictionary<string, string> {
                ["nonce"] = nonce, ["decision"] = "approve", ["saveEnvironmentConsent"] = saved ? "true" : "false",
            }), Headers = { { "Origin", "http://localhost" } },
        };
        (await browser.SendAsync(request)).EnsureSuccessStatusCode();
        var store = host.Services.GetRequiredService<InstallationApprovalStore>();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        while (store.Get(view.Id).Status == "executing") await Task.Delay(10, timeout.Token);
        Assert.True(store.Get(view.Id).Status == expected, store.Get(view.Id).Error);
        var audit = await host.Services.GetRequiredService<AuditStore>().ReadRecentAsync();
        var decision = Assert.Single(audit, entry => entry.Action == "core.environment.approval"
            && entry.Outcome == "approved" && entry.Details.GetValueOrDefault("requestId") == view.Id);
        Assert.Equal("qa.client", decision.Details["caller"]);
        Assert.Equal("core-environment", decision.Details["operation"]);
        Assert.Equal(saved.ToString(), decision.Details["environmentConsentSaved"]);
    }
    private static async Task<HttpClient> Caller(CoreHttpHarness host, string id = "qa.client")
    {
        var client = await AppManagementHttpTests.CreateAppClient(host, id,
            [CoreAppPermissions.CoreEnvironmentsRead, CoreAppPermissions.CoreEnvironmentsManage]);
        var token = client.DefaultRequestHeaders.GetValues(AppManagementAuthorization.IdentityHeader).Single();
        client.DefaultRequestHeaders.Remove(AppManagementAuthorization.IdentityHeader);
        client.DefaultRequestHeaders.Add("X-Hosty-User-Token", token); return client;
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Consent_OnlyCorePageCanChooseRunOrSaved_AndRevocationBlocksDelegatedAccess(bool saved)
    {
        await using var host = await CoreEnvironmentHttpTests.StartHostAsync(); using var caller = await Caller(host);
        var input = new CoreEnvironmentCreate(Guid.NewGuid().ToString(), "QA");
        Assert.Equal(HttpStatusCode.Forbidden, (await caller.PostAsJsonAsync(Root, input)).StatusCode);
        await Approve(host, caller, input, saved);
        using var created = await caller.PostAsJsonAsync(Root, input); created.EnsureSuccessStatusCode();
        var child = (await created.Content.ReadFromJsonAsync<CoreEnvironmentView>())!;
        Assert.Equal(saved, child.Access!.Saved); Assert.Equal("active", child.Access.State);
        using var replay = await caller.PostAsJsonAsync(Root, input); replay.EnsureSuccessStatusCode();
        Assert.Equal(child.Id, (await replay.Content.ReadFromJsonAsync<CoreEnvironmentView>())!.Id);
        using var next = await caller.PostAsJsonAsync(Root, input with { RequestId = Guid.NewGuid().ToString() });
        Assert.Equal(saved ? HttpStatusCode.OK : HttpStatusCode.Forbidden, next.StatusCode);
        var grants = host.Services.GetRequiredService<BackgroundGrantService>();
        await grants.RevokeAsync("actor", child.Access.GrantId, default);
        foreach (var action in new[] { "/operations/start", "/operations/restart", "/setup", "/api" })
        {
            object body = action == "/setup" ? new CoreEnvironmentSetup("test@example.test", "Test", "test-password-long")
                : action == "/api" ? new CoreEnvironmentApiRequest("GET", "/api/apps")
                : new CoreEnvironmentCommand(Guid.NewGuid().ToString(), child.Revision);
            Assert.Equal(HttpStatusCode.Forbidden, (await caller.PostAsJsonAsync(Root + "/" + child.Id + action, body)).StatusCode);
        }
        var current = (await caller.GetFromJsonAsync<CoreEnvironmentView>(Root + "/" + child.Id))!;
        Assert.Equal("revoked-or-unavailable", current.Access!.State);
        Assert.Equal("stopped", current.State);
        // Revocation does not remove owned resources or prevent explicit cleanup.
        var finished = await caller.PostAsJsonAsync(Root + "/" + child.Id + "/operations/finish",
            new CoreEnvironmentCommand(Guid.NewGuid().ToString(), current.Revision));
        finished.EnsureSuccessStatusCode();
        Assert.Equal("finished", (await finished.Content.ReadFromJsonAsync<CoreEnvironmentView>())!.State);
    }
    [Fact]
    public async Task ManageOnlyCaller_CanApproveAndLaunchWithoutReceivingReadAuthority()
    {
        await using var host = await CoreEnvironmentHttpTests.StartHostAsync(); using var caller = await Caller(host);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var app = (await apps.GetAppAsync("qa.client"))!;
        await apps.UpsertAppAsync(app with { GrantedCorePermissions = [CoreAppPermissions.CoreEnvironmentsManage] });
        var input = new CoreEnvironmentCreate(Guid.NewGuid().ToString(), "Manage-only QA");
        await Approve(host, caller, input, true);
        var grants = host.Services.GetRequiredService<BackgroundGrantService>();
        var grant = Assert.Single((await grants.ReadAsync(default))!.Grants);
        Assert.Equal(["manage"], Assert.Single(grant.Scopes).Actions);
        var token = await grants.IssueAsync("qa.client", new(grant.Id, "environment"), default);
        caller.DefaultRequestHeaders.Remove("X-Hosty-User-Token");
        caller.DefaultRequestHeaders.Add("X-Hosty-User-Token", token.AccessToken);
        using var created = await caller.PostAsJsonAsync(Root, input); created.EnsureSuccessStatusCode();
        Assert.Equal("stopped", (await created.Content.ReadFromJsonAsync<CoreEnvironmentView>())!.State);
        Assert.Equal(HttpStatusCode.Forbidden, (await caller.GetAsync(Root)).StatusCode);
    }
    [Theory]
    [InlineData("start", "succeeded", false)]
    [InlineData("restart", "succeeded", false)]
    [InlineData("start", "superseded", false)]
    [InlineData("restart", "superseded", false)]
    [InlineData("start", "failed", false)]
    [InlineData("restart", "failed", false)]
    [InlineData("start", "succeeded", true)]
    [InlineData("restart", "succeeded", true)]
    [InlineData("start", "superseded", true)]
    [InlineData("restart", "superseded", true)]
    [InlineData("start", "failed", true)]
    [InlineData("restart", "failed", true)]
    public async Task CommandReplay_RequiresConsentOnlyWhenItCanLaunch(string kind, string outcome, bool changeTarget)
    {
        var runtime = new PausedStartRuntime { FailPrepare = outcome != "succeeded" };
        runtime.Resume.SetResult();
        await using var host = await CoreHttpHarness.StartAsync(configure: services =>
            services.AddSingleton<ICoreEnvironmentRuntime>(runtime));
        using var caller = await Caller(host);
        var config = host.Services.GetRequiredService<HostyCoreRuntimeConfig>();
        var binary = Path.Combine(config.DataRoot, "core", "bin", OperatingSystem.IsWindows() ? "hosty-core.exe" : "hosty-core");
        Directory.CreateDirectory(Path.GetDirectoryName(binary)!); await File.WriteAllTextAsync(binary, "test release");
        var input = new CoreEnvironmentCreate(Guid.NewGuid().ToString(), "Replay QA", "release");
        await Approve(host, caller, input, true);
        using var created = await caller.PostAsJsonAsync(Root, input); created.EnsureSuccessStatusCode();
        var child = (await created.Content.ReadFromJsonAsync<CoreEnvironmentView>())!;
        var command = new CoreEnvironmentCommand(Guid.NewGuid().ToString(), child.Revision);
        var url = Root + "/" + child.Id + "/operations/" + kind;
        using var executed = await caller.PostAsJsonAsync(url, command); executed.EnsureSuccessStatusCode();
        var current = (await executed.Content.ReadFromJsonAsync<CoreEnvironmentView>())!;
        Assert.Equal(outcome == "succeeded" ? "succeeded" : "failed", Assert.Single(current.Operations).State);
        if (outcome == "superseded")
        {
            using var stopped = await caller.PostAsJsonAsync(Root + "/" + child.Id + "/operations/stop",
                new CoreEnvironmentCommand(Guid.NewGuid().ToString(), current.Revision));
            stopped.EnsureSuccessStatusCode();
            current = (await stopped.Content.ReadFromJsonAsync<CoreEnvironmentView>())!;
            Assert.Equal("stopped", current.State);
        }
        if (changeTarget) await File.WriteAllTextAsync(binary, "replacement release");
        else await host.Services.GetRequiredService<BackgroundGrantService>().RevokeAsync("actor", child.Access!.GrantId, default);
        runtime.FailPrepare = false;
        var preparations = runtime.Preparations;
        using var replay = await caller.PostAsJsonAsync(url, command);
        Assert.Equal(outcome == "failed" ? HttpStatusCode.Forbidden : HttpStatusCode.OK, replay.StatusCode);
        if (replay.IsSuccessStatusCode)
        {
            var receipt = (await replay.Content.ReadFromJsonAsync<CoreEnvironmentView>())!;
            Assert.Equal(current.State, receipt.State);
            Assert.Equal(current.Process, receipt.Process);
            Assert.Equal(current.Revision, receipt.Revision);
            Assert.Equal(current.Operations, receipt.Operations);
        }
        using var changedReplay = await caller.PostAsJsonAsync(url, command with { ExpectedRevision = current.Revision });
        Assert.Equal(HttpStatusCode.Conflict, changedReplay.StatusCode);
        using var fresh = await caller.PostAsJsonAsync(url, new CoreEnvironmentCommand(Guid.NewGuid().ToString(), current.Revision));
        Assert.Equal(HttpStatusCode.Forbidden, fresh.StatusCode);
        var persisted = (await host.Services.GetRequiredService<CoreEnvironmentStore>().ReadAsync(child.Id, default))!;
        Assert.Equal(current.Revision, persisted.Revision);
        Assert.Equal(current.Operations, persisted.Operations);
        Assert.Equal(preparations, runtime.Preparations);
    }
    [Theory]
    [InlineData(true, false)]
    [InlineData(false, false)]
    [InlineData(false, true)]
    public async Task StoredOperatorApproval_DistinguishesLegacyDelegation(bool operatorApproved, bool renew)
    {
        var runtime = new PausedStartRuntime(); runtime.Resume.SetResult();
        await using var host = await CoreHttpHarness.StartAsync(configure: services =>
            services.AddSingleton<ICoreEnvironmentRuntime>(runtime));
        using var caller = await Caller(host);
        var app = (await host.Services.GetRequiredService<AppRegistryStore>().GetAppAsync("qa.client"))!;
        var actor = new SandboxActor("actor", app.Id, app.InstalledAt);
        var service = host.Services.GetRequiredService<CoreEnvironmentService>();
        var store = host.Services.GetRequiredService<CoreEnvironmentStore>();
        var config = host.Services.GetRequiredService<HostyCoreRuntimeConfig>();
        var binary = Path.Combine(config.DataRoot, "core", "bin", OperatingSystem.IsWindows() ? "hosty-core.exe" : "hosty-core");
        Directory.CreateDirectory(Path.GetDirectoryName(binary)!); await File.WriteAllTextAsync(binary, "test release");
        var input = new CoreEnvironmentCreate(Guid.NewGuid().ToString(), "Upgrade QA", "release");
        var child = await service.CreateAsync(actor, input, default, operatorApproved: true);
        Assert.True((await store.ReadAsync(child.Id, default))!.OperatorApproved);
        if (!operatorApproved)
        {
            // A pre-upgrade record has neither field; deserialize it through the actual store.
            var json = System.Text.Json.Nodes.JsonNode.Parse(await File.ReadAllTextAsync(store.RecordPath(child.Id)))!.AsObject();
            json.Remove("consent"); json.Remove("operatorApproved");
            await File.WriteAllTextAsync(store.RecordPath(child.Id), json.ToJsonString());
            var legacy = (await store.ReadAsync(child.Id, default))!;
            Assert.False(legacy.OperatorApproved); Assert.Null(legacy.Consent);
            await service.RequireConsentAsync(new("actor"), legacy, true, default);
            foreach (var action in new[] { "/operations/start", "/operations/restart", "/setup", "/api" })
            {
                object body = action == "/setup" ? new CoreEnvironmentSetup("test@example.test", "Test", "test-password-long")
                    : action == "/api" ? new CoreEnvironmentApiRequest("GET", "/api/apps")
                    : new CoreEnvironmentCommand(Guid.NewGuid().ToString(), child.Revision);
                using var denied = await caller.PostAsJsonAsync(Root + "/" + child.Id + action, body);
                Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
            }
            Assert.Equal(0, runtime.Preparations);
            Assert.Equal("revoked-or-unavailable", (await caller.GetFromJsonAsync<CoreEnvironmentView>(Root + "/" + child.Id))!.Access!.State);
            using var stopped = await caller.PostAsJsonAsync(Root + "/" + child.Id + "/operations/stop",
                new CoreEnvironmentCommand(Guid.NewGuid().ToString(), child.Revision));
            stopped.EnsureSuccessStatusCode();
            child = (await stopped.Content.ReadFromJsonAsync<CoreEnvironmentView>())!;
            if (renew)
            {
                await Approve(host, caller, input, true);
                using var replay = await caller.PostAsJsonAsync(Root, input); replay.EnsureSuccessStatusCode();
                var renewed = (await replay.Content.ReadFromJsonAsync<CoreEnvironmentView>())!;
                Assert.Equal(child.Id, renewed.Id); Assert.Equal(child.DataRoot, renewed.DataRoot);
                Assert.Equal("active", renewed.Access!.State);
                Assert.False((await store.ReadAsync(child.Id, default))!.OperatorApproved);
                child = renewed;
            }
        }
        else Assert.Equal("operator", child.Access!.State);
        if (operatorApproved || renew)
        {
            using var started = await caller.PostAsJsonAsync(Root + "/" + child.Id + "/operations/start",
                new CoreEnvironmentCommand(Guid.NewGuid().ToString(), child.Revision));
            started.EnsureSuccessStatusCode();
            child = (await started.Content.ReadFromJsonAsync<CoreEnvironmentView>())!;
            Assert.Equal("running", child.State);
            Assert.Equal(1, runtime.Preparations);
        }
        using var finished = await caller.PostAsJsonAsync(Root + "/" + child.Id + "/operations/finish",
            new CoreEnvironmentCommand(Guid.NewGuid().ToString(), child.Revision));
        finished.EnsureSuccessStatusCode();
        Assert.Equal("finished", (await finished.Content.ReadFromJsonAsync<CoreEnvironmentView>())!.State);
        Assert.False(Directory.Exists(child.DataRoot));
    }
    [Fact]
    public async Task SavedConsent_PinsCallerModeCeilingsAndAccountRevision()
    {
        await using var host = await CoreEnvironmentHttpTests.StartHostAsync(); using var caller = await Caller(host);
        var input = new CoreEnvironmentCreate(Guid.NewGuid().ToString(), "QA");
        await Approve(host, caller, input, true);
        using var other = await Caller(host, "other.client");
        Assert.Equal(HttpStatusCode.Forbidden, (await other.PostAsJsonAsync("/api/internal/apps/other.client/core-environments", input)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await caller.PostAsJsonAsync(Root, input with { Limits = new(MemoryBytes: 5368709120) })).StatusCode);
        var config = host.Services.GetRequiredService<HostyCoreRuntimeConfig>();
        var binary = Path.Combine(config.DataRoot, "core", "bin", OperatingSystem.IsWindows() ? "hosty-core.exe" : "hosty-core");
        Directory.CreateDirectory(Path.GetDirectoryName(binary)!); await File.WriteAllTextAsync(binary, "test release");
        Assert.Equal(HttpStatusCode.Forbidden, (await caller.PostAsJsonAsync(Root, input with { Mode = "release" })).StatusCode);
        var grant = Assert.Single((await host.Services.GetRequiredService<BackgroundGrantService>().ReadAsync(default))!.Grants);
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(s => s with {
            Users = s.Users.Select(u => u.Id == "actor" ? u with { AuthRevision = Guid.NewGuid().ToString() } : u).ToArray(),
        });
        await Assert.ThrowsAsync<AppIdentityException>(() => host.Services.GetRequiredService<BackgroundGrantService>().ValidateAsync("qa.client", grant.Id, "environment", default));
    }
    [Fact]
    public async Task Finish_RetiresOneRunConsent_ButPreservesSavedConsent()
    {
        await using var host = await CoreEnvironmentHttpTests.StartHostAsync(); using var caller = await Caller(host);
        foreach (var saved in new[] { false, true })
        {
            var input = new CoreEnvironmentCreate(Guid.NewGuid().ToString(), "QA");
            await Approve(host, caller, input, saved);
            using var response = await caller.PostAsJsonAsync(Root, input); response.EnsureSuccessStatusCode();
            var child = (await response.Content.ReadFromJsonAsync<CoreEnvironmentView>())!;
            (await caller.PostAsJsonAsync(Root + "/" + child.Id + "/operations/finish",
                new CoreEnvironmentCommand(Guid.NewGuid().ToString(), child.Revision))).EnsureSuccessStatusCode();
            var grants = host.Services.GetRequiredService<BackgroundGrantService>();
            var grant = (await grants.ReadAsync(default))!.Grants.Single(g => g.Id == child.Access!.GrantId);
            Assert.Equal(!saved, grant.RevokedAt is not null);
            using var replay = await caller.PostAsJsonAsync(Root, input); replay.EnsureSuccessStatusCode();
            var receipt = (await replay.Content.ReadFromJsonAsync<CoreEnvironmentView>())!;
            Assert.Equal(child.Id, receipt.Id);
            Assert.Equal("finished", receipt.State);
            Assert.Null(receipt.DataRoot);
            Assert.False(Directory.Exists(child.DataRoot));
        }
    }
    [Fact]
    public async Task BackgroundConsent_UsesTheSelectedScopeAndCannotReviewItsOwnExpansion()
    {
        await using var host = await CoreEnvironmentHttpTests.StartHostAsync(); using var caller = await Caller(host);
        var input = new CoreEnvironmentCreate(Guid.NewGuid().ToString(), "QA");
        await Approve(host, caller, input, true);
        var grants = host.Services.GetRequiredService<BackgroundGrantService>();
        var grant = Assert.Single((await grants.ReadAsync(default))!.Grants);
        var token = await grants.IssueAsync("qa.client", new(grant.Id, "environment"), default);
        caller.DefaultRequestHeaders.Remove("X-Hosty-User-Token");
        caller.DefaultRequestHeaders.Add("X-Hosty-User-Token", token.AccessToken);
        Assert.Equal(HttpStatusCode.Forbidden, (await caller.PostAsJsonAsync(Root + "/consent", input)).StatusCode);
        using var created = await caller.PostAsJsonAsync(Root, input); created.EnsureSuccessStatusCode();
        var child = (await created.Content.ReadFromJsonAsync<CoreEnvironmentView>())!;
        var list = (await caller.GetFromJsonAsync<CoreEnvironmentList>(Root))!;
        Assert.Equal(child.Id, Assert.Single(list.Environments).Id);
        await grants.RevokeAsync("actor", grant.Id, default);
        Assert.Equal(HttpStatusCode.Forbidden, (await caller.GetAsync(Root)).StatusCode);
        // An operator keeps lifecycle recovery even when the delegated credential is revoked.
        var service = host.Services.GetRequiredService<CoreEnvironmentService>();
        Assert.Equal("finished", (await service.CommandAsync(new("actor"), child.Id, "finish", new(Guid.NewGuid().ToString(), child.Revision), default)).State);
    }
    [Fact]
    public async Task SavedConsent_IsRevocableWithoutAnEnvironment_AndIsPinnedToInstallation()
    {
        await using var host = await CoreEnvironmentHttpTests.StartHostAsync(); using var caller = await Caller(host);
        await Approve(host, caller, new(Guid.NewGuid().ToString(), "QA"), true);
        var service = host.Services.GetRequiredService<CoreEnvironmentService>();
        var list = await service.ListAsync(new("actor"), default);
        Assert.Empty(list.Environments);
        var saved = Assert.Single(list.Consents!);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var app = (await apps.GetAppAsync("qa.client"))!;
        await apps.UpsertAppAsync(app with { InstalledAt = app.InstalledAt.AddSeconds(1) });
        Assert.Equal("unavailable", Assert.Single((await service.ListAsync(new("actor"), default)).Consents!).State);
        using var operatorApp = await AppManagementHttpTests.CreateAppClient(host, "operator.ui", [CoreAppPermissions.CoreEnvironmentsOperate]);
        (await operatorApp.PostAsJsonAsync("/api/core-environments/consents/" + saved.Id + "/revoke", new { })).EnsureSuccessStatusCode();
        Assert.Empty((await service.ListAsync(new("actor"), default)).Consents!);
    }
    [Fact]
    public async Task SourceConsent_TrustsEditsInTheSelectedProject_ButNotAnotherTargetOrContract()
    {
        await using var host = await CoreEnvironmentHttpTests.StartHostAsync();
        var config = host.Services.GetRequiredService<HostyCoreRuntimeConfig>();
        var project = Path.Combine(config.DataRoot, "reviewed.csproj");
        await File.WriteAllTextAsync(project, "first source version");
        var service = host.Services.GetRequiredService<CoreEnvironmentConsentService>();
        var input = new CoreEnvironmentCreate(Guid.NewGuid().ToString(), "Source QA", "source", project);
        var approved = (await service.PolicyAsync(input, default)) with { RequestDigest = null };
        await File.WriteAllTextAsync(project, "ordinary source edit");
        var later = await service.PolicyAsync(input with { RequestId = Guid.NewGuid().ToString() }, default);
        Assert.True(CoreEnvironmentConsentService.Covers(approved, later));
        var other = await service.PolicyAsync(input with { ProjectPath = Path.Combine(config.DataRoot, "other.csproj") }, default);
        Assert.False(CoreEnvironmentConsentService.Covers(approved, other));
        Assert.False(CoreEnvironmentConsentService.Covers(approved, later with { Contract = "changed-trust-contract" }));
        Assert.False(CoreEnvironmentConsentService.Covers(approved, later with { TargetDigest = new string('a', 64) }));
    }
    [Fact]
    public async Task ChangedTarget_CanRenewConsentThroughOriginalCreationReplay_WithoutReplacingTheChild()
    {
        await using var host = await CoreEnvironmentHttpTests.StartHostAsync(); using var caller = await Caller(host);
        var config = host.Services.GetRequiredService<HostyCoreRuntimeConfig>();
        var binary = Path.Combine(config.DataRoot, "core", "bin", OperatingSystem.IsWindows() ? "hosty-core.exe" : "hosty-core");
        Directory.CreateDirectory(Path.GetDirectoryName(binary)!); await File.WriteAllTextAsync(binary, "first");
        var input = new CoreEnvironmentCreate(Guid.NewGuid().ToString(), "QA", "release");
        await Approve(host, caller, input, true);
        using var created = await caller.PostAsJsonAsync(Root, input); created.EnsureSuccessStatusCode();
        var child = (await created.Content.ReadFromJsonAsync<CoreEnvironmentView>())!;
        await File.WriteAllTextAsync(binary, "replacement");
        Assert.Equal(HttpStatusCode.Forbidden, (await caller.PostAsJsonAsync(Root, input)).StatusCode);
        await Approve(host, caller, input, true);
        using var replay = await caller.PostAsJsonAsync(Root, input); replay.EnsureSuccessStatusCode();
        var renewed = (await replay.Content.ReadFromJsonAsync<CoreEnvironmentView>())!;
        Assert.Equal(child.Id, renewed.Id);
        Assert.Equal(child.DataRoot, renewed.DataRoot);
        Assert.NotEqual(child.Access!.GrantId, renewed.Access!.GrantId);
        Assert.True(renewed.Revision > child.Revision);
        Assert.Single((await caller.GetFromJsonAsync<CoreEnvironmentList>(Root))!.Environments);
    }
    [Fact]
    public async Task CreateReplay_RenewsConsentAfterConcurrentStartWithoutLosingItsJournal()
    {
        var runtime = new PausedStartRuntime();
        await using var host = await CoreHttpHarness.StartAsync(configure: services =>
            services.AddSingleton<ICoreEnvironmentRuntime>(runtime));
        using var caller = await Caller(host);
        var config = host.Services.GetRequiredService<HostyCoreRuntimeConfig>();
        var binary = Path.Combine(config.DataRoot, "core", "bin", OperatingSystem.IsWindows() ? "hosty-core.exe" : "hosty-core");
        Directory.CreateDirectory(Path.GetDirectoryName(binary)!); await File.WriteAllTextAsync(binary, "test release");
        var input = new CoreEnvironmentCreate(Guid.NewGuid().ToString(), "QA", "release");
        await Approve(host, caller, input, true);
        using var created = await caller.PostAsJsonAsync(Root, input); created.EnsureSuccessStatusCode();
        var child = (await created.Content.ReadFromJsonAsync<CoreEnvironmentView>())!;
        var service = host.Services.GetRequiredService<CoreEnvironmentService>();
        var store = host.Services.GetRequiredService<CoreEnvironmentStore>();
        var actor = (await store.ReadAsync(child.Id, default))!.Owner;
        var command = service.CommandAsync(actor, child.Id, "start", new(Guid.NewGuid().ToString(), child.Revision), default);
        await runtime.Started.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Task<CoreEnvironmentView>? replay = null;
        try
        {
            await Approve(host, caller, input, true);
            replay = service.CreateAsync(actor, input, default);
            Assert.NotSame(replay, await Task.WhenAny(replay, Task.Delay(250)));
            // A replay waiting for this child must not reserve the whole descendant tree.
            using var reservation = await store.LockAllocationAsync(default, TimeSpan.FromSeconds(1));
        }
        finally { runtime.Resume.TrySetResult(); await command.WaitAsync(TimeSpan.FromSeconds(10)); }
        var started = await command;
        var renewed = await replay!.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal("running", renewed.State);
        Assert.Equal(started.Process, renewed.Process);
        Assert.Equal(started.Operations, renewed.Operations);
        Assert.Equal(started.Revision + 1, renewed.Revision);
        Assert.NotEqual(child.Access!.GrantId, renewed.Access!.GrantId);
        Assert.Equal(renewed.Access.GrantId, (await store.ReadAsync(child.Id, default))!.Consent!.GrantId);
    }
    private sealed class PausedStartRuntime : ICoreEnvironmentRuntime
    {
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Resume { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public bool FailPrepare { get; set; }
        public int Preparations { get; private set; }
        public Task<string> PrepareAsync(CoreEnvironmentRecord record, string root, CancellationToken ct)
        {
            Preparations++;
            if (FailPrepare) throw new InvalidOperationException("Simulated preparation failure.");
            return Task.FromResult("test-core");
        }
        public Task<CoreEnvironmentProcess?> ObserveAsync(CoreEnvironmentRecord record, string root, CancellationToken ct) => Task.FromResult(record.Process);
        public async Task StartAsync(CoreEnvironmentRecord record, string root, Func<CoreEnvironmentProcess, Task> save, CancellationToken ct)
        {
            Started.TrySetResult(); await Resume.Task.WaitAsync(ct);
            await save(new(1234567, DateTimeOffset.UtcNow));
        }
        public Task StopAsync(CoreEnvironmentRecord record, string root, bool remove, CancellationToken ct) => Task.CompletedTask;
    }
    [Fact]
    public async Task ReleaseTargetChangeBeforeDecision_InvalidatesReview()
    {
        await using var host = await CoreEnvironmentHttpTests.StartHostAsync(); using var caller = await Caller(host);
        var config = host.Services.GetRequiredService<HostyCoreRuntimeConfig>();
        var binary = Path.Combine(config.DataRoot, "core", "bin", OperatingSystem.IsWindows() ? "hosty-core.exe" : "hosty-core");
        Directory.CreateDirectory(Path.GetDirectoryName(binary)!); await File.WriteAllTextAsync(binary, "first");
        await Approve(host, caller, new(Guid.NewGuid().ToString(), "QA", "release"), true, "failed",
            () => File.WriteAllTextAsync(binary, "replacement"));
        Assert.Null(await host.Services.GetRequiredService<BackgroundGrantService>().ReadAsync(default));
    }
}
