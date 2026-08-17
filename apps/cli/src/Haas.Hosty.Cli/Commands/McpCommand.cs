namespace Haas.Hosty.Cli.Commands;

using System.Text.Json;
using System.Text.Json.Serialization;
using Haas.Hosty.Cli.Mcp;
using Spectre.Console;

/// <summary>
/// <c>hosty mcp</c> — a stdio MCP server presenting the whole Hosty fleet as one server.
/// </summary>
/// <remarks>
/// It exists because a static client config can follow neither a changing fleet nor an expiring
/// credential: MCP clients fix their server list at session start, and an app's delegated token lives
/// five minutes, so a header pasted into <c>.mcp.json</c> is dead almost immediately. Being a process
/// rather than a file fixes both — it discovers on the fly and holds the credential itself.
/// See docs/features/hosty-mcp-connector/feature.md.
/// </remarks>
internal sealed partial class McpCommand(CommandContext context)
{
    internal const string Usage = """
        Usage: hosty mcp --user <email-or-id> [--max-tool-name <n>]

          Runs a Model Context Protocol server on stdin/stdout, exporting the read-only tools of
          every running app on this host that declares an mcp interface.

          --user            Host user the connector acts as. Required: the local control channel
                            identifies no user, and an app's access check needs a concrete one.
          --max-tool-name   Ceiling on exported tool names (default 52). A client prepends its own
                            "mcp__<server>__", so this keeps the name the model sees within 64.

        Register it with an agent client, for example in .mcp.json:

          { "mcpServers": { "hosty": { "command": "hosty",
              "args": ["mcp", "--user", "you@example.com"] } } }
        """;

    /// <summary>
    /// How often the fleet is re-read. Slow enough to be invisible on a local control channel, fast
    /// enough that installing an app shows up in a session the operator is already in.
    /// </summary>
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(30);

    public async Task<int> ExecuteAsync(string[] args)
    {
        // The root help tells the operator to run `hosty <command> --help`, so this has to answer it
        // rather than reject it as an unknown argument — every other command already does.
        if (args is ["--help"] or ["-h"] or ["help"])
        {
            context.Console.WriteLine(Usage);
            return 0;
        }

        var options = ParseOptions(args);

        // Every diagnostic goes to stderr. stdout carries the protocol, and one stray line on it
        // corrupts the stream — the client's only symptom being a server that "does not work".
        var diagnostics = Console.Error;

        using var control = await CoreControlClient.TryCreateAsync(context, cancellationToken: CancellationToken.None)
            ?? throw new CoreNotRunningException();

        using var http = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
        var tokens = new DelegatedTokenCache(
            async (appId, cancellationToken) =>
            {
                var issued = await control.PostAsync<DelegatedTokenResponse>(
                    $"apps/{Uri.EscapeDataString(appId)}/delegated-token",
                    new DelegatedTokenRequest(options.User),
                    cancellationToken);
                return issued is null ? null : new IssuedToken(issued.Token, issued.ExpiresAt);
            },
            TimeProvider.System,
            message => diagnostics.WriteLine($"[hosty mcp] {message}"));
        var client = new AppMcpClient(http, tokens.TryGetAsync);

        using var lifetime = new CancellationTokenSource();
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            lifetime.Cancel();
        };

        var catalog = new LiveToolCatalog(control, client, options.MaxToolNameChars, diagnostics);
        var server = new StdioMcpServer(Console.In, Console.Out, diagnostics, catalog);
        catalog.Changed += server.NotifyToolsChanged;

        diagnostics.WriteLine($"[hosty mcp] serving as {options.User}; watching {control.ControlBaseUrl}");

        var poll = catalog.PollAsync(PollInterval, lifetime.Token);
        try
        {
            await server.RunAsync(lifetime.Token);
        }
        finally
        {
            await lifetime.CancelAsync();
            await poll.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
        }

        return 0;
    }

    internal static McpOptions ParseOptions(string[] args)
    {
        string? user = null;
        var maxToolNameChars = ToolKey.DefaultMaxToolNameChars;

        for (var index = 0; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--user" when index + 1 < args.Length:
                    user = args[++index];
                    break;
                case "--max-tool-name" when index + 1 < args.Length:
                    if (!int.TryParse(args[++index], out maxToolNameChars) || maxToolNameChars < 16)
                    {
                        throw new CommandUsageException("--max-tool-name must be an integer of at least 16.", Usage);
                    }

                    break;
                case "--context":
                    // Recognised only to answer it plainly. The CLI is local-only by decision, not by
                    // omission (docs/features/access-tokens/feature.md), so this is not a feature
                    // pending arrival. Someone reaching for the flag is pointing at the wrong host and
                    // deserves the alternative rather than a bare "unknown argument".
                    throw new CommandUsageException(
                        "hosty is local-only: it serves the host it runs on. To reach a remote fleet, "
                        + "run the connector there over SSH — "
                        + "\"command\": \"ssh\", \"args\": [\"user@host\", \"hosty\", \"mcp\", \"--user\", \"...\"].",
                        Usage);
                default:
                    throw new CommandUsageException($"Unknown mcp argument '{args[index]}'.", Usage);
            }
        }

        if (string.IsNullOrWhiteSpace(user))
        {
            throw new CommandUsageException(
                "hosty mcp requires --user <email-or-id>: the local control channel identifies no user, " +
                "and an app decides what a caller may see from the Hosty user it acts for.",
                Usage);
        }

        return new McpOptions(user.Trim(), maxToolNameChars);
    }

    internal sealed record McpOptions(string User, int MaxToolNameChars);

    /// <summary>Reads the fleet from Core, keeps the catalog current, and calls tools on it.</summary>
    private sealed class LiveToolCatalog(
        CoreControlClient control,
        AppMcpClient client,
        int maxToolNameChars,
        TextWriter diagnostics) : ToolCatalogSource
    {
        /// <summary>A tool call may legitimately do real work, so it is not held to the list timeout.</summary>
        private static readonly TimeSpan CallTimeout = TimeSpan.FromMinutes(2);

        private readonly ToolCatalog catalog = new(
            client,
            maxToolNameChars,
            message => diagnostics.WriteLine($"[hosty mcp] {message}"));

        private readonly SemaphoreSlim gate = new(1, 1);
        private IReadOnlyList<ExportedTool> current = [];
        private bool loaded;

        public event Action? Changed;

        public async Task<IReadOnlyList<ExportedTool>> GetAsync(CancellationToken cancellationToken)
        {
            if (loaded)
            {
                return current;
            }

            await RefreshAsync(cancellationToken);
            return current;
        }

        public Task<AppMcpResult> CallAsync(ExportedTool tool, JsonElement? arguments, CancellationToken cancellationToken)
            => client.SendAsync(
                tool.Target,
                "tools/call",
                writer =>
                {
                    writer.WriteStartObject();
                    // The app's own name, not the exported one: the namespacing is this connector's,
                    // and the app has never heard of it.
                    writer.WriteString("name", tool.ToolName);
                    writer.WritePropertyName("arguments");
                    if (arguments is null)
                    {
                        writer.WriteStartObject();
                        writer.WriteEndObject();
                    }
                    else
                    {
                        arguments.Value.WriteTo(writer);
                    }

                    writer.WriteEndObject();
                },
                CallTimeout,
                cancellationToken);

        /// <summary>
        /// Re-reads the fleet on a timer and tells the client when what it can call has changed. This
        /// is what lets an app installed or stopped mid-session appear or disappear without the client
        /// being restarted.
        /// </summary>
        public async Task PollAsync(TimeSpan interval, CancellationToken cancellationToken)
        {
            using var timer = new PeriodicTimer(interval);
            try
            {
                while (await timer.WaitForNextTickAsync(cancellationToken))
                {
                    var before = Signature(current);
                    await RefreshAsync(cancellationToken);
                    if (!string.Equals(before, Signature(current), StringComparison.Ordinal))
                    {
                        Changed?.Invoke();
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // Shutdown.
            }
        }

        private async Task RefreshAsync(CancellationToken cancellationToken)
        {
            await gate.WaitAsync(cancellationToken);
            try
            {
                var apps = await control.GetAsync<McpAppsResponse>("apps", cancellationToken);
                if (apps is null)
                {
                    // An unreachable Core is not an empty fleet, and reporting one as the other would
                    // tell the model every app vanished. The previous catalog stands until Core answers.
                    diagnostics.WriteLine("[hosty mcp] Hosty Core did not answer; keeping the previous tool list.");
                    return;
                }

                current = await catalog.BuildAsync(ToolCatalog.SelectTargets(apps.Apps), cancellationToken);
                loaded = true;
            }
            catch (Exception ex) when (ex is CoreControlException or CoreControlTimeoutException)
            {
                diagnostics.WriteLine($"[hosty mcp] Hosty Core is not answering ({ex.Message}); keeping the previous tool list.");
            }
            finally
            {
                gate.Release();
            }
        }

        /// <summary>
        /// Everything about the catalog a client can observe, so any of it changing sends the
        /// notification.
        /// </summary>
        /// <remarks>
        /// Names alone are not enough, and the gap was real: an app update that keeps a tool's name
        /// while changing its input schema, its annotations, or its description would have left a
        /// connected client using the cached descriptor — submitting stale arguments, or applying
        /// permission metadata the app has since revised. The display name is in here too, since it is
        /// rendered into the description the model reads.
        /// </remarks>
        private static string Signature(IReadOnlyList<ExportedTool> tools)
            => string.Join(
                '\n',
                tools
                    .Select(tool => $"{tool.ExportedName}\u001f{tool.Target.DisplayName}\u001f{tool.Descriptor.GetRawText()}")
                    .Order(StringComparer.Ordinal));
    }

    [JsonSourceGenerationOptions(
        PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true)]
    [JsonSerializable(typeof(McpAppsResponse))]
    [JsonSerializable(typeof(DelegatedTokenRequest))]
    [JsonSerializable(typeof(DelegatedTokenResponse))]
    internal partial class McpJsonContext : JsonSerializerContext;

    internal sealed record McpAppsResponse(IReadOnlyList<McpAppSummary> Apps);

    /// <summary>
    /// The subset of Core's app summary this connector reads. Extra members Core sends are ignored,
    /// which is what lets Core's richer shape evolve without breaking the connector.
    /// </summary>
    internal sealed record McpAppSummary(
        string Id,
        string DisplayName,
        string RuntimeState,
        IReadOnlyDictionary<string, IReadOnlyList<McpAppInterface>>? Interfaces = null);

    /// <summary>A declared interface, already resolved to a callable URL by Core.</summary>
    internal sealed record McpAppInterface(string Key, string Path, string? Url = null);

    internal sealed record DelegatedTokenRequest(string User);

    internal sealed record DelegatedTokenResponse(
        string Token,
        string TokenType,
        string AppId,
        DateTimeOffset ExpiresAt,
        int ExpiresInSeconds);
}
