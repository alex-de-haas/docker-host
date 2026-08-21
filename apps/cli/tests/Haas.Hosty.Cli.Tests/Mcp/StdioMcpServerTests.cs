namespace Haas.Hosty.Cli.Tests.Mcp;

using System.Text.Json;
using Haas.Hosty.Cli.Mcp;

// The protocol loop, driven the way a client drives it: newline-delimited JSON-RPC in, the same out.
// The catalog is faked so these assert the server's own contract rather than Core's or an app's.
public class StdioMcpServerTests
{
    [Fact]
    public async Task InitializeCarriesAnAppSkill_FencedAndAttributed()
    {
        var catalog = new FakeCatalog();
        catalog.Skills.Add(new AppSkill("com.haas.demo-app", "Demo App", "Call get_my_app_role first."));

        var (responses, _) = await RunAsync(catalog, """{"jsonrpc":"2.0","id":1,"method":"initialize"}""");

        var instructions = responses[0].GetProperty("result").GetProperty("instructions").GetString()!;
        // The connector's own text stays first: it is what describes this surface, and an app that
        // could appear above it would read as the host speaking.
        Assert.StartsWith("Tools from every Hosty app", instructions, StringComparison.Ordinal);
        Assert.Contains("""<app-skill app="com.haas.demo-app" name="Demo App">""", instructions, StringComparison.Ordinal);
        Assert.Contains("Call get_my_app_role first.", instructions, StringComparison.Ordinal);
        // Named as what it is, and as granting nothing — so a skill reaching past its own app reads
        // as out of place rather than as authority.
        Assert.Contains("it grants nothing", instructions, StringComparison.Ordinal);
    }

    [Fact]
    public async Task InitializeCarriesNoSkillSectionWhenNoAppDeclaresOne()
    {
        // The ordinary case, and the pair for the test above: a connector that always emitted the
        // preamble would satisfy the assertions there while being wrong for every host.
        var (responses, _) = await RunAsync(new FakeCatalog(), """{"jsonrpc":"2.0","id":1,"method":"initialize"}""");

        var instructions = responses[0].GetProperty("result").GetProperty("instructions").GetString()!;
        Assert.DoesNotContain("<app-skill", instructions, StringComparison.Ordinal);
        Assert.DoesNotContain("it grants nothing", instructions, StringComparison.Ordinal);
    }

    [Fact]
    public async Task InitializeAnnouncesToolListChangedAndSaysTheSurfaceIsFiltered()
    {
        var (responses, _) = await RunAsync(new FakeCatalog(), """{"jsonrpc":"2.0","id":1,"method":"initialize"}""");

        var result = responses[0].GetProperty("result");
        // Without listChanged a client has no reason to re-read the list, and the connector's whole
        // purpose — following a fleet that changes mid-session — would be invisible to it.
        Assert.True(result.GetProperty("capabilities").GetProperty("tools").GetProperty("listChanged").GetBoolean());
        Assert.Equal("hosty", result.GetProperty("serverInfo").GetProperty("name").GetString());
        // The one sentence that explains an absent capability, which is why tools are hidden rather
        // than listed-and-refused.
        Assert.Contains("read-only", result.GetProperty("instructions").GetString()!, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ToolsListRenamesTheToolAndPassesItsSchemaThroughUnchanged()
    {
        var catalog = new FakeCatalog();
        catalog.Add("com_dexample_dnotes__list_people", "com.example.notes", "Notes", "list_people", """
            {"name":"list_people","description":"Lists people.",
             "inputSchema":{"type":"object","properties":{"q":{"type":"string"}}},
             "annotations":{"readOnlyHint":true}}
            """);

        var (responses, _) = await RunAsync(catalog, """{"jsonrpc":"2.0","id":2,"method":"tools/list"}""");

        var tool = responses[0].GetProperty("result").GetProperty("tools")[0];
        Assert.Equal("com_dexample_dnotes__list_people", tool.GetProperty("name").GetString());
        // Schema and annotations reach the client exactly as the app wrote them — client permission
        // policy keys off both, so rewriting either would break it silently.
        Assert.Equal("string", tool.GetProperty("inputSchema").GetProperty("properties").GetProperty("q").GetProperty("type").GetString());
        Assert.True(tool.GetProperty("annotations").GetProperty("readOnlyHint").GetBoolean());
        // The app is named in the description, because the app's own text has no reason to say which
        // app it is and the model needs that to choose between two similar tools.
        Assert.StartsWith("[Notes]", tool.GetProperty("description").GetString()!, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ToolsCallSendsTheAppItsOwnNameAndRelaysTheResult()
    {
        var catalog = new FakeCatalog();
        catalog.Add("com_dexample_dnotes__list_people", "com.example.notes", "Notes", "list_people", """
            {"name":"list_people","annotations":{"readOnlyHint":true}}
            """);
        catalog.CallResult = AppMcpResult.Ok(JsonDocument.Parse("""
            {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"two people"}]}}
            """));

        var (responses, _) = await RunAsync(
            catalog,
            """{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"com_dexample_dnotes__list_people","arguments":{"q":"a"}}}""");

        // The namespacing belongs to the connector; the app has never heard of it.
        Assert.Equal("list_people", catalog.LastCalled!.ToolName);
        Assert.Equal("two people", responses[0].GetProperty("result").GetProperty("content")[0].GetProperty("text").GetString());
    }

    [Fact]
    public async Task AStoppedAppFailsOnlyItsOwnCall()
    {
        var catalog = new FakeCatalog();
        catalog.Add("notes__list_people", "com.example.notes", "Notes", "list_people", """{"name":"list_people"}""");
        catalog.CallResult = AppMcpResult.Unavailable("app_stopped", "com.example.notes is not reachable.");

        var (responses, _) = await RunAsync(
            catalog,
            """{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"notes__list_people"}}""",
            """{"jsonrpc":"2.0","id":5,"method":"tools/list"}""");

        // isError on a normal result, not a JSON-RPC error: the client learns the call failed and the
        // model can read why and choose something else, where a protocol error would end the turn.
        var failure = responses[0].GetProperty("result");
        Assert.True(failure.GetProperty("isError").GetBoolean());
        Assert.Contains("app_stopped", failure.GetProperty("content")[0].GetProperty("text").GetString()!, StringComparison.Ordinal);
        // And the session is still alive: the very next request is answered normally.
        Assert.True(responses[1].GetProperty("result").TryGetProperty("tools", out _));
    }

    [Fact]
    public async Task AToolMissingFromTheCatalogIsRefusedEvenWhenTheClientAsksForIt()
    {
        // The second half of the read-only boundary: hiding a mutating tool is not enough, because a
        // client may call from a list it cached before the fleet changed.
        var catalog = new FakeCatalog();
        catalog.Add("notes__list_people", "com.example.notes", "Notes", "list_people", """{"name":"list_people"}""");

        var (responses, _) = await RunAsync(
            catalog,
            """{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"notes__delete_everything"}}""",
            """{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"notes__list_people"}}""");

        Assert.True(responses[0].GetProperty("result").GetProperty("isError").GetBoolean());
        // Paired with the permitted call, so "refuses everything" cannot pass as "enforces the rule":
        // exactly one call reached an app, and it was the one that is in the catalog.
        Assert.False(responses[1].GetProperty("result").TryGetProperty("isError", out var flag) && flag.GetBoolean());
        Assert.Equal(["list_people"], catalog.Calls.Select(call => call.ToolName));
    }

    [Fact]
    public async Task TheChangeNotificationIsAWellFormedNotificationWithNoId()
    {
        // What a client acts on when the fleet moves. An `id` here would make it a request the client
        // would try to answer, and the notification is the only thing that lets a session pick up an
        // app installed after it started.
        var output = new StringWriter();
        var server = new StdioMcpServer(new StringReader(""), output, new StringWriter(), new FakeCatalog());

        server.NotifyToolsChanged();

        using var parsed = JsonDocument.Parse(output.ToString().Trim());
        Assert.Equal("notifications/tools/list_changed", parsed.RootElement.GetProperty("method").GetString());
        Assert.False(parsed.RootElement.TryGetProperty("id", out _));
    }

    [Fact]
    public async Task ANotificationIsNeverAnswered()
    {
        // Replying to a notification is a protocol violation clients surface as a stray message.
        var (responses, _) = await RunAsync(
            new FakeCatalog(),
            """{"jsonrpc":"2.0","method":"notifications/initialized"}""",
            """{"jsonrpc":"2.0","id":8,"method":"ping"}""");

        Assert.Single(responses);
        Assert.Equal(8, responses[0].GetProperty("id").GetInt32());
    }

    [Fact]
    public async Task MalformedInputIsReportedWithoutEndingTheSession()
    {
        var (responses, _) = await RunAsync(
            new FakeCatalog(),
            "{ not json",
            """{"jsonrpc":"2.0","id":9,"method":"ping"}""");

        Assert.Equal(-32700, responses[0].GetProperty("error").GetProperty("code").GetInt32());
        Assert.Equal(9, responses[1].GetProperty("id").GetInt32());
    }

    [Fact]
    public async Task ADescriptorTheAppGotWrongDoesNotTakeDownTheServer()
    {
        // App descriptors are untrusted input. A non-string description used to throw out of the write
        // and, since that runs inside the request loop, would have ended the whole session over one
        // malformed tool — the client seeing a server that died mid-conversation with no explanation.
        var catalog = new FakeCatalog();
        catalog.Add("notes__odd", "com.example.notes", "Notes", "odd", """
            {"name":"odd","description":{"not":"a string"},"annotations":{"readOnlyHint":true}}
            """);

        var (responses, _) = await RunAsync(
            catalog,
            """{"jsonrpc":"2.0","id":1,"method":"tools/list"}""",
            """{"jsonrpc":"2.0","id":2,"method":"ping"}""");

        // The odd value is passed through rather than mangled, and the session carries on.
        var tool = responses[0].GetProperty("result").GetProperty("tools")[0];
        Assert.Equal("a string", tool.GetProperty("description").GetProperty("not").GetString());
        Assert.Equal(2, responses[1].GetProperty("id").GetInt32());
    }

    [Fact]
    public async Task ClientFieldsOfTheWrongTypeAreRefusedRatherThanThrown()
    {
        // `method` and `params.name` come from the client, and JsonElement.GetString throws rather
        // than returning null when the value is a number.
        var catalog = new FakeCatalog();
        catalog.Add("notes__list_people", "com.example.notes", "Notes", "list_people", """{"name":"list_people"}""");

        var (responses, _) = await RunAsync(
            catalog,
            """{"jsonrpc":"2.0","id":1,"method":42}""",
            """{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":7}}""",
            """{"jsonrpc":"2.0","id":3,"method":"ping"}""");

        Assert.Equal(-32601, responses[0].GetProperty("error").GetProperty("code").GetInt32());
        Assert.Equal(-32602, responses[1].GetProperty("error").GetProperty("code").GetInt32());
        // Paired with a request that must still work, so "answers nothing" cannot pass for "is robust".
        Assert.Equal(3, responses[2].GetProperty("id").GetInt32());
    }

    [Fact]
    public async Task DiagnosticsNeverReachTheProtocolStream()
    {
        // One stray line on stdout corrupts the stream, and the client's only symptom is a server
        // that "does not work" — so every line written to stdout must parse as JSON.
        var catalog = new FakeCatalog();
        var output = new StringWriter();
        var diagnostics = new StringWriter();
        var server = new StdioMcpServer(
            new StringReader("""{"jsonrpc":"2.0","id":1,"method":"initialize"}""" + "\n"),
            output,
            diagnostics,
            catalog);
        server.WriteDiagnostic("something happened");
        await server.RunAsync(CancellationToken.None);

        foreach (var line in output.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            using var parsed = JsonDocument.Parse(line);
            Assert.Equal("2.0", parsed.RootElement.GetProperty("jsonrpc").GetString());
        }

        Assert.Contains("something happened", diagnostics.ToString(), StringComparison.Ordinal);
    }

    private static async Task<(List<JsonElement> Responses, string Diagnostics)> RunAsync(
        FakeCatalog catalog,
        params string[] requests)
    {
        var output = new StringWriter();
        var diagnostics = new StringWriter();
        var server = new StdioMcpServer(
            new StringReader(string.Join('\n', requests) + "\n"),
            output,
            diagnostics,
            catalog);

        await server.RunAsync(CancellationToken.None);

        var responses = output.ToString()
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => JsonDocument.Parse(line).RootElement.Clone())
            .ToList();
        return (responses, diagnostics.ToString());
    }

    private sealed class FakeCatalog : ToolCatalogSource
    {
        private readonly List<ExportedTool> tools = [];

        public AppMcpResult CallResult { get; set; } =
            AppMcpResult.Ok(JsonDocument.Parse("""{"jsonrpc":"2.0","id":1,"result":{"content":[]}}"""));

        public List<ExportedTool> Calls { get; } = [];

        /// <summary>Skills the server should fold into its instructions. Empty by default.</summary>
        public List<AppSkill> Skills { get; } = [];

        public Task<IReadOnlyList<AppSkill>> GetSkillsAsync(CancellationToken cancellationToken)
            => Task.FromResult<IReadOnlyList<AppSkill>>(Skills);

        public ExportedTool? LastCalled => Calls.Count > 0 ? Calls[^1] : null;

        public void Add(string exportedName, string appId, string displayName, string toolName, string descriptorJson)
            => tools.Add(new ExportedTool(
                exportedName,
                new AppMcpTarget(appId, displayName, "default", $"http://{appId}/api/mcp"),
                toolName,
                JsonDocument.Parse(descriptorJson).RootElement.Clone()));

        public Task<IReadOnlyList<ExportedTool>> GetAsync(CancellationToken cancellationToken)
            => Task.FromResult<IReadOnlyList<ExportedTool>>(tools);

        public Task<AppMcpResult> CallAsync(ExportedTool tool, JsonElement? arguments, CancellationToken cancellationToken)
        {
            Calls.Add(tool);
            return Task.FromResult(CallResult);
        }
    }
}
