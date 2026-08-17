namespace Haas.Hosty.Cli.Mcp;

using System.Text;
using System.Text.Json;

/// <summary>
/// The MCP server an agent client spawns: newline-delimited JSON-RPC over stdio, presenting the whole
/// Hosty fleet as one server.
/// </summary>
/// <remarks>
/// Three methods and one notification, hand-rolled — see the decision in
/// docs/features/hosty-mcp-connector/feature.md. Nothing here writes to stdout except protocol messages;
/// diagnostics go to stderr, because a stray line on stdout corrupts the stream and the client's only
/// symptom is a server that "does not work".
/// </remarks>
internal sealed class StdioMcpServer(
    TextReader input,
    TextWriter output,
    TextWriter diagnostics,
    ToolCatalogSource catalog)
{
    private const string ProtocolVersion = "2025-06-18";

    /// <summary>Written into <c>initialize</c>, where a client shows it to the model.</summary>
    private const string Instructions =
        "Tools from every Hosty app on this host that exposes an MCP interface, named " +
        "<app>__<tool>. This connector is read-only: an app tool that does not declare itself " +
        "read-only is not offered at all, so a capability an app has may be absent here. Use the " +
        "Hosty host's own CLI for anything that changes state.";

    private readonly object writeLock = new();

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var line = await input.ReadLineAsync(cancellationToken);
            if (line is null)
            {
                // The client closed the pipe. That is how an MCP session ends; it is not a failure.
                return;
            }

            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            try
            {
                await DispatchAsync(line, cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // The guards below cover the shapes that are known to arrive, but both sides of this
                // process are untrusted input and the cost of being wrong once is the whole session:
                // an exception escaping here ends the loop, and the client sees a server that died
                // mid-conversation with no explanation. One bad message is worth one bad answer.
                WriteDiagnostic($"dropping a message that could not be handled: {ex.Message}");
            }
        }
    }

    /// <summary>
    /// Tells the client the tool list changed. Sent on a fleet change so a session picks up an app
    /// that was installed or stopped without being restarted — the reason this connector exists at all
    /// rather than a static config.
    /// </summary>
    public void NotifyToolsChanged()
        => Write(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("method", "notifications/tools/list_changed");
            writer.WriteEndObject();
        });

    private async Task DispatchAsync(string line, CancellationToken cancellationToken)
    {
        JsonDocument request;
        try
        {
            request = JsonDocument.Parse(line);
        }
        catch (JsonException)
        {
            WriteError(id: null, -32700, "Parse error.");
            return;
        }

        using (request)
        {
            var root = request.RootElement;
            var method = ReadString(root, "method");
            // A request has an id and expects a response; a notification has none and must never be
            // answered — replying to one is a protocol violation clients report as a stray message.
            var id = root.TryGetProperty("id", out var idElement) ? idElement.Clone() : (JsonElement?)null;

            switch (method)
            {
                case "initialize":
                    WriteInitialize(id);
                    return;
                case "notifications/initialized":
                    return;
                case "tools/list":
                    await WriteToolsAsync(id, cancellationToken);
                    return;
                case "tools/call":
                    await CallToolAsync(id, root, cancellationToken);
                    return;
                case "ping":
                    WriteResult(id, writer =>
                    {
                        writer.WriteStartObject();
                        writer.WriteEndObject();
                    });
                    return;
                default:
                    if (id is not null)
                    {
                        WriteError(id, -32601, $"Method '{method}' is not supported by the Hosty connector.");
                    }

                    return;
            }
        }
    }

    private void WriteInitialize(JsonElement? id)
        => WriteResult(id, writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("protocolVersion", ProtocolVersion);
            writer.WritePropertyName("capabilities");
            writer.WriteStartObject();
            writer.WritePropertyName("tools");
            writer.WriteStartObject();
            // The fleet changes under a running session, which is the whole reason for a connector.
            writer.WriteBoolean("listChanged", true);
            writer.WriteEndObject();
            writer.WriteEndObject();
            writer.WritePropertyName("serverInfo");
            writer.WriteStartObject();
            writer.WriteString("name", "hosty");
            writer.WriteString("version", CommandLine.Version);
            writer.WriteEndObject();
            writer.WriteString("instructions", Instructions);
            writer.WriteEndObject();
        });

    private async Task WriteToolsAsync(JsonElement? id, CancellationToken cancellationToken)
    {
        var tools = await catalog.GetAsync(cancellationToken);
        WriteResult(id, writer =>
        {
            writer.WriteStartObject();
            writer.WritePropertyName("tools");
            writer.WriteStartArray();
            foreach (var tool in tools)
            {
                WriteToolDescriptor(writer, tool);
            }

            writer.WriteEndArray();
            writer.WriteEndObject();
        });
    }

    /// <summary>
    /// Re-emits the app's own descriptor with only the name replaced, so schemas and annotations reach
    /// the client exactly as the app wrote them.
    /// </summary>
    private static void WriteToolDescriptor(Utf8JsonWriter writer, ExportedTool tool)
    {
        writer.WriteStartObject();
        writer.WriteString("name", tool.ExportedName);
        foreach (var property in tool.Descriptor.EnumerateObject())
        {
            if (string.Equals(property.Name, "name", StringComparison.Ordinal))
            {
                continue;
            }

            if (string.Equals(property.Name, "description", StringComparison.Ordinal))
            {
                // Which app a tool belongs to is not in its own description — the app had no reason to
                // say so — and the model needs it to choose between two apps offering similar tools.
                //
                // Only when it IS a string. An app is untrusted input here: a description that is null,
                // a number, or an object would otherwise throw out of the write and, since this runs
                // inside the request loop, take the whole connector down over one malformed descriptor.
                if (property.Value.ValueKind == JsonValueKind.String)
                {
                    writer.WriteString("description", $"[{tool.Target.DisplayName}] {property.Value.GetString()}");
                }
                else
                {
                    property.WriteTo(writer);
                }

                continue;
            }

            property.WriteTo(writer);
        }

        if (!tool.Descriptor.TryGetProperty("description", out _))
        {
            writer.WriteString("description", $"[{tool.Target.DisplayName}] {tool.ToolName}");
        }

        writer.WriteEndObject();
    }

    private async Task CallToolAsync(JsonElement? id, JsonElement root, CancellationToken cancellationToken)
    {
        if (!root.TryGetProperty("params", out var parameters) ||
            ReadString(parameters, "name") is not { Length: > 0 } requested)
        {
            WriteError(id, -32602, "tools/call requires a params.name.");
            return;
        }

        var tools = await catalog.GetAsync(cancellationToken);
        var tool = tools.FirstOrDefault(candidate =>
            string.Equals(candidate.ExportedName, requested, StringComparison.Ordinal));
        if (tool is null)
        {
            // Also the refusal path for a mutating tool a client kept from a stale list: it is not in
            // the catalog, so it cannot be called even though the client still believes in it.
            WriteToolFailure(id, $"'{requested}' is not an available Hosty tool. It may belong to an app that stopped, or it may not be read-only.");
            return;
        }

        var arguments = parameters.TryGetProperty("arguments", out var argumentsElement)
            ? argumentsElement.Clone()
            : (JsonElement?)null;

        var result = await catalog.CallAsync(tool, arguments, cancellationToken);
        if (!result.Succeeded)
        {
            // The app is unavailable — reported for this call only, leaving the session and every
            // other app working.
            WriteToolFailure(id, $"{result.Code}: {result.Message}");
            return;
        }

        using var document = result.Document!;
        if (document.RootElement.TryGetProperty("result", out var payload))
        {
            WriteResult(id, writer => payload.WriteTo(writer));
            return;
        }

        // The app answered with a JSON-RPC error. Relayed as a tool failure rather than as a protocol
        // error, because the call reached the app and was refused by it — the model should read that
        // as the tool saying no, and be able to carry on.
        var message = document.RootElement.TryGetProperty("error", out var error)
            ? ReadString(error, "message") ?? "the app refused the call without explanation"
            : "the app refused the call without explanation";
        WriteToolFailure(id, $"{tool.Target.AppId} refused this call: {message}");
    }

    /// <summary>
    /// A failed call, reported the way the protocol expects: a normal result carrying
    /// <c>isError: true</c>, so the client knows the call failed and the model can still read why and
    /// choose something else. A JSON-RPC error would instead end the turn.
    /// </summary>
    private void WriteToolFailure(JsonElement? id, string message)
        => WriteResult(id, writer =>
        {
            writer.WriteStartObject();
            writer.WriteBoolean("isError", true);
            writer.WritePropertyName("content");
            writer.WriteStartArray();
            writer.WriteStartObject();
            writer.WriteString("type", "text");
            writer.WriteString("text", message);
            writer.WriteEndObject();
            writer.WriteEndArray();
            writer.WriteEndObject();
        });

    private void WriteResult(JsonElement? id, Action<Utf8JsonWriter> writeResult)
    {
        if (id is null)
        {
            return;
        }

        Write(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WritePropertyName("id");
            id.Value.WriteTo(writer);
            writer.WritePropertyName("result");
            writeResult(writer);
            writer.WriteEndObject();
        });
    }

    private void WriteError(JsonElement? id, int code, string message)
        => Write(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WritePropertyName("id");
            if (id is null)
            {
                writer.WriteNullValue();
            }
            else
            {
                id.Value.WriteTo(writer);
            }

            writer.WritePropertyName("error");
            writer.WriteStartObject();
            writer.WriteNumber("code", code);
            writer.WriteString("message", message);
            writer.WriteEndObject();
            writer.WriteEndObject();
        });

    private void Write(Action<Utf8JsonWriter> writeMessage)
    {
        var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writeMessage(writer);
        }

        var line = Encoding.UTF8.GetString(buffer.ToArray());

        // The poll timer and the request loop both reach here, and a message interleaved with another
        // is an unparseable line to the client rather than a recoverable error.
        lock (writeLock)
        {
            output.WriteLine(line);
            output.Flush();
        }
    }

    /// <summary>
    /// A string property, or null when it is absent or is some other JSON type. Both the client and the
    /// apps are untrusted input here, and <see cref="JsonElement.GetString"/> throws rather than
    /// returning null when the value is a number or an object.
    /// </summary>
    private static string? ReadString(JsonElement element, string property)
        => element.ValueKind == JsonValueKind.Object &&
            element.TryGetProperty(property, out var value) &&
            value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;

    internal void WriteDiagnostic(string message)
        => diagnostics.WriteLine($"[hosty mcp] {message}");
}

/// <summary>
/// What the protocol loop needs from the fleet, kept behind an interface so the server can be driven
/// in tests without Core or an app.
/// </summary>
internal interface ToolCatalogSource
{
    Task<IReadOnlyList<ExportedTool>> GetAsync(CancellationToken cancellationToken);

    Task<AppMcpResult> CallAsync(ExportedTool tool, JsonElement? arguments, CancellationToken cancellationToken);
}
