using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Haas.Hosty.Core;
using HostySdk.App;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class CoreHistoryHttpTests
{
    [Fact]
    public async Task TextOnlyProviderWorksWithoutHarnessAndRequiresSeparateCurrentHistoryGrant()
    {
        using var source = new Source(); await using var host = await Start(source);
        using var client = host.CreateClient(); var token = await Token(host, AccessTokenScopes.McpRead);
        client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/history/v1/providers")).StatusCode);
        Assert.Equal(0, source.Calls);
        await Scopes(host, token, [AccessTokenScopes.McpRead, AccessTokenScopes.McpHistoryRead]);
        var directory = await client.GetFromJsonAsync<ProviderDirectory>("/api/history/v1/providers");
        Assert.Equal("independent.archive", Assert.Single(directory!.Providers).AppId);
        Assert.Null(directory.Providers[0].Url);
        using var response = await client.PostAsJsonAsync("/api/history/v1/entries/query", new CoreHistoryQuery(source.Conversation.Ref));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var page = await response.Content.ReadFromJsonAsync<HostyHistoryPage>();
        Assert.Equal("Public needle", Assert.Single(page!.Entries).Data.GetProperty("parts")[0].GetProperty("text").GetString());
        Assert.Equal("admin", source.Invocation!.UserId); Assert.Null(source.Invocation.CallerAppId);
        var mcp = await DirectEnvironmentHttpTests.Tool(client, "history_entry_get", new { input = new CoreHistoryEntryGet(source.Entry.Ref, source.Entry.Revision) });
        Assert.False(mcp.TryGetProperty("isError", out var error) && error.GetBoolean(), mcp.ToString());
        await Scopes(host, token, [AccessTokenScopes.McpRead]);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/history/v1/entries/get", new CoreHistoryEntryGet(source.Entry.Ref))).StatusCode);
    }

    [Fact]
    public async Task SearchNeverDisclosesCachedSnippetsAndDropsRevokedOrChangedHits()
    {
        using var source = new Source(); await using var host = await Start(source);
        using var client = host.CreateClient(); client.DefaultRequestHeaders.Authorization = new("Bearer", await Token(host, AccessTokenScopes.McpRead, AccessTokenScopes.McpHistoryRead));
        var query = new CoreHistorySearch([source.Reference], "ＮＥＥＤＬＥ");
        var first = await Post<CoreHistorySearchPage>(client, "/api/history/v1/search", query);
        var hit = Assert.Single(first.Hits); Assert.Equal("Public needle", hit.Excerpt); Assert.Equal("Current title", hit.ConversationTitle);
        Assert.DoesNotContain("private cached", JsonSerializer.Serialize(first));
        source.DenyEntry = true;
        var revoked = await Post<CoreHistorySearchPage>(client, "/api/history/v1/search", query);
        Assert.Empty(revoked.Hits); Assert.Equal("partial", revoked.Coverage.State);
        source.DenyEntry = false; source.StaleHit = true;
        var changed = await Post<CoreHistorySearchPage>(client, "/api/history/v1/search", query);
        Assert.Empty(changed.Hits); Assert.Equal("partial", changed.Coverage.State);
        var coreRoot = host.Services.GetRequiredService<CoreDataPaths>().CoreRoot;
        foreach (var file in Directory.GetFiles(coreRoot, "*.json", SearchOption.AllDirectories))
            Assert.DoesNotContain("Public needle", await File.ReadAllTextAsync(file));
    }

    [Fact]
    public async Task RichProviderRequiresDeclaredBoundedInertExtensionsAndExactRevision()
    {
        using var source = new Source(); await using var host = await Start(source);
        using var client = host.CreateClient(); client.DefaultRequestHeaders.Authorization = new("Bearer", await Token(host, AccessTokenScopes.McpRead, AccessTokenScopes.McpHistoryRead));
        source.Capabilities = source.Capabilities with { EntryKinds = ["message", "extension"], Extensions = [new("org.example/review", 2, JsonSerializer.SerializeToElement(new { type = "object" }))] };
        source.Entry = source.Entry with { Data = JsonSerializer.SerializeToElement(new { kind = "extension", name = "org.example/review", version = 2, payload = new { verdict = "pass" }, fallbackText = "Review passed", disclosure = "complete" }) };
        var entry = await Post<HostyHistoryEntry>(client, "/api/history/v1/entries/get", new CoreHistoryEntryGet(source.Entry.Ref));
        Assert.Equal("pass", entry.Data.GetProperty("payload").GetProperty("verdict").GetString());
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsJsonAsync("/api/history/v1/entries/get", new CoreHistoryEntryGet(source.Entry.Ref, "0"))).StatusCode);
        source.Capabilities = source.Capabilities with { Extensions = [] };
        Assert.Equal(HttpStatusCode.BadGateway, (await client.PostAsJsonAsync("/api/history/v1/entries/get", new CoreHistoryEntryGet(source.Entry.Ref))).StatusCode);
        source.Capabilities = source.Capabilities with { Extensions = [new("org.example/review", 2, JsonSerializer.Deserialize<JsonElement>("{\"$ref\":\"https://private.invalid/schema\"}"))] };
        Assert.Equal(HttpStatusCode.BadGateway, (await client.PostAsJsonAsync("/api/history/v1/capabilities", new CoreHistoryProvider(source.Reference))).StatusCode);
    }

    [Fact]
    public async Task AttachmentHandleIsSubjectBoundAndRechecksSourceAccessForEachRange()
    {
        using var source = new Source(); await using var host = await Start(source);
        source.Entry = source.Entry with { Data = JsonSerializer.SerializeToElement(new { kind = "message", role = "user", state = "complete",
            parts = new[] { new { type = "attachment", attachmentId = "file", revision = "1", name = "document.txt", mediaType = "text/plain", sizeBytes = 8 } } }) };
        using var client = host.CreateClient(); var token = await Token(host, AccessTokenScopes.McpRead, AccessTokenScopes.McpHistoryRead);
        client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var handle = await Post<CoreHistoryAttachment>(client, "/api/history/v1/attachments/resolve", new CoreHistoryAttachmentResolve(source.Entry.Ref, "file", "1"));
        using var range = new HttpRequestMessage(HttpMethod.Get, handle.Handle); range.Headers.Range = new(2, 4);
        using var bytes = await client.SendAsync(range);
        Assert.Equal(HttpStatusCode.PartialContent, bytes.StatusCode); Assert.Equal("cde", await bytes.Content.ReadAsStringAsync());
        Assert.Equal("bytes 2-4/8", bytes.Content.Headers.ContentRange!.ToString());
        Assert.Equal("attachment", bytes.Content.Headers.ContentDisposition!.DispositionType);
        using var other = host.CreateClient(); other.DefaultRequestHeaders.Authorization = new("Bearer", await Token(host, AccessTokenScopes.McpRead, AccessTokenScopes.McpHistoryRead));
        Assert.Equal(HttpStatusCode.Gone, (await other.GetAsync(handle.Handle)).StatusCode);
        source.DenyEntry = true; Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(handle.Handle)).StatusCode);
        source.DenyEntry = false; await Scopes(host, token, [AccessTokenScopes.McpRead]);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(handle.Handle)).StatusCode);
    }

    [Fact]
    public async Task AuthorizedSearchKeepsItsRootToolAuthorityDuringInternalSourceRevalidation()
    {
        using var source = new Source(); await using var host = await Start(source);
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        var caller = source.App with { Id = "independent.assistant", ConfirmedRoles = ["assistant"],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["assistant"] = [new("default", null, "/assistant")] },
            GrantedCorePermissions = [CoreAppPermissions.HistoryProviders, CoreAppPermissions.HistoryRead] };
        await host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(caller);
        var parent = await BrowserAuthorityFixture.Grant(host, caller.Id, "admin");
        var grant = new AssistantTargetGrant(caller.InstalledAt, "history-grant", DeniedTools: ["history_entry_get", "conversation_get", "history_capabilities"]);
        await host.Services.GetRequiredService<AgentPolicyStore>().ChangeAsync(AgentMcpDirectory.CoreId,
            new(null, true, new Dictionary<string, string>(), new Dictionary<string, AssistantTargetGrant> { [caller.Id] = grant }));
        var token = await host.Services.GetRequiredService<AssistantMcpAccess>().IssueAsync(caller.Id, AgentMcpDirectory.CoreId,
            host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(caller.Id), parent.AccessToken, default, "search-session");
        using var client = host.CreateClient(); client.DefaultRequestHeaders.Authorization = new("Bearer", token.Token);
        var response = await DirectEnvironmentHttpTests.Tool(client, "history_search", new { input = new CoreHistorySearch([source.Reference], "needle") });
        Assert.False(response.TryGetProperty("isError", out var error) && error.GetBoolean(), response.ToString());
        Assert.Equal(1, response.GetProperty("structuredContent").GetProperty("hits").GetArrayLength());
        using var denied = new HttpRequestMessage(HttpMethod.Post, "/api/mcp") { Content = JsonContent.Create(new { jsonrpc = "2.0", id = 1, method = "tools/call", @params = new { name = "history_entry_get", arguments = new { input = new CoreHistoryEntryGet(source.Entry.Ref) } } }) };
        denied.Headers.Accept.ParseAdd("application/json, text/event-stream");
        Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(denied)).StatusCode);
        Assert.Null(CoreMcpCatalog.InvokedTool);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/history/v1/entries/get", new CoreHistoryEntryGet(source.Entry.Ref))).StatusCode);
    }

    [Fact]
    public async Task ExportNeedsOwnerBrowserConsentAndKeepsConsumerCheckpointAndPurgeSeparateFromReadAccess()
    {
        using var source = new Source(); await using var host = await Start(source);
        using var client = host.CreateClient(); client.DefaultRequestHeaders.Authorization = new("Bearer", await Token(host, AccessTokenScopes.McpRead, AccessTokenScopes.McpHistoryRead, AccessTokenScopes.McpHistoryExport));
        var input = new CoreHistoryExportCreate(Guid.NewGuid().ToString(), new("self"), new("conversations", Conversations: [source.Conversation.Ref]), "Test source index");
        var proposed = await Post<HostyHistoryExportGrant>(client, "/api/history/v1/exports/create", input);
        Assert.Equal("proposed", proposed.State);
        var receipt = await client.GetFromJsonAsync<CoreProviderOperationReceipt>("/api/history/v1/operations/" + input.RequestId);
        Assert.Equal("exports.create", receipt!.Operation); Assert.Equal("completed", receipt.State); Assert.Null(receipt.Provider);
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsJsonAsync("/api/history/v1/exports/create", input with { Purpose = "different purpose" })).StatusCode);
        Assert.Equal(proposed.Id, (await Post<HostyHistoryExportGrant>(client, "/api/history/v1/exports/create", input)).Id);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/history/v1/exports/snapshot", new CoreHistoryExportQuery(proposed.Id, source.Reference))).StatusCode);
        var clock = host.Services.GetRequiredService<IClock>(); var now = clock.UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(state => state with { Sessions = [.. state.Sessions,
            new("review-browser", "admin", now, now.AddHours(1), null, now, BrowserOrigin: "http://localhost")] });
        using var browser = host.CreateClient(); browser.DefaultRequestHeaders.Add("Cookie", "hosty_session=review-browser");
        var html = await browser.GetStringAsync(proposed.ApprovalUrl);
        Assert.Contains("Test source index", html);
        var nonce = System.Text.RegularExpressions.Regex.Match(html, "name=\"nonce\" value=\"([^\"]+)\"").Groups[1].Value; Assert.NotEmpty(nonce);
        using var decision = new HttpRequestMessage(HttpMethod.Post, proposed.ApprovalUrl)
        { Content = new FormUrlEncodedContent(new Dictionary<string, string> { ["nonce"] = nonce, ["revision"] = proposed.Revision, ["decision"] = "approve" }) };
        decision.Headers.Add("Origin", "http://localhost");
        Assert.Equal(HttpStatusCode.OK, (await browser.SendAsync(decision)).StatusCode);
        var active = await Post<HostyHistoryExportGrant>(client, "/api/history/v1/exports/get", new CoreHistoryExportGet(proposed.Id)); Assert.Equal("active", active.State);
        using var other = host.CreateClient(); other.DefaultRequestHeaders.Authorization = new("Bearer", await Token(host, AccessTokenScopes.McpRead, AccessTokenScopes.McpHistoryRead, AccessTokenScopes.McpHistoryExport));
        Assert.Equal(HttpStatusCode.NotFound, (await other.PostAsJsonAsync("/api/history/v1/exports/snapshot", new CoreHistoryExportQuery(active.Id, source.Reference))).StatusCode);
        var snapshot = await Post<HostyHistoryExportSnapshot>(client, "/api/history/v1/exports/snapshot", new CoreHistoryExportQuery(active.Id, source.Reference));
        Assert.Single(snapshot.Entries); Assert.NotNull(source.Invocation!.Export); Assert.Equal(active.Id, source.Invocation.Export.GrantId);
        var ack = new CoreHistoryExportAcknowledge(active.Id, Guid.NewGuid().ToString(), active.Revision, snapshot.ChangeCursor);
        var applied = await Post<HostyHistoryExportGrant>(client, "/api/history/v1/exports/acknowledge", ack);
        Assert.Equal(CoreJson.Text(applied), CoreJson.Text(await Post<HostyHistoryExportGrant>(client, "/api/history/v1/exports/acknowledge", ack)));
        var ackReceipt = await client.GetFromJsonAsync<CoreProviderOperationReceipt>("/api/history/v1/operations/" + ack.RequestId);
        Assert.Equal("exports.acknowledge", ackReceipt!.Operation); Assert.Equal(active.Id, ackReceipt.ResourceId);
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsJsonAsync("/api/history/v1/exports/acknowledge", ack with { LastAppliedCursor = "changed" })).StatusCode);
        var changes = await Post<HostyHistoryChangePage>(client, "/api/history/v1/exports/changes", new CoreHistoryExportQuery(active.Id, source.Reference, snapshot.ChangeCursor));
        Assert.Equal("delete", Assert.Single(changes.Changes).Type); Assert.Null(changes.Changes[0].Entry);
        var revoked = await Post<HostyHistoryExportGrant>(client, "/api/history/v1/exports/revoke", new CoreHistoryExportRevoke(active.Id, Guid.NewGuid().ToString(), applied.Revision));
        Assert.Equal("purge_required", revoked.State); Assert.Null(revoked.Corpus); Assert.Null(revoked.Purpose);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/history/v1/exports/changes", new CoreHistoryExportQuery(active.Id, source.Reference, changes.NextCursor))).StatusCode);
        var purged = await Post<HostyHistoryExportGrant>(client, "/api/history/v1/exports/acknowledge", new CoreHistoryExportAcknowledge(active.Id, Guid.NewGuid().ToString(), revoked.Revision, PurgeComplete: true));
        Assert.Equal("purged", purged.State); Assert.Null(purged.Corpus);
        var data = host.Services.GetRequiredService<CoreDataPaths>().CoreRoot;
        foreach (var file in Directory.GetFiles(Path.Combine(data, "history-exports"), "*.json")) Assert.DoesNotContain("Public needle", await File.ReadAllTextAsync(file));
    }

    [Fact]
    public async Task IndependentInstalledIndexerUsesOnlyItsApprovedCorpusAndRetainsContentFreePurgeAccess()
    {
        using var source = new Source(); await using var host = await Start(source);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var consumer = source.App with { Id = "independent.indexer", DisplayName = "Test indexer", ConfirmedRoles = [], Interfaces = null,
            GrantedCorePermissions = [CoreAppPermissions.HistoryProviders, CoreAppPermissions.HistoryRead, CoreAppPermissions.HistoryExport] };
        await apps.UpsertAppAsync(consumer);
        using var owner = host.CreateClient(); owner.DefaultRequestHeaders.Authorization = new("Bearer", await Token(host, AccessTokenScopes.McpRead, AccessTokenScopes.McpHistoryRead, AccessTokenScopes.McpHistoryExport));
        var grant = await Post<HostyHistoryExportGrant>(owner, "/api/history/v1/exports/create", new CoreHistoryExportCreate(Guid.NewGuid().ToString(),
            new("app", consumer.Id, PanelIdentity.Installation(consumer)), new("all-owned", Providers: [source.Reference], IncludeFutureConversations: true), "Independent test index"));
        await Approve(host, grant);
        using var indexer = host.CreateClient(); indexer.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(consumer.Id));
        var root = "/api/internal/apps/" + consumer.Id + "/history-exports";
        var active = await Post<HostyHistoryExportGrant>(indexer, root + "/get", new CoreHistoryExportGet(grant.Id)); Assert.Equal("active", active.State);
        var snapshot = await Post<HostyHistoryExportSnapshot>(indexer, root + "/snapshot", new CoreHistoryExportQuery(grant.Id, source.Reference));
        Assert.Single(snapshot.Entries); Assert.Equal(consumer.Id, source.Invocation!.CallerAppId);
        Assert.Equal("admin", source.Invocation.UserId); Assert.Null(source.Invocation.Export!.ConversationIds);
        Assert.Equal(HttpStatusCode.Unauthorized, (await indexer.PostAsJsonAsync("/api/history/v1/entries/get", new CoreHistoryEntryGet(source.Entry.Ref))).StatusCode);
        await apps.UpsertAppAsync(consumer with { GrantedCorePermissions = [CoreAppPermissions.HistoryProviders] });
        var purge = await Post<HostyHistoryExportGrant>(indexer, root + "/get", new CoreHistoryExportGet(grant.Id));
        Assert.Equal("purge_required", purge.State); Assert.Null(purge.Corpus); Assert.Null(purge.OwnerUserId);
        Assert.Equal(HttpStatusCode.Forbidden, (await indexer.PostAsJsonAsync(root + "/snapshot", new CoreHistoryExportQuery(grant.Id, source.Reference))).StatusCode);
        var done = await Post<HostyHistoryExportGrant>(indexer, root + "/acknowledge", new CoreHistoryExportAcknowledge(grant.Id, Guid.NewGuid().ToString(), purge.Revision, PurgeComplete: true));
        Assert.Equal("purged", done.State);
    }
    private static async Task Approve(CoreHttpHarness host, HostyHistoryExportGrant grant)
    {
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        var session = Guid.NewGuid().ToString();
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(state => state with { Sessions = [.. state.Sessions,
            new(session, "admin", now, now.AddHours(1), null, now, BrowserOrigin: "http://localhost")] });
        using var browser = host.CreateClient(); browser.DefaultRequestHeaders.Add("Cookie", "hosty_session=" + session);
        var html = await browser.GetStringAsync(grant.ApprovalUrl);
        var nonce = System.Text.RegularExpressions.Regex.Match(html, "name=\"nonce\" value=\"([^\"]+)\"").Groups[1].Value; Assert.NotEmpty(nonce);
        HttpRequestMessage Decision(string origin)
        {
            var request = new HttpRequestMessage(HttpMethod.Post, grant.ApprovalUrl)
            { Content = new FormUrlEncodedContent(new Dictionary<string, string> { ["nonce"] = nonce, ["revision"] = grant.Revision, ["decision"] = "approve" }) };
            request.Headers.Add("Origin", origin); return request;
        }
        using var foreign = Decision("https://other.example"); Assert.Equal(HttpStatusCode.Forbidden, (await browser.SendAsync(foreign)).StatusCode);
        using var valid = Decision("http://localhost"); var response = await browser.SendAsync(valid);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task HistoryStreamIsBoundToItsClientAndClosesWhenOriginatingGrantIsRevoked()
    {
        using var source = new Source(); await using var host = await Start(source);
        using var client = host.CreateClient(); var token = await Token(host, AccessTokenScopes.McpRead, AccessTokenScopes.McpHistoryRead);
        client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var subscription = await Post<CoreHistorySubscription>(client, "/api/history/v1/subscriptions", new CoreHistorySubscriptionCreate(source.Conversation.Ref));
        using var other = host.CreateClient(); other.DefaultRequestHeaders.Authorization = new("Bearer", await Token(host, AccessTokenScopes.McpRead, AccessTokenScopes.McpHistoryRead));
        Assert.Equal(HttpStatusCode.Gone, (await other.GetAsync("/api/history/v1/subscriptions/" + subscription.Handle)).StatusCode);
        using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/history/v1/subscriptions/" + subscription.Handle);
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancel.Token);
        Assert.Equal("text/event-stream", response.Content.Headers.ContentType!.MediaType);
        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(cancel.Token));
        Assert.Equal("event: history.changed", await reader.ReadLineAsync(cancel.Token));
        Assert.StartsWith("id: ", await reader.ReadLineAsync(cancel.Token));
        var data = await reader.ReadLineAsync(cancel.Token); Assert.DoesNotContain("Public needle", data);
        await Scopes(host, token, [AccessTokenScopes.McpRead]);
        string? line;
        do { line = await reader.ReadLineAsync(cancel.Token); } while (line is not null && line != "event: stream.closed");
        Assert.Equal("event: stream.closed", line);
    }

    [Fact]
    public async Task SessionRevocationInterruptsAnInFlightSourceNotificationWait()
    {
        using var source = new Source { HoldNotifications = true }; await using var host = await Start(source);
        using var client = host.CreateClient(); var token = await Token(host, AccessTokenScopes.McpRead, AccessTokenScopes.McpHistoryRead);
        client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var subscription = await Post<CoreHistorySubscription>(client, "/api/history/v1/subscriptions", new CoreHistorySubscriptionCreate(source.Conversation.Ref));
        using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/history/v1/subscriptions/" + subscription.Handle);
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancel.Token);
        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(cancel.Token));
        Assert.Equal("event: history.changed", await reader.ReadLineAsync(cancel.Token));
        await Scopes(host, token, [AccessTokenScopes.McpRead]);
        host.Services.GetRequiredService<CoreEventHub>().CloseSession(token);
        while (await reader.ReadLineAsync(cancel.Token) is not null) { }
    }

    [Fact]
    public async Task ConversationEnumerationKeepsExplicitProviderCoverageAndSubjectBoundContinuations()
    {
        using var source = new Source(); await using var host = await Start(source);
        using var client = host.CreateClient(); client.DefaultRequestHeaders.Authorization = new("Bearer", await Token(host, AccessTokenScopes.McpRead, AccessTokenScopes.McpHistoryRead));
        var missing = source.Reference with { AppId = "z.unavailable.archive" };
        var query = new CoreConversationQuery([source.Reference, missing], Limit: 1);
        var first = await Post<CoreConversationPage>(client, "/api/history/v1/conversations/query", query);
        Assert.Equal(source.Conversation.Ref, Assert.Single(first.Conversations).Ref); Assert.NotNull(first.NextCursor);
        var next = await Post<CoreConversationPage>(client, "/api/history/v1/conversations/query", query with { Cursor = first.NextCursor });
        Assert.Empty(next.Conversations); Assert.Null(next.NextCursor); Assert.Equal("partial", next.Coverage.State);
        Assert.Equal("unavailable", next.Providers.Single(p => p.Provider == missing).State);
        using var other = host.CreateClient(); other.DefaultRequestHeaders.Authorization = new("Bearer", await Token(host, AccessTokenScopes.McpRead, AccessTokenScopes.McpHistoryRead));
        Assert.Equal(HttpStatusCode.Gone, (await other.PostAsJsonAsync("/api/history/v1/conversations/query", query with { Cursor = first.NextCursor })).StatusCode);
        var mcp = await DirectEnvironmentHttpTests.Tool(client, "conversation_list", new { input = new CoreConversationQuery([source.Reference]) });
        Assert.Equal(1, mcp.GetProperty("structuredContent").GetProperty("conversations").GetArrayLength());
    }

    private static async Task<T> Post<T>(HttpClient client, string route, object body)
    {
        using var response = await client.PostAsJsonAsync(route, body);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        return (await response.Content.ReadFromJsonAsync<T>())!;
    }
    private static async Task<CoreHttpHarness> Start(Source source)
    {
        var host = await CoreHttpHarness.StartAsync(configure: services => services.AddSingleton<IHttpClientFactory>(source));
        source.Services = host.Services; var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1, [new("admin", "admin@example.test", "Admin", "host.admin", false, now, now)], [], [], []));
        source.App = new("independent.archive", "Independent archive", null, "1.0.0", "runtime", false, "installed", null, null, "local", "installed", "running", null, null, [], new Dictionary<string, AppSettingValue>(), [], [], [], now, now)
        {
            ConfirmedRoles = ["conversation-history"], Endpoints = [new("api", "http", "http://archive.invalid", true)],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["conversation-history"] = [new("archive", "api", "/v1", 1, ["history.read", "history.search.text", "history.sharing", "history.attachments", "history.changes"])] },
        };
        await host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(source.App);
        source.Reference = new(source.App.Id, PanelIdentity.Installation(source.App), "archive");
        source.Conversation = new(new(source.Reference, "chat-one"), "1", "Current title", "admin", now, now, ["history.read", "history.search.text", "history.sharing"]);
        source.Entry = new(new(source.Conversation.Ref, "entry-one"), "1", "1", now, now, new("user", "admin"), JsonSerializer.SerializeToElement(new
            { kind = "message", role = "user", parts = new[] { new { type = "text", text = "Public needle", format = "plain" } }, state = "complete" }));
        return host;
    }
    private static async Task<string> Token(CoreHttpHarness host, params string[] scopes)
        => (await AccessTokenEndpoints.IssueAsync("admin", AccessTokenKinds.Manual, "History test", host.Services.GetRequiredService<UserDirectoryStore>(), host.Services.GetRequiredService<IClock>(), host.Services.GetRequiredService<AuthLifetimes>(), default, audience: AccessTokenScopes.CoreAudience, scopes: scopes)).Id;
    private static Task Scopes(CoreHttpHarness host, string token, string[] scopes) => host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(state => state with { Sessions = state.Sessions.Select(s => s.Id == token ? s with { Scopes = scopes } : s).ToArray() });
    private sealed class Source : HttpMessageHandler, IHttpClientFactory
    {
        internal IServiceProvider Services = null!; internal AppRecord App = null!; internal HostyProviderRef Reference = null!;
        internal HostyConversation Conversation = null!; internal HostyHistoryEntry Entry = null!;
        internal HostyHistoryCapabilities Capabilities = new(1, ["message"], [], 200, 900, 604800);
        internal CoreProviderInvocation? Invocation; internal int Calls; internal bool DenyEntry, StaleHit, HoldNotifications;
        public HttpClient CreateClient(string name) { Assert.Equal(CoreProviderMediation.ClientName, name); return new(this, false); }
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls++; var path = request.RequestUri!.AbsolutePath[3..]; var operation = path.Trim('/').Replace('/', '.');
            var bytes = request.Content is null ? [] : await request.Content.ReadAsByteArrayAsync(ct);
            Invocation = await Services.GetRequiredService<CoreProviderMediation>().IntrospectAsync(App,
                new(request.Headers.Authorization!.Parameter!, "conversation-history", "archive", operation, request.Method.Method, path, CoreProviderMediation.Hash(bytes)), ct);
            if (path == "/entries/get" && DenyEntry) return new(HttpStatusCode.NotFound) { Content = JsonContent.Create(new { error = new { code = "not_found", message = "Not found", retryable = false } }) };
            if (path == "/attachments/content")
            {
                using var input = JsonDocument.Parse(bytes);
                var offset = input.RootElement.GetProperty("offset").GetInt32(); var length = input.RootElement.GetProperty("length").GetInt32();
                return new(HttpStatusCode.OK) { Content = new ByteArrayContent(System.Text.Encoding.UTF8.GetBytes("abcdefgh").AsSpan(offset, length).ToArray()) };
            }
            if (path == "/notifications" && JsonDocument.Parse(bytes).RootElement.GetProperty("waitSeconds").GetInt32() > 0) await Task.Delay(HoldNotifications ? Timeout.Infinite : 100, ct);
            object result = path switch
            {
                "/capabilities" => Capabilities,
                "/notifications" => new HostyHistoryNotification(Conversation.Ref, "1", "opaque-source-cursor", [new("upsert", Entry.Ref.Id, Entry.Revision)], false),
                "/attachments/resolve" => new CoreHistorySourceAttachment("file", "1", "document.txt", "text/plain", 8),
                "/conversations/get" => Conversation,
                "/conversations/query" => new HostyConversationPage([Conversation], null, "conversations-snapshot", "1", new("complete", [])),
                "/entries/get" => Entry,
                "/entries/query" => new HostyHistoryPage([Entry], null, "snapshot", "1", new("complete", [])),
                "/exports/snapshot" => new HostyHistoryExportSnapshot([Entry], null, "export-snapshot", "1", "source-change-1", new("complete", [])),
                "/exports/changes" => new HostyHistoryChangePage([new("change-2", "2", "delete", Ref: Entry.Ref, Revision: "2")], "source-change-2", "2", new("complete", [])),
                "/search" => new CoreHistorySourceHits([new(Entry.Ref, StaleHit ? "0" : Entry.Revision, "private cached title", "private cached snippet", Entry.UpdatedAt, Entry.UpdatedAt)], null, "snapshot", "1", new("complete", [])),
                _ => throw new InvalidOperationException(path),
            };
            return new(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(result, result.GetType(), JsonSerializerOptions.Web), System.Text.Encoding.UTF8, "application/json") };
        }
    }
}
