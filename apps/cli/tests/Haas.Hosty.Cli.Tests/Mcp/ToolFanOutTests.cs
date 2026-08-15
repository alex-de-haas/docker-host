namespace Haas.Hosty.Cli.Tests.Mcp;

using System.Diagnostics;
using System.Net;
using System.Text;
using Haas.Hosty.Cli.Mcp;

// The fan-out over a stubbed transport: what the catalog does when one app misbehaves. Driven through
// a real HttpClient so the cancellation path under test is the one production takes.
public class ToolFanOutTests
{
    private static readonly TimeSpan Immediate = TimeSpan.FromMilliseconds(50);

    [Fact]
    public async Task OneAppTimingOutDoesNotCostTheOthersTheirTools()
    {
        // The property that keeps a session usable on a real host: something wedged must not empty the
        // catalog, and a listing that waited for the slowest app would hang at session start.
        var handler = new StubHandler
        {
            Responses =
            {
                ["http://slow/api/mcp"] = _ => throw new TimeoutSignal(),
                ["http://quick/api/mcp"] = _ => Json(Tools("list_people")),
            },
        };
        var (catalog, warnings) = Build(handler);

        var tools = await catalog.BuildAsync(
            [Target("com.example.slow", "http://slow/api/mcp"), Target("com.example.quick", "http://quick/api/mcp")],
            CancellationToken.None);

        Assert.Equal(["com_dexample_dquick__list_people"], tools.Select(tool => tool.ExportedName));
        // Omitted, but never silently: an operator looking for a missing tool needs the reason.
        Assert.Contains(warnings, warning => warning.Contains("com.example.slow", StringComparison.Ordinal));
    }

    [Fact]
    public async Task AnAppTheActorMayNotReachIsAbsentBesideOneTheyCan()
    {
        // Visibility is Core's answer, given by refusing to mint a token — the CLI does not carry a
        // second copy of the access policy. The pair is the test: a connector that exported nothing
        // would satisfy the refusal on its own.
        var handler = new StubHandler { Responses = { ["http://ok/api/mcp"] = _ => Json(Tools("list_people")) } };
        var catalog = new ToolCatalog(
            new AppMcpClient(
                new HttpClient(handler),
                (appId, _) => Task.FromResult<string?>(appId == "com.example.denied" ? null : "token")),
            ToolKey.DefaultMaxToolNameChars,
            _ => { },
            Immediate);

        var tools = await catalog.BuildAsync(
            [Target("com.example.denied", "http://denied/api/mcp"), Target("com.example.ok", "http://ok/api/mcp")],
            CancellationToken.None);

        Assert.Equal(["com_dexample_dok__list_people"], tools.Select(tool => tool.ExportedName));
    }

    [Fact]
    public async Task AToolWithoutAReadOnlyHintIsNotExportedWhileItsSiblingIs()
    {
        // Fail-closed, end to end rather than on the predicate alone.
        var handler = new StubHandler
        {
            Responses =
            {
                ["http://a/api/mcp"] = _ => Json("""
                    {"jsonrpc":"2.0","id":1,"result":{"tools":[
                      {"name":"list_people","annotations":{"readOnlyHint":true}},
                      {"name":"delete_person","annotations":{"readOnlyHint":false}},
                      {"name":"rename_person"}
                    ]}}
                    """),
            },
        };
        var (catalog, warnings) = Build(handler);

        var tools = await catalog.BuildAsync([Target("com.example.a", "http://a/api/mcp")], CancellationToken.None);

        Assert.Equal(["com_dexample_da__list_people"], tools.Select(tool => tool.ExportedName));
        Assert.Contains(warnings, warning => warning.Contains("delete_person", StringComparison.Ordinal));
        // The one that declares nothing at all is refused too — absence is not permission.
        Assert.Contains(warnings, warning => warning.Contains("rename_person", StringComparison.Ordinal));
    }

    [Fact]
    public async Task AnAnswerOfTheWrongShapeIsSkippedRatherThanTakenAsAnEmptyFleet()
    {
        var handler = new StubHandler
        {
            Responses =
            {
                ["http://weird/api/mcp"] = _ => Json("""{"jsonrpc":"2.0","id":1,"result":{"items":[]}}"""),
                ["http://good/api/mcp"] = _ => Json(Tools("list_people")),
            },
        };
        var (catalog, warnings) = Build(handler);

        var tools = await catalog.BuildAsync(
            [Target("com.example.weird", "http://weird/api/mcp"), Target("com.example.good", "http://good/api/mcp")],
            CancellationToken.None);

        Assert.Single(tools);
        Assert.Contains(warnings, warning => warning.Contains("unexpected shape", StringComparison.Ordinal));
    }

    [Fact]
    public async Task AnHttpFailureFromTheAppIsReportedAsTheAppFailing()
    {
        var handler = new StubHandler
        {
            Responses = { ["http://a/api/mcp"] = _ => new HttpResponseMessage(HttpStatusCode.InternalServerError) },
        };
        var client = new AppMcpClient(new HttpClient(handler), (_, _) => Task.FromResult<string?>("token"));

        var result = await client.SendAsync(
            Target("com.example.a", "http://a/api/mcp"), "tools/list", null, Immediate, CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("app_error", result.Code);
    }

    [Fact]
    public async Task TheAppReceivesTheDelegatedTokenAndNothingElse()
    {
        HttpRequestMessage? seen = null;
        var handler = new StubHandler
        {
            Responses =
            {
                ["http://a/api/mcp"] = request =>
                {
                    seen = request;
                    return Json(Tools("list_people"));
                },
            },
        };
        var client = new AppMcpClient(new HttpClient(handler), (_, _) => Task.FromResult<string?>("the-token"));

        using var result = (await client.SendAsync(
            Target("com.example.a", "http://a/api/mcp"), "tools/list", null, Immediate, CancellationToken.None)).Document;

        Assert.Equal("Bearer the-token", seen!.Headers.Authorization?.ToString());
    }

    [Fact]
    public async Task TheLifecycleRunsBeforeAnythingElseAndTheSessionIdIsCarried()
    {
        // The protocol requires initialize first, and an app built on a standard MCP SDK rejects a
        // bare tools/list. An earlier cut skipped this and looked fine, because demo-app's hand-rolled
        // server does not enforce the lifecycle — so every SDK-based app would have silently vanished.
        var methods = new List<string>();
        var sessionHeaders = new List<string?>();
        var handler = new StubHandler
        {
            Responses =
            {
                ["http://a/api/mcp"] = request =>
                {
                    var body = request.Content!.ReadAsStringAsync().Result;
                    methods.Add(System.Text.Json.JsonDocument.Parse(body).RootElement
                        .GetProperty("method").GetString()!);
                    sessionHeaders.Add(request.Headers.TryGetValues("Mcp-Session-Id", out var v)
                        ? v.FirstOrDefault()
                        : null);
                    var response = Json(Tools("list_people"));
                    response.Headers.TryAddWithoutValidation("Mcp-Session-Id", "sess-1");
                    return response;
                },
            },
        };
        var (catalog, _) = Build(handler);

        await catalog.BuildAsync([Target("com.example.a", "http://a/api/mcp")], CancellationToken.None);

        Assert.Equal(["initialize", "notifications/initialized", "tools/list"], methods);
        // The id the app issued on initialize travels on everything after it.
        Assert.Equal([null, "sess-1", "sess-1"], sessionHeaders);
    }

    [Fact]
    public async Task TheHandshakeHappensOncePerEndpoint()
    {
        // Re-initializing on every call would triple the traffic and, on a stateful server, discard a
        // session it is holding open.
        var methods = new List<string>();
        var handler = new StubHandler
        {
            Responses =
            {
                ["http://a/api/mcp"] = request =>
                {
                    var body = request.Content!.ReadAsStringAsync().Result;
                    methods.Add(System.Text.Json.JsonDocument.Parse(body).RootElement
                        .GetProperty("method").GetString()!);
                    return Json(Tools("list_people"));
                },
            },
        };
        var (catalog, _) = Build(handler);
        var target = Target("com.example.a", "http://a/api/mcp");

        await catalog.BuildAsync([target], CancellationToken.None);
        await catalog.BuildAsync([target], CancellationToken.None);

        Assert.Equal(1, methods.Count(method => method == "initialize"));
        Assert.Equal(2, methods.Count(method => method == "tools/list"));
    }

    [Fact]
    public async Task ANonObjectResultIsSkippedRatherThanThrownOutOfTheFanOut()
    {
        // `TryGetProperty` throws on a non-object instead of returning false, so `{"result":null}`
        // escaped the unexpected-shape branch as an exception — and Task.WhenAll would have turned one
        // app's malformed answer into an empty catalog at session start.
        var handler = new StubHandler
        {
            Responses =
            {
                ["http://null/api/mcp"] = _ => Json("""{"jsonrpc":"2.0","id":1,"result":null}"""),
                ["http://scalar/api/mcp"] = _ => Json("""{"jsonrpc":"2.0","id":1,"result":42}"""),
                ["http://good/api/mcp"] = _ => Json(Tools("list_people")),
            },
        };
        var (catalog, _) = Build(handler);

        var tools = await catalog.BuildAsync(
            [
                Target("com.example.null", "http://null/api/mcp"),
                Target("com.example.scalar", "http://scalar/api/mcp"),
                Target("com.example.good", "http://good/api/mcp"),
            ],
            CancellationToken.None);

        // The healthy app still comes through, which is the property that was at risk.
        Assert.Equal(["com_dexample_dgood__list_people"], tools.Select(tool => tool.ExportedName));
    }

    [Fact]
    public async Task AnSseFramedAnswerIsUnderstood()
    {
        // A streamable-HTTP server answers a plain POST with a one-message SSE stream.
        var handler = new StubHandler
        {
            Responses =
            {
                ["http://a/api/mcp"] = _ => Sse("event: message\ndata: " + Tools("list_people") + "\n\n"),
            },
        };
        var (catalog, _) = Build(handler);

        var tools = await catalog.BuildAsync([Target("com.example.a", "http://a/api/mcp")], CancellationToken.None);

        Assert.Equal(["com_dexample_da__list_people"], tools.Select(tool => tool.ExportedName));
    }

    private static HttpResponseMessage Sse(string body)
        => new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "text/event-stream") };

    private static (ToolCatalog Catalog, List<string> Warnings) Build(StubHandler handler)
    {
        var warnings = new List<string>();
        var catalog = new ToolCatalog(
            new AppMcpClient(new HttpClient(handler), (_, _) => Task.FromResult<string?>("token")),
            ToolKey.DefaultMaxToolNameChars,
            warnings.Add,
            Immediate);
        return (catalog, warnings);
    }

    private static AppMcpTarget Target(string appId, string url) => new(appId, appId, "default", url);

    private static string Tools(string name)
        => """{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"NAME","annotations":{"readOnlyHint":true}}]}}"""
            .Replace("NAME", name, StringComparison.Ordinal);

    private static HttpResponseMessage Json(string body)
        => new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    /// <summary>Thrown by a stubbed app that never answers, so the client's timeout path is the one run.</summary>
    private sealed class TimeoutSignal : Exception;

    private sealed class StubHandler : HttpMessageHandler
    {
        public Dictionary<string, Func<HttpRequestMessage, HttpResponseMessage>> Responses { get; } =
            new(StringComparer.Ordinal);

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var url = request.RequestUri!.ToString();
            if (!Responses.TryGetValue(url, out var respond))
            {
                throw new HttpRequestException($"no stub for {url}");
            }

            try
            {
                return respond(request);
            }
            catch (TimeoutSignal)
            {
                // Hangs until the caller's own timeout cancels it — exactly what a wedged app does.
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                throw new UnreachableException();
            }
        }
    }
}
