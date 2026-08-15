namespace Haas.Hosty.Cli.Tests.Mcp;

using System.Text.Json;
using Haas.Hosty.Cli.Commands;
using Haas.Hosty.Cli.Mcp;

// Which apps are worth asking, and which of their tools an external client may see.
public class ToolCatalogTests
{
    [Fact]
    public void OnlyRunningAppsWithAResolvedMcpUrlAreAsked()
    {
        var targets = ToolCatalog.SelectTargets([
            App("com.example.running", "running", Mcp("default", "http://a/api/mcp")),
            App("com.example.stopped", "stopped", Mcp("default", "http://b/api/mcp")),
            App("com.example.nourl", "running", Mcp("default", url: null)),
            App("com.example.noninterface", "running"),
            App("com.example.otherinterface", "running", ("http", [new McpCommand.McpAppInterface("default", "/x", "http://c")])),
        ]);

        // The pair that matters: exactly one comes through, and it is the one that could answer.
        Assert.Equal(["com.example.running"], targets.Select(target => target.AppId));
    }

    [Fact]
    public void EveryDeclaredInterfaceOfAnAppBecomesItsOwnTarget()
    {
        // ValidateInterfaces permits several keyed mcp declarations per app, so the key has to travel
        // with the target — an app is not the unit here.
        var targets = ToolCatalog.SelectTargets([
            App(
                "com.example.notes",
                "running",
                ("mcp", [
                    new McpCommand.McpAppInterface("default", "/api/mcp", "http://a/api/mcp"),
                    new McpCommand.McpAppInterface("admin", "/api/mcp/admin", "http://a/api/mcp/admin"),
                ])),
        ]);

        Assert.Equal(["default", "admin"], targets.Select(target => target.InterfaceKey));
    }

    [Fact]
    public void OnlyAnExplicitReadOnlyHintCounts()
    {
        // Fail-closed, and this is the assertion that pins it: everything except a literal `true`
        // reads as "this might mutate". The field is optional and advisory, so treating its absence as
        // read-only would make the filter decorative.
        Assert.True(IsReadOnly("""{"annotations":{"readOnlyHint":true}}"""));

        Assert.False(IsReadOnly("""{}"""));
        Assert.False(IsReadOnly("""{"annotations":{}}"""));
        Assert.False(IsReadOnly("""{"annotations":{"readOnlyHint":false}}"""));
        // A string "true" is not a boolean true, and a client that coerced it would be guessing.
        Assert.False(IsReadOnly("""{"annotations":{"readOnlyHint":"true"}}"""));
        Assert.False(IsReadOnly("""{"annotations":{"destructiveHint":false}}"""));
        // Declaring it at the top level rather than under annotations is a plausible mistake, and it
        // must not be honoured — the spec puts it in annotations.
        Assert.False(IsReadOnly("""{"readOnlyHint":true}"""));
    }

    private static bool IsReadOnly(string json)
    {
        using var document = JsonDocument.Parse(json);
        return ToolCatalog.IsReadOnly(document.RootElement);
    }

    private static McpCommand.McpAppSummary App(
        string id,
        string runtimeState,
        params (string Name, IReadOnlyList<McpCommand.McpAppInterface> Declarations)[] interfaces)
        => new(
            id,
            id,
            runtimeState,
            interfaces.Length == 0
                ? null
                : interfaces.ToDictionary(entry => entry.Name, entry => entry.Declarations, StringComparer.Ordinal));

    private static (string, IReadOnlyList<McpCommand.McpAppInterface>) Mcp(string key, string? url)
        => ("mcp", [new McpCommand.McpAppInterface(key, "/api/mcp", url)]);
}
