namespace Haas.Hosty.Cli.Mcp;

using System.Diagnostics;
using System.Text.Json;

/// <summary>
/// The fleet's tools as one list: what Core says is installed, fanned out to each app's own
/// <c>tools/list</c>, mapped onto client-facing names, and filtered to what an external client may
/// call.
/// </summary>
/// <param name="listTimeout">
/// Ceiling on reading one app's tools. A slow app must cost the listing a bounded wait, never the
/// listing itself — the alternative is a connector that hangs at session start because something
/// unrelated is wedged. Shortened by tests, which would otherwise spend the real wait proving it.
/// <para>
/// A page walk shares one of these rather than taking a fresh one per page, so an app that answers
/// every page just inside the ceiling cannot hold the fan-out for <see cref="MaxPages"/> times as
/// long. The lifecycle steps inside the first request still spend it per step, as they did before
/// there was a walk to bound.
/// </para>
/// </param>
internal sealed class ToolCatalog(
    AppMcpClient client,
    int maxToolNameChars,
    Action<string> warn,
    TimeSpan? listTimeout = null)
{
    /// <summary>
    /// Ceiling on the <c>tools/list</c> pages followed for one app. Generous for any real app, and
    /// finite because the cursor is the app's own: one that hands back a cursor forever must not spin
    /// here forever.
    /// </summary>
    internal const int MaxPages = 20;

    private readonly TimeSpan listTimeout = listTimeout ?? TimeSpan.FromSeconds(10);

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
        // Every app is isolated: one that throws must cost the catalog that app, never the listing.
        // Task.WhenAll surfaces the first exception and abandons the rest, which would have turned one
        // malformed response into an empty tool list at session start.
        var listed = await Task.WhenAll(targets.Select(async target =>
        {
            try
            {
                return await ListAsync(target, cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                warn($"{target.AppId}: its tools could not be read ({ex.Message}); skipping it.");
                return [];
            }
        }));

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

    /// <summary>
    /// Walks one app's <c>tools/list</c> to the end, following <c>nextCursor</c>.
    /// </summary>
    /// <remarks>
    /// Paginated because the method is: reading one page left an app's later tools out of the catalog
    /// entirely — absent and uncallable, with no symptom beyond their not being there.
    /// <para>
    /// A page that cannot be read keeps the pages already read, and the choice was weighed rather than
    /// assumed. Read the same walk as a **permission grant** and the answer inverts: a truncated grant
    /// cannot be told from a complete one where it is consulted, so refusing the whole answer is the
    /// only safe reading. What comes back here is a **catalog** — every tool in it passed the read-only
    /// filter on its own, and every call is checked against it — so a short catalog costs reach rather
    /// than safety. Dropping the app instead would take away tools that work to punish a page that did
    /// not, and would contradict the fan-out above, where one app failing costs the catalog that app
    /// and nothing else.
    /// </para>
    /// </remarks>
    private async Task<IReadOnlyList<ExportedTool>> ListAsync(AppMcpTarget target, CancellationToken cancellationToken)
    {
        var key = ToolKey.ForInterface(target.AppId, target.InterfaceKey);
        var exported = new List<ExportedTool>();
        // The app's own names, so a page walk that hands the same tool back twice judges it once. The
        // duplicate would be dropped downstream anyway, but by the check that treats a collision as a
        // bug in ToolKey — which a repeated page is not.
        var seen = new HashSet<string>(StringComparer.Ordinal);
        string? cursor = null;
        var spent = Stopwatch.StartNew();

        for (var page = 0; page < MaxPages; page++)
        {
            // Every page spends what is left of the app's one budget rather than taking a fresh
            // ceiling. A per-page ceiling let an app answering each page just inside it hold the
            // fan-out for MaxPages times as long — and the fan-out is what a client waits on before it
            // sees any tools at all.
            var remaining = listTimeout - spent.Elapsed;
            if (remaining <= TimeSpan.Zero)
            {
                warn($"{target.AppId} did not finish its tool list within {listTimeout.TotalSeconds:0.#} seconds; keeping the {exported.Count} tools read so far.");
                return exported;
            }

            var sending = cursor;
            var result = await client.SendAsync(
                target,
                "tools/list",
                sending is null
                    ? null
                    : writer =>
                    {
                        writer.WriteStartObject();
                        writer.WriteString("cursor", sending);
                        writer.WriteEndObject();
                    },
                remaining,
                cancellationToken);
            if (!result.Succeeded)
            {
                // Not a warning worth shouting about: a stopped app is an ordinary state of a Hosty
                // host, and this runs again on every poll.
                warn(page == 0
                    ? $"{target.AppId}: {result.Message}"
                    : $"{target.AppId}: {result.Message} (page {page + 1} of its tool list); keeping the {exported.Count} tools read before it.");
                return exported;
            }

            using var document = result.Document!;
            // Every ValueKind is checked before descending. TryGetProperty THROWS on a non-object rather
            // than returning false, so `{"result":null}` from one app would otherwise have escaped this
            // branch as an exception instead of being the unexpected shape it is.
            if (document.RootElement.ValueKind != JsonValueKind.Object ||
                !document.RootElement.TryGetProperty("result", out var payload) ||
                payload.ValueKind != JsonValueKind.Object ||
                !payload.TryGetProperty("tools", out var tools) ||
                tools.ValueKind != JsonValueKind.Array)
            {
                warn(page == 0
                    ? $"{target.AppId} answered tools/list with an unexpected shape; skipping it."
                    : $"{target.AppId} answered page {page + 1} of tools/list with an unexpected shape; keeping the {exported.Count} tools read before it.");
                return exported;
            }

            foreach (var tool in tools.EnumerateArray())
            {
                if (tool.ValueKind != JsonValueKind.Object ||
                    !tool.TryGetProperty("name", out var nameElement) ||
                    nameElement.ValueKind != JsonValueKind.String ||
                    nameElement.GetString() is not { Length: > 0 } toolName ||
                    !seen.Add(toolName))
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

            // Absent, empty, or anything but a string ends the walk. The spec's own signal for a last
            // page is an absent cursor, and a malformed one is not something to keep asking about.
            if (!payload.TryGetProperty("nextCursor", out var next) ||
                next.ValueKind != JsonValueKind.String ||
                next.GetString() is not { Length: > 0 } nextCursor)
            {
                return exported;
            }

            cursor = nextCursor;
        }

        warn($"{target.AppId} is still paginating its tool list after {MaxPages} pages; keeping the {exported.Count} tools read so far.");
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
        => tool.ValueKind == JsonValueKind.Object &&
            tool.TryGetProperty("annotations", out var annotations) &&
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
