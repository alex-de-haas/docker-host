using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

// Core MCP over the real pipeline (docs/features/core-mcp/feature.md): initialize → tools/list →
// tools/call, plus the auth gate and the result bounds.
//
// The handshake alone would not prove much. Attribute-declared tools are discovered by reflection, so
// the failure mode worth catching is a server that initializes cleanly and then advertises nothing, or
// advertises a tool that throws when called — which is why every tool is invoked here, not just listed.
public sealed class McpHttpTests
{
    [Fact]
    public async Task ListsAndCallsTheReadOnlyTools()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var apps = harness.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync(CreateApp("com.example.notes", runtimeState: "running"));
        await apps.UpsertAppAsync(CreateApp("hosty.shell", runtimeState: "stopped", system: true, lastError: "boom"));
        var admin = await SeedSessionAsync(harness, "host.admin");
        using var client = harness.CreateClient();
        await InitializeAsync(client, admin);

        var tools = await CallAsync(client, admin, "tools/list", new { });
        var names = tools.GetProperty("tools").EnumerateArray()
            .Select(tool => tool.GetProperty("name").GetString() ?? "")
            .Order(StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(
            [
                "apply_app_update", "get_app", "get_host_status", "list_apps", "plan_app_update",
                "restart_app", "search_audit", "start_app", "stop_app", "tail_app_logs",
            ],
            names);

        var listed = await CallToolAsync(client, admin, "list_apps", new { });
        var summaries = listed.GetProperty("apps").EnumerateArray().ToArray();
        Assert.Equal(2, summaries.Length);
        var notes = summaries.Single(app => app.GetProperty("id").GetString() == "com.example.notes");
        Assert.Equal("running", notes.GetProperty("runtimeState").GetString());
        Assert.False(notes.GetProperty("system").GetBoolean());

        var detail = await CallToolAsync(client, admin, "get_app", new { appId = "hosty.shell" });
        Assert.Equal("hosty.shell", detail.GetProperty("id").GetString());
        Assert.True(detail.GetProperty("system").GetBoolean());
        Assert.Equal("boom", detail.GetProperty("lastError").GetString());

        var status = await CallToolAsync(client, admin, "get_host_status", new { });
        Assert.Equal(2, status.GetProperty("apps").GetInt32());
        Assert.Equal(1, status.GetProperty("running").GetInt32());
        Assert.Equal(1, status.GetProperty("notRunning").GetInt32());
        Assert.Equal(1, status.GetProperty("withErrors").GetInt32());
        Assert.False(string.IsNullOrWhiteSpace(status.GetProperty("coreVersion").GetString()));
    }

    [Fact]
    public async Task SearchesTheAuditAndSaysWhatWindowProducedTheAnswer()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var audit = harness.Services.GetRequiredService<AuditStore>();
        var clock = harness.Services.GetRequiredService<IClock>();
        await audit.AppendAsync(Entry("app.lifecycle.stop", "com.example.notes", "succeeded", clock.UtcNow));
        await audit.AppendAsync(Entry("app.lifecycle.start", "com.example.other", "refused", clock.UtcNow));
        var admin = await SeedSessionAsync(harness, "host.admin");
        using var client = harness.CreateClient();
        await InitializeAsync(client, admin);

        var all = await CallToolAsync(client, admin, "search_audit", new { });
        Assert.Equal(2, all.GetProperty("entries").GetArrayLength());
        Assert.False(all.GetProperty("window").GetProperty("rangeClamped").GetBoolean());

        // The pair: a filter that matches beside the same filter that does not. Either alone is
        // satisfied by a search that ignores its arguments entirely.
        var mine = await CallToolAsync(client, admin, "search_audit", new { resourceId = "com.example.notes" });
        Assert.Equal(1, mine.GetProperty("entries").GetArrayLength());
        Assert.Equal("app.lifecycle.stop", mine.GetProperty("entries")[0].GetProperty("action").GetString());
        // Who authorized it is the question an audit exists to answer.
        Assert.Equal("user_admin", mine.GetProperty("entries")[0].GetProperty("actorUserId").GetString());

        var none = await CallToolAsync(client, admin, "search_audit", new { resourceId = "com.example.absent" });
        Assert.Equal(0, none.GetProperty("entries").GetArrayLength());

        // A refusal is findable: a surface recording only successes would hide the case an operator
        // actually investigates.
        var refused = await CallToolAsync(client, admin, "search_audit", new { outcome = "refused" });
        Assert.Equal(1, refused.GetProperty("entries").GetArrayLength());
        Assert.Equal("com.example.other", refused.GetProperty("entries")[0].GetProperty("resourceId").GetString());
    }

    [Fact]
    public async Task ReportsItsClampsRatherThanApplyingThemSilently()
    {
        // An over-large ask answered quietly looks identical to a host where that much simply did not
        // happen. Keeping those apart is the whole job of the window.
        await using var harness = await CoreHttpHarness.StartAsync();
        var audit = harness.Services.GetRequiredService<AuditStore>();
        var clock = harness.Services.GetRequiredService<IClock>();
        await audit.AppendAsync(Entry("app.lifecycle.stop", "com.example.notes", "succeeded", clock.UtcNow));
        await audit.AppendAsync(Entry("app.lifecycle.stop", "com.example.notes", "succeeded", clock.UtcNow));
        var admin = await SeedSessionAsync(harness, "host.admin");
        using var client = harness.CreateClient();
        await InitializeAsync(client, admin);

        var clamped = await CallToolAsync(client, admin, "search_audit", new { rangeSeconds = 999_999_999, limit = 9_999 });
        Assert.True(clamped.GetProperty("window").GetProperty("rangeClamped").GetBoolean());
        Assert.True(clamped.GetProperty("window").GetProperty("limitClamped").GetBoolean());

        // Both directions: a full page says so, an unfilled one does not. A flag that is always true
        // says nothing.
        var full = await CallToolAsync(client, admin, "search_audit", new { limit = 1 });
        Assert.True(full.GetProperty("window").GetProperty("truncated").GetBoolean());
        var partial = await CallToolAsync(client, admin, "search_audit", new { limit = 50 });
        Assert.False(partial.GetProperty("window").GetProperty("truncated").GetBoolean());
    }

    private static AuditRecord Entry(string action, string resourceId, string outcome, DateTimeOffset at)
        => new(
            Id: $"audit_{Guid.NewGuid():N}",
            Action: action,
            ResourceType: "app",
            ResourceId: resourceId,
            Outcome: outcome,
            ActorUserId: "user_admin",
            CreatedAt: at,
            Details: new Dictionary<string, string>(StringComparer.Ordinal));

    [Fact]
    public async Task EveryToolDeclaresWhatItIsOnTheWire()
    {
        // A client cannot know a tool's nature from the design — it reads `annotations`. A read tool
        // without `readOnlyHint: true` is uncallable by a gated unattended client (observed
        // 2026-08-20 with `codex exec`: every call came back "user cancelled"), and a mutation tool
        // *with* it would sail through every filter built on the hint — the connector's, the
        // facade's — as though it were safe. Both directions of the lie are asserted, on the wire,
        // because an attribute that stopped mapping to the payload would leave every other test green.
        //
        // Hosty already holds *apps* to this bar — `hosty mcp` refuses to export a tool that does not
        // declare itself — so Core failing to declare is Core exempting itself from its own contract.
        await using var harness = await CoreHttpHarness.StartAsync();
        var admin = await SeedSessionAsync(harness, "host.admin");
        using var client = harness.CreateClient();
        await InitializeAsync(client, admin);

        // plan_app_update is here too: it changes nothing, but it reaches the app's source and reports
        // what is available, which is not the "safe to call unattended" promise readOnlyHint makes.
        string[] mutations = ["start_app", "stop_app", "restart_app", "plan_app_update", "apply_app_update"];
        var tools = await CallAsync(client, admin, "tools/list", new { });
        foreach (var tool in tools.GetProperty("tools").EnumerateArray())
        {
            var name = tool.GetProperty("name").GetString()!;
            Assert.True(
                tool.TryGetProperty("annotations", out var annotations),
                $"{name} declares no annotations, so a client must assume it may mutate.");

            var readOnly = annotations.TryGetProperty("readOnlyHint", out var hint) && hint.GetBoolean();
            if (mutations.Contains(name))
            {
                Assert.False(readOnly, $"{name} mutates but claims readOnlyHint: true.");
            }
            else
            {
                Assert.True(readOnly, $"{name} does not declare readOnlyHint: true.");
            }
        }

        // Stopping interrupts an app's users; a filter keyed on destructiveHint must see that.
        var stop = tools.GetProperty("tools").EnumerateArray()
            .Single(tool => tool.GetProperty("name").GetString() == "stop_app");
        Assert.True(stop.GetProperty("annotations").GetProperty("destructiveHint").GetBoolean());

        // Applying an update stops and replaces the app, so it is destructive for the same reason —
        // while planning one is not, and a filter must be able to tell the halves of this pair apart.
        var apply = tools.GetProperty("tools").EnumerateArray()
            .Single(tool => tool.GetProperty("name").GetString() == "apply_app_update");
        Assert.True(apply.GetProperty("annotations").GetProperty("destructiveHint").GetBoolean());
        var plan = tools.GetProperty("tools").EnumerateArray()
            .Single(tool => tool.GetProperty("name").GetString() == "plan_app_update");
        Assert.False(plan.GetProperty("annotations").GetProperty("destructiveHint").GetBoolean());
    }

    [Fact]
    public async Task AnUnknownAppIdIsAnAnsweredError_NotAProtocolFailure()
    {
        // A model recovers from a tool result that explains itself; it cannot recover from a transport
        // error. get_app on a bogus id must come back as a normal result carrying guidance.
        await using var harness = await CoreHttpHarness.StartAsync();
        var admin = await SeedSessionAsync(harness, "host.admin");
        using var client = harness.CreateClient();
        await InitializeAsync(client, admin);

        var result = await CallToolAsync(client, admin, "get_app", new { appId = "com.example.ghost" });

        Assert.Contains("com.example.ghost", result.GetProperty("error").GetString());
        Assert.Contains("list_apps", result.GetProperty("error").GetString());
    }

    [Fact]
    public async Task BoundsTheLogTailRatherThanTrustingTheCaller()
    {
        // An agent asking for 100000 lines would blow its own context and Core's response budget. The
        // clamp is asserted through the echoed line budget, which is what the tool reports back.
        await using var harness = await CoreHttpHarness.StartAsync();
        var apps = harness.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync(CreateApp("com.example.notes"));
        var admin = await SeedSessionAsync(harness, "host.admin");
        using var client = harness.CreateClient();
        await InitializeAsync(client, admin);

        // The budget is echoed in the result whether or not the read itself succeeds, which is what
        // makes the clamp observable here: the seeded app has no runtime behind it, so the read fails
        // and the payload carries the reason alongside the budget it used.
        var huge = await CallToolAsync(client, admin, "tail_app_logs", new { appId = "com.example.notes", lines = 100_000 });
        Assert.Equal(500, huge.GetProperty("lines").GetInt32());
        Assert.Equal("com.example.notes", huge.GetProperty("appId").GetString());

        var negative = await CallToolAsync(client, admin, "tail_app_logs", new { appId = "com.example.notes", lines = -5 });
        Assert.Equal(1, negative.GetProperty("lines").GetInt32());

        var normal = await CallToolAsync(client, admin, "tail_app_logs", new { appId = "com.example.notes", lines = 20 });
        Assert.Equal(20, normal.GetProperty("lines").GetInt32());
    }

    [Fact]
    public async Task RejectsAnonymousAndNonAdminCallers()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var member = await SeedSessionAsync(harness, "host.member", "user_2");
        using var client = harness.CreateClient();

        // Browser-shaped anonymous POST: the CSRF gate answers first, as on every requireCsrf route.
        using var anonymous = await PostAsync(client, credential: null, Envelope(1, "initialize", InitializeParams));
        Assert.Equal(HttpStatusCode.Forbidden, anonymous.StatusCode);

        // A bearer is CSRF-exempt, so this reaches the session check and gets the clean 401.
        using var badBearer = await PostAsync(client, "not-a-session", Envelope(1, "initialize", InitializeParams));
        Assert.Equal(HttpStatusCode.Unauthorized, badBearer.StatusCode);

        // A real, valid session that is simply not an admin: denied before the protocol handler runs,
        // so a non-admin never learns which apps exist.
        using var nonAdmin = await PostAsync(client, member, Envelope(1, "initialize", InitializeParams));
        Assert.Equal(HttpStatusCode.Forbidden, nonAdmin.StatusCode);
    }

    [Fact]
    public async Task IsVisibleToTheEndpointAuthorizationSweep()
    {
        // The A4 guardrail enumerates the live endpoint table and probes every /api route anonymously.
        // It can only cover MCP if MapMcp registers routable endpoints under the group prefix — if the
        // SDK ever mapped them some other way, the sweep would silently stop covering this route while
        // still passing. Asserted here so that regression is loud.
        await using var harness = await CoreHttpHarness.StartAsync();
        var patterns = harness.Services.GetRequiredService<EndpointDataSource>().Endpoints
            .OfType<RouteEndpoint>()
            .Select(endpoint => endpoint.RoutePattern.RawText ?? "")
            .Where(pattern => pattern.StartsWith("/api/mcp", StringComparison.Ordinal))
            .ToArray();

        Assert.NotEmpty(patterns);
    }

    private const string InitializeParams =
        """{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"hosty-tests","version":"1.0.0"}}""";

    // Runs the MCP handshake through real requests rather than reaching into the server, so the
    // transport is proven and not just the tool methods.
    //
    // The endpoint is stateless (the SDK's default since the 2026-07-28 revision removed
    // Mcp-Session-Id): every POST is self-contained, no session is negotiated, and there is no
    // long-lived stream. That suits read-only tools — nothing here needs a server-to-client request —
    // and it means the SSE lifetime concerns Core's event stream had do not arise.
    private static async Task InitializeAsync(HttpClient client, string credential)
    {
        using var response = await PostAsync(client, credential, Envelope(1, "initialize", InitializeParams));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.False(response.Headers.Contains("Mcp-Session-Id"), "Expected a stateless endpoint.");

        var result = ReadJsonRpcResult(await response.Content.ReadAsStringAsync());
        Assert.False(string.IsNullOrWhiteSpace(result.GetProperty("protocolVersion").GetString()));
        Assert.True(result.GetProperty("capabilities").TryGetProperty("tools", out _), "Server did not advertise tools.");
    }

    private static async Task<JsonElement> CallAsync(
        HttpClient client,
        string credential,
        string method,
        object parameters)
    {
        var payload = Envelope(2, method, JsonSerializer.Serialize(parameters));
        using var response = await PostAsync(client, credential, payload);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return ReadJsonRpcResult(await response.Content.ReadAsStringAsync());
    }

    // Calls a tool and parses the JSON payload out of its text content. The tools serialize their
    // result through Core's source-generated context, so this asserts the shape an agent actually sees.
    private static async Task<JsonElement> CallToolAsync(
        HttpClient client,
        string credential,
        string name,
        object arguments)
    {
        var result = await CallAsync(client, credential, "tools/call", new { name, arguments });
        Assert.False(
            result.TryGetProperty("isError", out var isError) && isError.GetBoolean(),
            $"Tool '{name}' reported an error: {result}");
        var text = result.GetProperty("content").EnumerateArray().First().GetProperty("text").GetString()!;
        return JsonDocument.Parse(text).RootElement.Clone();
    }

    private static string Envelope(int id, string method, string parameters)
        => $$"""{"jsonrpc":"2.0","id":{{id}},"method":"{{method}}","params":{{parameters}}}""";

    private static async Task<HttpResponseMessage> PostAsync(
        HttpClient client,
        string? credential,
        string body)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/mcp");
        // Streamable HTTP lets the server answer with either a JSON body or an SSE stream, and it
        // refuses a client that has not said it accepts both.
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        if (credential is not null)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credential);
        }

        request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        return await client.SendAsync(request);
    }

    // Accepts either transport shape: a bare JSON-RPC object, or an SSE frame carrying one.
    private static JsonElement ReadJsonRpcResult(string body)
    {
        var json = body.TrimStart().StartsWith('{')
            ? body
            : body.Split('\n')
                .Select(line => line.Trim())
                .First(line => line.StartsWith("data:", StringComparison.Ordinal))["data:".Length..];

        var envelope = JsonDocument.Parse(json).RootElement;
        Assert.False(
            envelope.TryGetProperty("error", out var error),
            $"JSON-RPC error: {error}");
        return envelope.GetProperty("result").Clone();
    }

    private static async Task<string> SeedSessionAsync(CoreHttpHarness harness, string role, string userId = "user_1")
    {
        var users = harness.Services.GetRequiredService<UserDirectoryStore>();
        var now = harness.Services.GetRequiredService<IClock>().UtcNow;
        var user = new HostUserRecord(userId, $"{userId}@example.test", userId, role, false, now, now);
        var session = new AuthSessionRecord($"session_{userId}", userId, now, now.AddHours(1), null, now);
        await users.WriteAsync(new UserDirectoryState(1, [user], [], [], [session]));
        return session.Id;
    }

    private static AppRecord CreateApp(
        string id,
        string runtimeState = "stopped",
        bool system = false,
        string? lastError = null)
        => new(
            Id: id,
            DisplayName: "App",
            Description: "An app",
            Version: "1.0.0",
            Kind: "runtime",
            System: system,
            Source: "installed",
            ManifestPath: $"apps/{id}/manifest.json",
            ManifestUrl: null,
            SelectedRuntime: "docker",
            OperationStatus: "installed",
            RuntimeState: runtimeState,
            LastOperation: null,
            LastError: lastError,
            Capabilities: ["open"],
            Settings: new Dictionary<string, AppSettingValue>(),
            StorageMappings: [],
            Dependencies: [],
            Endpoints: [],
            InstalledAt: DateTimeOffset.UtcNow,
            UpdatedAt: DateTimeOffset.UtcNow);
}
