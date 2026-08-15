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

        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(timeout);

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, target.Url)
            {
                Content = new StringContent(BuildRequest(method, writeParams), Encoding.UTF8, "application/json"),
            };
            request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {token}");
            request.Headers.TryAddWithoutValidation("Accept", "application/json");

            using var response = await http.SendAsync(request, timeoutSource.Token);
            var body = await response.Content.ReadAsStringAsync(timeoutSource.Token);
            if (!response.IsSuccessStatusCode)
            {
                return AppMcpResult.Unavailable(
                    "app_error",
                    $"{target.AppId} answered its MCP endpoint with HTTP {(int)response.StatusCode}.");
            }

            return AppMcpResult.Ok(JsonDocument.Parse(body));
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            // A stopped app is the common cause and is not an error the session should carry: one app
            // being unreachable must never take down the fan-out or the connector.
            return AppMcpResult.Unavailable(
                "app_stopped",
                $"{target.AppId} did not answer within {timeout.TotalSeconds:0} seconds; it may be stopped.");
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException)
        {
            return AppMcpResult.Unavailable(
                "app_stopped",
                $"{target.AppId} is not reachable at its MCP endpoint; it may be stopped.");
        }
    }

    private static string BuildRequest(string method, Action<Utf8JsonWriter>? writeParams)
    {
        var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            // A fixed id is safe because every exchange here is one request on its own connection —
            // there is no pipelining to correlate.
            writer.WriteNumber("id", 1);
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
