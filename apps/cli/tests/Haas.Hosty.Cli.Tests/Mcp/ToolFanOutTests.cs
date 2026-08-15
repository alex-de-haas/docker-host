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
