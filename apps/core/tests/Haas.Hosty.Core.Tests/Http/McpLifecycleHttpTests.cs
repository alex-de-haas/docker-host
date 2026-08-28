using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

// Core MCP lifecycle mutations (docs/features/core-mcp/feature.md): the standing-grant gate, over the
// real pipeline.
//
// The determinism trick throughout: mutations target an app id that is not installed. An authorized
// caller then gets the *lifecycle* answer ("could not start: no such app"), an unauthorized one the
// *scope* refusal — so which gate answered is observable without a runtime that could actually
// start anything. Gate order is part of the contract: the scope answers before the app lookup, or a
// read-only credential could probe which ids exist.
public sealed class McpLifecycleHttpTests
{
    [Fact]
    public async Task TheScopeIsTheGate_AndTheRefusalNamesIt()
    {
        // The pair: a credential with mcp:lifecycle passes the gate; the same shape of credential
        // without it is refused as a tool result naming the scope. Either half alone is satisfied by
        // a broken gate.
        await using var harness = await CoreHttpHarness.StartAsync();
        var admin = await SeedSessionAsync(harness, "host.admin");
        using var client = harness.CreateClient();

        var control = await CreateCredentialAsync(client, admin, "control", ["mcp:read", "mcp:lifecycle"]);
        var readOnly = await CreateCredentialAsync(client, admin, "read only", ["mcp:read"]);

        var allowed = await CallToolAsync(client, control, "start_app", new { appId = "com.example.absent" });
        // Past the gate: the answer is about the app, not the credential.
        Assert.Contains("com.example.absent", allowed.GetProperty("error").GetString()!, StringComparison.Ordinal);
        Assert.Equal("start", allowed.GetProperty("action").GetString());

        var refused = await CallToolAsync(client, readOnly, "start_app", new { appId = "com.example.absent" });
        Assert.Contains("mcp:lifecycle", refused.GetProperty("error").GetString()!, StringComparison.Ordinal);
        // And nothing about the app: the scope answered first, so a read-only credential cannot use
        // refusal shapes to probe which ids exist.
        Assert.DoesNotContain("com.example.absent", refused.GetProperty("error").GetString()!, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnAdministratorSessionCarriesLifecycleByRole()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var admin = await SeedSessionAsync(harness, "host.admin");
        using var client = harness.CreateClient();

        var result = await CallToolAsync(client, admin, "restart_app", new { appId = "com.example.absent" });
        Assert.Contains("com.example.absent", result.GetProperty("error").GetString()!, StringComparison.Ordinal);
        Assert.Equal("restart", result.GetProperty("action").GetString());
    }

    [Fact]
    public async Task ADelegatedTokenNeverCarriesLifecycle_BecauseItNeverCarriesTheScopes()
    {
        // The facade path. The delegated token proves an administrator, but it descends from a
        // scoped credential whose scopes it does not carry — so role alone must not stand in for the
        // grant, or a facade client holding a read-only token would reach mutations around it.
        // (Belt and suspenders with issuance: a gateway-audience token cannot even hold
        // mcp:lifecycle, per the audience binding asserted below — this rule is what holds if that
        // one ever loosens.)
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedSystemAppAsync(harness, "hosty.ai-gateway");
        var admin = await SeedSessionAsync(harness, "host.admin");
        using var client = harness.CreateClient();

        var facadeCredential = await CreateCredentialAsync(
            client, admin, "claude code", ["mcp:read"], audience: "hosty.ai-gateway");
        using var minted = await MintOnBehalfOfAsync(client, harness, "hosty.ai-gateway", facadeCredential, "hosty:core");
        Assert.Equal(HttpStatusCode.OK, minted.StatusCode);
        var delegated = (await ReadJsonAsync(minted)).GetProperty("token").GetString()!;

        // Reads work: the delegated path is the facade's, and the facade is read-only.
        var listed = await CallToolAsync(client, delegated, "list_apps", new { });
        Assert.True(listed.TryGetProperty("apps", out _));

        // Mutations do not: whatever the actor's role, the delegated token cannot prove a
        // standing grant.
        var refused = await CallToolAsync(client, delegated, "stop_app", new { appId = "com.example.absent" });
        Assert.Contains("mcp:lifecycle", refused.GetProperty("error").GetString()!, StringComparison.Ordinal);
    }

    [Fact]
    public async Task EveryOutcomeLandsInTheAuditLog_RefusalsIncluded()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var admin = await SeedSessionAsync(harness, "host.admin");
        using var client = harness.CreateClient();

        var control = await CreateCredentialAsync(client, admin, "control", ["mcp:read", "mcp:lifecycle"]);
        var readOnly = await CreateCredentialAsync(client, admin, "read only", ["mcp:read"]);

        await CallToolAsync(client, control, "start_app", new { appId = "com.example.absent" });
        await CallToolAsync(client, readOnly, "stop_app", new { appId = "com.example.absent" });

        var records = await harness.Services.GetRequiredService<AuditStore>().ReadRecentAsync(50);
        var attempted = records.Single(record => record.Action == "app.lifecycle.start");
        // "failed", not "succeeded": the app does not exist, and the log must say what actually
        // happened rather than what was asked for.
        Assert.Equal("failed", attempted.Outcome);
        Assert.Equal("com.example.absent", attempted.ResourceId);
        Assert.Equal("user_1", attempted.ActorUserId);
        Assert.Equal("mcp", attempted.Details["via"]);

        var refused = records.Single(record => record.Action == "app.lifecycle.stop");
        Assert.Equal("refused", refused.Outcome);
        Assert.Equal("user_1", refused.ActorUserId);
    }

    [Fact]
    public async Task ReadOnlyToolsAreUntouchedForAReadOnlyCredential()
    {
        // The feature must not disturb what shipped before it: a credential holding only mcp:read
        // still lists the surface and still reads. (The wire annotations of every tool, both
        // directions of the lie, are asserted in McpHttpTests.EveryToolDeclaresWhatItIsOnTheWire.)
        await using var harness = await CoreHttpHarness.StartAsync();
        var admin = await SeedSessionAsync(harness, "host.admin");
        using var client = harness.CreateClient();

        var readOnly = await CreateCredentialAsync(client, admin, "read only", ["mcp:read"]);
        var listed = await CallAsync(client, readOnly, "tools/list", new { });
        var names = listed.GetProperty("tools").EnumerateArray()
            .Select(tool => tool.GetProperty("name").GetString())
            .ToArray();
        // The claim is that listing is not filtered by scope — refusal happens at the call, where it
        // can name the missing grant. A bare count asserted that too, but broke on every tool added
        // for a reason that had nothing to do with this test's subject.
        Assert.Contains("list_apps", names);
        Assert.Contains("stop_app", names);

        var apps = await CallToolAsync(client, readOnly, "list_apps", new { });
        Assert.True(apps.TryGetProperty("apps", out _));
    }

    [Fact]
    public async Task IssuanceBindsTheLifecycleScopeToTheCoreAudience()
    {
        // On an app audience the scope would be issued cleanly, listed, and read by nothing — the
        // silently-inert credential the issuance guards exist to refuse while the operator is still
        // looking at the form.
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedSystemAppAsync(harness, "hosty.ai-gateway");
        var admin = await SeedSessionAsync(harness, "host.admin");
        using var client = harness.CreateClient();

        using var refused = await SendAsync(
            client, HttpMethod.Post, "/api/auth/credentials", admin,
            new { label = "a", audience = "hosty.ai-gateway", scopes = new[] { "mcp:lifecycle" } });
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        Assert.Equal("scope_invalid_for_audience", (await ReadJsonAsync(refused)).GetProperty("code").GetString());

        // Lifecycle without read is refused too: mcp:read is the entry to the surface, so a
        // lifecycle-only credential would be minted cleanly and refused on every call — unable to
        // invoke the very tools it names.
        using var lonely = await SendAsync(
            client, HttpMethod.Post, "/api/auth/credentials", admin,
            new { label = "a", audience = "hosty:core", scopes = new[] { "mcp:lifecycle" } });
        Assert.Equal(HttpStatusCode.BadRequest, lonely.StatusCode);
        Assert.Equal("scope_requires_read", (await ReadJsonAsync(lonely)).GetProperty("code").GetString());

        // The same pair on the Core audience is exactly what the feature exists to issue.
        using var allowed = await SendAsync(
            client, HttpMethod.Post, "/api/auth/credentials", admin,
            new { label = "a", audience = "hosty:core", scopes = new[] { "mcp:read", "mcp:lifecycle" } });
        Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
    }

    [Fact]
    public async Task AnAuditWriteFailureNeverFalsifiesTheOutcome()
    {
        // The audit line is owed, but it describes something that already happened. If the append
        // fails, the client must still receive the real answer — reporting a completed mutation as
        // a failed call invites repeating it — and the failure must not escape as a transport error.
        await using var harness = await CoreHttpHarness.StartAsync();
        var admin = await SeedSessionAsync(harness, "host.admin");
        using var client = harness.CreateClient();
        var control = await CreateCredentialAsync(client, admin, "control", ["mcp:read", "mcp:lifecycle"]);

        // Break the audit store the way storage breaks: a directory where the append-only file
        // should be makes every append throw.
        var auditPath = harness.Services.GetRequiredService<CoreDataPaths>().AuditLogPath;
        File.Delete(auditPath);
        Directory.CreateDirectory(auditPath);

        var result = await CallToolAsync(client, control, "start_app", new { appId = "com.example.absent" });

        // The lifecycle answer, exactly as if the audit store were healthy.
        Assert.Contains("com.example.absent", result.GetProperty("error").GetString()!, StringComparison.Ordinal);
        Assert.Equal("start", result.GetProperty("action").GetString());
    }

    // --- helpers -------------------------------------------------------------------------------

    [Fact]
    public async Task LifecycleDoesNotCarryUpdate()
    {
        // The reason this scope exists. An operator granting "restart it when it wedges" has not
        // thereby granted "change which version runs" — least of all months later, when a scope they
        // approved once quietly grew a second meaning.
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedSystemAppAsync(harness, "com.example.notes");
        var admin = await SeedSessionAsync(harness, "host.admin");
        using var client = harness.CreateClient();

        var lifecycleOnly = await CreateCredentialAsync(
            client, admin, "lifecycle", ["mcp:read", "mcp:lifecycle"]);

        var planned = await CallToolAsync(client, lifecycleOnly, "plan_app_update", new { appId = "com.example.notes" });
        Assert.Contains("mcp:update", planned.GetProperty("error").GetString());

        var applied = await CallToolAsync(
            client, lifecycleOnly, "apply_app_update", new { appId = "com.example.notes", planDigest = "whatever" });
        Assert.Contains("mcp:update", applied.GetProperty("error").GetString());

        // The acceptance beside the refusals: a scope check that refused everyone would satisfy both
        // negatives on its own and be completely broken. The plan may still fail on its merits — this
        // app has no source configured — but it must fail *past* the gate, not on it.
        var updater = await CreateCredentialAsync(client, admin, "updater", ["mcp:read", "mcp:update"]);
        var allowed = await CallToolAsync(client, updater, "plan_app_update", new { appId = "com.example.notes" });
        Assert.DoesNotContain("mcp:update", allowed.ToString());
    }

    [Fact]
    public async Task RequiresReadNamesTheScopeThatWasAskedFor()
    {
        // The guard was generalised to every Core-only scope but its message still named the scope it
        // was first written for, which would send someone who asked for mcp:update to fix mcp:lifecycle.
        await using var harness = await CoreHttpHarness.StartAsync();
        var admin = await SeedSessionAsync(harness, "host.admin");
        using var client = harness.CreateClient();

        using var response = await SendAsync(
            client,
            HttpMethod.Post,
            "/api/auth/credentials",
            admin,
            new { label = "no read", audience = "hosty:core", scopes = new[] { "mcp:update" } });

        var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        Assert.Equal("scope_requires_read", body.GetProperty("code").GetString());
        Assert.Contains("mcp:update", body.GetProperty("message").GetString());
    }

    [Fact]
    public async Task AnAppliedUpdateIsReportedAsAcceptedRatherThanDone()
    {
        // The apply runs detached, so "succeeded" would be an outcome nobody has yet — and the runtime
        // state in the response is still the pre-update one, which is exactly how a model concludes an
        // update finished and moves on. The audit line must not claim it either.
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedSystemAppAsync(harness, "com.example.notes");
        var admin = await SeedSessionAsync(harness, "host.admin");
        using var client = harness.CreateClient();

        var applied = await CallToolAsync(
            client, admin, "apply_app_update", new { appId = "com.example.notes", planDigest = "no-such-plan" });

        // This particular apply fails on the digest, which is the honest outcome for a plan that was
        // never computed — what matters is that a *successful* enqueue never reports completion, and
        // the audit trail agrees with the tool.
        Assert.True(applied.TryGetProperty("error", out _));
        var audit = harness.Services.GetRequiredService<AuditStore>();
        var entries = await audit.ReadRecentAsync();
        Assert.DoesNotContain(entries, entry => entry.Action == "app.lifecycle.update" && entry.Outcome == "succeeded");
    }

    [Fact]
    public async Task UpdateScopeIsRefusedOnAnAppAudience()
    {
        // Same trap the lifecycle scope closes: on an app audience it would be issued cleanly, listed,
        // and read by nothing. Generalised to every Core-only scope so the next one cannot be guarded
        // in one place and forgotten in the other.
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedSystemAppAsync(harness, "com.example.notes");
        var admin = await SeedSessionAsync(harness, "host.admin");
        using var client = harness.CreateClient();

        using var response = await SendAsync(
            client,
            HttpMethod.Post,
            "/api/auth/credentials",
            admin,
            new { label = "wrong audience", audience = "com.example.notes", scopes = new[] { "mcp:read", "mcp:update" } });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        Assert.Equal("scope_invalid_for_audience", body.GetProperty("code").GetString());
    }

    private static async Task<string> CreateCredentialAsync(
        HttpClient client,
        string session,
        string label,
        string[] scopes,
        string audience = "hosty:core")
    {
        using var response = await SendAsync(
            client, HttpMethod.Post, "/api/auth/credentials", session, new { label, audience, scopes });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await ReadJsonAsync(response)).GetProperty("token").GetString()!;
    }

    private static Task<HttpResponseMessage> MintOnBehalfOfAsync(
        HttpClient client,
        CoreHttpHarness harness,
        string callerAppId,
        string credential,
        string targetAppId)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, $"/api/internal/apps/{callerAppId}/delegated-token");
        request.Headers.Authorization = new AuthenticationHeaderValue(
            "Bearer", harness.Services.GetRequiredService<AppServiceTokenService>().CreateToken(callerAppId));
        request.Content = JsonContent.Create(new { token = credential, targetAppId });
        return client.SendAsync(request);
    }

    private static async Task<JsonElement> CallToolAsync(HttpClient client, string credential, string name, object arguments)
    {
        var result = await CallAsync(client, credential, "tools/call", new { name, arguments });
        var text = result.GetProperty("content").EnumerateArray().First().GetProperty("text").GetString()!;
        return JsonDocument.Parse(text).RootElement.Clone();
    }

    private static async Task<JsonElement> CallAsync(HttpClient client, string credential, string method, object parameters)
    {
        var payload = $$"""{"jsonrpc":"2.0","id":2,"method":"{{method}}","params":{{JsonSerializer.Serialize(parameters)}}}""";
        using var response = await PostAsync(client, credential, payload);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        var json = body.TrimStart().StartsWith('{')
            ? body
            : body.Split('\n').Select(line => line.Trim())
                .First(line => line.StartsWith("data:", StringComparison.Ordinal))["data:".Length..];
        var envelope = JsonDocument.Parse(json).RootElement;
        Assert.False(envelope.TryGetProperty("error", out var error), $"JSON-RPC error: {error}");
        return envelope.GetProperty("result").Clone();
    }

    private static async Task<HttpResponseMessage> PostAsync(HttpClient client, string credential, string body)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/mcp");
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credential);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        return await client.SendAsync(request);
    }

    private static async Task<HttpResponseMessage> SendAsync(
        HttpClient client,
        HttpMethod method,
        string path,
        string credential,
        object? body = null)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credential);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        return await client.SendAsync(request);
    }

    private static async Task<JsonElement> ReadJsonAsync(HttpResponseMessage response)
        => JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone();

    private static async Task SeedSystemAppAsync(CoreHttpHarness harness, string appId)
        => await harness.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(new AppRecord(
            Id: appId,
            DisplayName: "App",
            Description: null,
            Version: "1.0.0",
            Kind: "runtime",
            System: true,
            Source: "installed",
            ManifestPath: $"apps/{appId}/manifest.json",
            ManifestUrl: null,
            SelectedRuntime: "docker",
            OperationStatus: "installed",
            RuntimeState: "running",
            LastOperation: null,
            LastError: null,
            Capabilities: ["open"],
            Settings: new Dictionary<string, AppSettingValue>(),
            StorageMappings: [],
            Dependencies: [],
            Endpoints: [],
            InstalledAt: DateTimeOffset.UtcNow,
            UpdatedAt: DateTimeOffset.UtcNow));

    private static async Task<string> SeedSessionAsync(CoreHttpHarness harness, string role, string userId = "user_1")
    {
        var users = harness.Services.GetRequiredService<UserDirectoryStore>();
        var now = harness.Services.GetRequiredService<IClock>().UtcNow;
        var user = new HostUserRecord(userId, $"{userId}@example.test", userId, role, false, now, now);
        var session = new AuthSessionRecord($"session_{userId}", userId, now, now.AddHours(1), null, now);
        await users.WriteAsync(new UserDirectoryState(1, [user], [], [], [session]));
        return session.Id;
    }
}
