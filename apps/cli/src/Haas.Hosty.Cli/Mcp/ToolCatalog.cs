namespace Haas.Hosty.Cli.Mcp;

using System.Text.Json;

/// <summary>
/// The fleet's tools as one list: what Core says is installed, fanned out to each app's own
/// <c>tools/list</c>, mapped onto client-facing names, and filtered to what an external client may
/// call.
/// </summary>
internal sealed class ToolCatalog(AppMcpClient client, int maxToolNameChars, Action<string> warn)
{
    /// <summary>
    /// Per-app ceiling on the fan-out. One slow app must cost the listing a bounded wait, never the
    /// listing itself — the alternative is a connector that hangs at session start because something
    /// unrelated is wedged.
    /// </summary>
    private static readonly TimeSpan ListTimeout = TimeSpan.FromSeconds(10);

    /// <summary>
    /// Selects the apps worth asking: running, and declaring at least one <c>mcp</c> interface Core
    /// resolved to a URL.
    /// </summary>
    /// <remarks>
    /// Visibility is deliberately <b>not</b> decided here. The control channel lists the whole fleet
    /// regardless of actor, so this filter is about reachability only; whether this actor may reach a
    /// given app is Core's answer, given when a token is requested, and an app whose token is refused
    /// drops out of the catalog below. Reimplementing the access policy in the CLI would mean two
    /// copies of it, and the CLI's copy would be the one nobody notices going stale.
    /// </remarks>
    public static IReadOnlyList<AppMcpTarget> SelectTargets(IReadOnlyList<Commands.McpCommand.McpAppSummary> apps)
    {
        var targets = new List<AppMcpTarget>();
        foreach (var app in apps)
        {
            if (!string.Equals(app.RuntimeState, "running", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (app.Interfaces is null || !app.Interfaces.TryGetValue("mcp", out var declarations))
            {
                continue;
            }

            foreach (var declaration in declarations)
            {
                if (!string.IsNullOrWhiteSpace(declaration.Url))
                {
                    targets.Add(new AppMcpTarget(
                        app.Id,
                        app.DisplayName,
                        string.IsNullOrWhiteSpace(declaration.Key) ? ToolKey.DefaultInterfaceKey : declaration.Key,
                        declaration.Url));
                }
            }
        }

        return targets;
    }

    /// <summary>
    /// Asks every target in parallel and returns what an external client may see. An app that is
    /// unreachable, refuses the actor, or answers with nonsense is omitted rather than fatal.
    /// </summary>
    public async Task<IReadOnlyList<ExportedTool>> BuildAsync(
        IReadOnlyList<AppMcpTarget> targets,
        CancellationToken cancellationToken)
    {
        var listed = await Task.WhenAll(targets.Select(target => ListAsync(target, cancellationToken)));

        var exported = new List<ExportedTool>();
        var claimed = new HashSet<string>(StringComparer.Ordinal);
        foreach (var tools in listed)
        {
            foreach (var tool in tools)
            {
                // Belt and braces over the mapping's own argument: if two exported names ever did
                // collide, dropping the second is far better than letting one app's tool silently
                // answer for another's. A hit here is a bug in ToolKey, so it is loud.
                if (!claimed.Add(tool.ExportedName))
                {
                    warn($"Tool name '{tool.ExportedName}' was produced twice; dropping the duplicate from {tool.Target.AppId}.");
                    continue;
                }

                exported.Add(tool);
            }
        }

        return exported;
    }

    private async Task<IReadOnlyList<ExportedTool>> ListAsync(AppMcpTarget target, CancellationToken cancellationToken)
    {
        var result = await client.SendAsync(target, "tools/list", writeParams: null, ListTimeout, cancellationToken);
        if (!result.Succeeded)
        {
            // Not a warning worth shouting about: a stopped app is an ordinary state of a Hosty host,
            // and this runs again on every poll.
            warn($"{target.AppId}: {result.Message}");
            return [];
        }

        using var document = result.Document!;
        if (!document.RootElement.TryGetProperty("result", out var payload) ||
            !payload.TryGetProperty("tools", out var tools) ||
            tools.ValueKind != JsonValueKind.Array)
        {
            warn($"{target.AppId} answered tools/list with an unexpected shape; skipping it.");
            return [];
        }

        var key = ToolKey.ForInterface(target.AppId, target.InterfaceKey);
        var exported = new List<ExportedTool>();
        foreach (var tool in tools.EnumerateArray())
        {
            if (!tool.TryGetProperty("name", out var nameElement) ||
                nameElement.ValueKind != JsonValueKind.String ||
                nameElement.GetString() is not { Length: > 0 } toolName)
            {
                continue;
            }

            if (!IsReadOnly(tool))
            {
                // Hidden, not listed-and-refused: the model gets no affordance it cannot use. The
                // server's instructions say the surface is filtered, which is where that belongs.
                warn($"{target.AppId}: '{toolName}' is not declared readOnlyHint: true, so it is not offered.");
                continue;
            }

            if (ToolKey.ForTool(key, toolName, maxToolNameChars) is not { } exportedName)
            {
                warn($"{target.AppId}: '{toolName}' cannot be given a usable client-facing name, so it is not offered.");
                continue;
            }

            exported.Add(new ExportedTool(exportedName, target, toolName, tool.Clone()));
        }

        return exported;
    }

    /// <summary>
    /// Fail-closed: only <c>annotations.readOnlyHint == true</c> counts as read-only.
    /// </summary>
    /// <remarks>
    /// External clients stay read-only until token scopes and an audit callback exist, and that has to
    /// be enforced here rather than delegated to the client — <c>readOnlyHint</c> is advisory metadata
    /// a hostile or careless client ignores. The field is optional, so treating its absence as
    /// read-only would make the filter decorative; the cost is that an app which declares nothing
    /// exports nothing, which is the honest reading of "we do not know what this does".
    /// </remarks>
    internal static bool IsReadOnly(JsonElement tool)
        => tool.TryGetProperty("annotations", out var annotations) &&
            annotations.ValueKind == JsonValueKind.Object &&
            annotations.TryGetProperty("readOnlyHint", out var hint) &&
            hint.ValueKind == JsonValueKind.True;
}

/// <summary>
/// One tool as the client will see it. <paramref name="Descriptor"/> is the app's own entry, cloned so
/// it outlives the response it came from and copied through unchanged apart from the name — schemas
/// and annotations included, since client permission policy keys off them.
/// </summary>
internal sealed record ExportedTool(
    string ExportedName,
    AppMcpTarget Target,
    string ToolName,
    JsonElement Descriptor);
