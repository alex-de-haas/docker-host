namespace Haas.Hosty.Cli.Mcp;

using System.Text;
using System.Text.Json;

/// <summary>
/// Speaks JSON-RPC to one app's MCP endpoint over HTTP, presenting a freshly obtained delegated token.
/// </summary>
/// <remarks>
/// Hand-rolled against <see cref="Utf8JsonWriter"/> and <see cref="JsonDocument"/> rather than built on
/// the MCP SDK — the decision and its reasoning are in docs/features/hosty-mcp-connector/plan.md. The
/// short version: this CLI publishes as Native AOT with one dependency and no trim warnings, the
/// surface needed here is two methods, and an app's tool schemas are arbitrary JSON that is copied
/// through rather than modelled.
/// </remarks>
/// <param name="tokenFor">
/// Yields a delegated token for an app, or null when Core will not issue one. A delegate rather than
/// the cache itself: it is the whole dependency on Core, and taking it this way lets the fan-out and
/// its failure modes be driven without a running host.
/// </param>
internal sealed class AppMcpClient(HttpClient http, Func<string, CancellationToken, Task<string?>> tokenFor)
{
    /// <summary>The protocol revision this connector speaks to apps.</summary>
    private const string ProtocolVersion = "2025-06-18";

    /// <summary>
    /// Per-endpoint handshake state: whether `initialize` has been done, and the session id the app
    /// handed back if it is stateful.
    /// </summary>
    private readonly Dictionary<string, AppSession> sessions = new(StringComparer.Ordinal);

    private readonly SemaphoreSlim handshakeGate = new(1, 1);

    /// <summary>
    /// Runs the MCP lifecycle against an endpoint once, and remembers its session id.
    /// </summary>
    /// <remarks>
    /// Not optional, and its absence was a real defect rather than a tidiness point: the protocol
    /// requires `initialize` before any other request, and an app built on a standard MCP SDK
    /// <b>rejects</b> a bare `tools/list`. Sending one first meant every such app silently vanished
    /// from the catalog while a hand-rolled server like demo-app's — which does not enforce the
    /// lifecycle — worked, so the gap was invisible in exactly the setup it was developed against.
    /// A stateful server also issues `Mcp-Session-Id` here, which every later request must carry.
    /// </remarks>
    private async Task<AppSession> EnsureInitializedAsync(
        AppMcpTarget target,
        string token,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        await handshakeGate.WaitAsync(cancellationToken);
        try
        {
            if (sessions.TryGetValue(target.Url, out var existing))
            {
                return existing;
            }

            var response = await PostAsync(
                target,
                token,
                sessionId: null,
                "initialize",
                writer =>
                {
                    writer.WriteStartObject();
                    writer.WriteString("protocolVersion", ProtocolVersion);
                    writer.WritePropertyName("capabilities");
                    writer.WriteStartObject();
                    writer.WriteEndObject();
                    writer.WritePropertyName("clientInfo");
                    writer.WriteStartObject();
                    writer.WriteString("name", "hosty-mcp-connector");
                    writer.WriteString("version", CommandLine.Version);
                    writer.WriteEndObject();
                    writer.WriteEndObject();
                },
                timeout,
                cancellationToken);

            var session = new AppSession(response.SessionId);
            if (response.Result.Succeeded)
            {
                response.Result.Document!.Dispose();
                // Best effort: an app that ignores the notification is not broken, and one that is
                // unreachable will fail the next real request with a better message than this one.
                await PostAsync(
                    target,
                    token,
                    session.SessionId,
                    "notifications/initialized",
                    writeParams: null,
                    timeout,
                    cancellationToken,
                    notification: true);
                sessions[target.Url] = session;
            }

            return session;
        }
        finally
        {
            handshakeGate.Release();
        }
    }

    /// <summary>Forgets an endpoint's handshake, so the next call redoes it.</summary>
    /// <remarks>
    /// A restarted app loses its session while the connector still holds the id, and the app answers
    /// with a 4xx that would otherwise repeat forever.
    /// </remarks>
    private void Forget(string url)
    {
        handshakeGate.Wait();
        try
        {
            sessions.Remove(url);
        }
        finally
        {
            handshakeGate.Release();
        }
    }

    /// <summary>
    /// Sends one JSON-RPC request and returns the parsed response, or a failure describing why not.
    /// </summary>
    /// <remarks>
    /// The caller owns the returned <see cref="JsonDocument"/>. Transport problems are values rather
    /// than exceptions because every one of them means the same thing to the session: this app is not
    /// answering right now, and the other apps are unaffected.
    /// </remarks>
    public async Task<AppMcpResult> SendAsync(
        AppMcpTarget target,
        string method,
        Action<Utf8JsonWriter>? writeParams,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        var token = await tokenFor(target.AppId, cancellationToken);
        if (token is null)
        {
            return AppMcpResult.Unavailable(
                "app_unauthorized",
                $"No Hosty credential is available for {target.AppId}; this user may not have access to it.");
        }

        // The handshake shares the caller's budget: a wedged app must cost the fan-out one timeout,
        // not one per protocol step.
        var session = await EnsureInitializedAsync(target, token, timeout, cancellationToken);
        var sent = await PostAsync(target, token, session.SessionId, method, writeParams, timeout, cancellationToken);

        // A session the app no longer recognises — it restarted, or expired the id — reads as an
        // ordinary rejection. Drop the handshake so the next call re-establishes it rather than
        // repeating a request the app will refuse forever.
        if (!sent.Result.Succeeded && sent.Rejected && session.SessionId is not null)
        {
            Forget(target.Url);
        }

        return sent.Result;
    }

    private async Task<AppMcpExchange> PostAsync(
        AppMcpTarget target,
        string token,
        string? sessionId,
        string method,
        Action<Utf8JsonWriter>? writeParams,
        TimeSpan timeout,
        CancellationToken cancellationToken,
        bool notification = false)
    {
        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(timeout);

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, target.Url)
            {
                Content = new StringContent(
                    BuildRequest(method, writeParams, notification), Encoding.UTF8, "application/json"),
            };
            request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {token}");
            // Both, because a streamable-HTTP server may answer either way and one that cannot match
            // the Accept header refuses the request outright.
            request.Headers.TryAddWithoutValidation("Accept", "application/json, text/event-stream");
            request.Headers.TryAddWithoutValidation("MCP-Protocol-Version", ProtocolVersion);
            if (sessionId is not null)
            {
                request.Headers.TryAddWithoutValidation("Mcp-Session-Id", sessionId);
            }

            using var response = await http.SendAsync(request, timeoutSource.Token);
            var issued = response.Headers.TryGetValues("Mcp-Session-Id", out var values)
                ? values.FirstOrDefault()
                : null;
            var body = await response.Content.ReadAsStringAsync(timeoutSource.Token);
            if (!response.IsSuccessStatusCode)
            {
                return new AppMcpExchange(
                    AppMcpResult.Unavailable(
                        "app_error",
                        $"{target.AppId} answered its MCP endpoint with HTTP {(int)response.StatusCode}."),
                    issued,
                    Rejected: (int)response.StatusCode is >= 400 and < 500);
            }

            // A notification has no response body to parse, and an empty 202 is the correct answer.
            if (notification || string.IsNullOrWhiteSpace(body))
            {
                return new AppMcpExchange(AppMcpResult.Ok(JsonDocument.Parse("{}")), issued, Rejected: false);
            }

            return new AppMcpExchange(AppMcpResult.Ok(ParseBody(body)), issued, Rejected: false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            // A stopped app is the common cause and is not an error the session should carry: one app
            // being unreachable must never take down the fan-out or the connector.
            return new AppMcpExchange(
                AppMcpResult.Unavailable(
                    "app_stopped",
                    $"{target.AppId} did not answer within {timeout.TotalSeconds:0} seconds; it may be stopped."),
                null,
                Rejected: false);
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException)
        {
            return new AppMcpExchange(
                AppMcpResult.Unavailable(
                    "app_stopped",
                    $"{target.AppId} is not reachable at its MCP endpoint; it may be stopped."),
                null,
                Rejected: false);
        }
    }

    /// <summary>
    /// Parses a JSON-RPC response that may have arrived as a one-message SSE stream, which is how a
    /// streamable-HTTP server answers a plain POST.
    /// </summary>
    private static JsonDocument ParseBody(string body)
    {
        var trimmed = body.TrimStart();
        if (trimmed.StartsWith('{') || trimmed.StartsWith('['))
        {
            return JsonDocument.Parse(trimmed);
        }

        foreach (var line in body.Split('\n'))
        {
            if (line.StartsWith("data:", StringComparison.Ordinal))
            {
                return JsonDocument.Parse(line["data:".Length..].Trim());
            }
        }

        throw new JsonException("The app's answer was neither JSON nor an SSE data frame.");
    }

    private static string BuildRequest(string method, Action<Utf8JsonWriter>? writeParams, bool notification)
    {
        var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            // A fixed id is safe because every exchange here is one request on its own connection —
            // there is no pipelining to correlate. A notification carries none at all, and adding one
            // would make the app answer something the protocol says it must not.
            if (!notification)
            {
                writer.WriteNumber("id", 1);
            }

            writer.WriteString("method", method);
            if (writeParams is not null)
            {
                writer.WritePropertyName("params");
                writeParams(writer);
            }

            writer.WriteEndObject();
        }

        return Encoding.UTF8.GetString(buffer.ToArray());
    }
}

/// <summary>What one exchange produced, plus the two things the caller needs to manage a session.</summary>
internal sealed record AppMcpExchange(AppMcpResult Result, string? SessionId, bool Rejected);

/// <summary>An endpoint's handshake state. Null id means the app is stateless, which is allowed.</summary>
internal sealed record AppSession(string? SessionId);

/// <summary>One app's resolved MCP interface: which app, which declared key, and where it lives.</summary>
internal sealed record AppMcpTarget(string AppId, string DisplayName, string InterfaceKey, string Url);

/// <summary>
/// Either a parsed JSON-RPC response or a structured reason the app could not answer. The failure
/// carries a code the connector relays verbatim, so a client can distinguish "this app is stopped"
/// from "this call was refused".
/// </summary>
internal sealed class AppMcpResult
{
    private AppMcpResult(JsonDocument? document, string? code, string? message)
    {
        Document = document;
        Code = code;
        Message = message;
    }

    public JsonDocument? Document { get; }

    public string? Code { get; }

    public string? Message { get; }

    public bool Succeeded => Document is not null;

    public static AppMcpResult Ok(JsonDocument document) => new(document, null, null);

    public static AppMcpResult Unavailable(string code, string message) => new(null, code, message);
}
