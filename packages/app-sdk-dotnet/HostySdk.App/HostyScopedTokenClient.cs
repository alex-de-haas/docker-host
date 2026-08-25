using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace HostySdk.App;

/// <summary>
/// Validates a scoped access token an external client presented directly to this app, by asking
/// Core: <c>POST /api/internal/apps/{appId}/token/introspect</c> with the app service token as
/// bearer.
/// </summary>
/// <remarks>
/// <para>
/// The contrast with a delegated identity token is the point of this credential. A delegated token
/// is signed and verified locally — fast, but unrevocable, so it lives five minutes and cannot sit
/// in a client's configuration file. A scoped token is opaque and means nothing until Core says
/// otherwise, which is what lets it live in a config and still stop working the instant an operator
/// revokes it.
/// </para>
/// <para>
/// Deliberately uncached, unlike <see cref="HostySecretsClient"/>: a secret that a briefly
/// unavailable Core cannot confirm is still the same secret, while a credential that a cache keeps
/// answering for is a credential revocation has not actually reached. The hop is loopback and the
/// traffic is agent tool calls, so the cost of asking every time is not worth the window a cache
/// would reopen.
/// </para>
/// </remarks>
public sealed class HostyScopedTokenClient(IHttpClientFactory httpClientFactory, HostyAppOptions options)
{
    /// <summary>Named <c>IHttpClientFactory</c> client, shared with identity revalidation.</summary>
    public const string HttpClientName = CoreIdentityValidator.HttpClientName;

    /// <summary>The scope every read-only MCP tool is gated on today.</summary>
    public const string McpReadScope = "mcp:read";

    /// <summary>
    /// Asks Core whether <paramref name="token"/> is a live credential scoped to this app.
    /// </summary>
    /// <param name="token">The bearer this app received from the external client.</param>
    /// <param name="tool">
    /// The tool or method this call is about. Core records it as the audit line for the action, so
    /// an external client's use of this app becomes visible to the host. Pass it for a tool call and
    /// leave it null for protocol traffic that is not itself an action.
    /// </param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>
    /// The introspection result. <see cref="HostyScopedTokenResult.Active"/> is sufficient on its
    /// own — a caller that reads nothing else is not thereby insecure.
    /// </returns>
    /// <exception cref="HostyScopedTokenException">
    /// Core was unreachable, timed out, or answered unusably. This is deliberately not an inactive
    /// result: the caller owes its client a 503 here, not a 401, because nothing was established.
    /// </exception>
    public async Task<HostyScopedTokenResult> IntrospectAsync(
        string token,
        string? tool = null,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(options.ServiceToken))
        {
            throw new HostyScopedTokenException(
                "HOSTY_APP_SERVICE_TOKEN is not set; token introspection is only reachable under Hosty Core.",
                HostyScopedTokenErrorCodes.ServiceTokenMissing);
        }

        if (string.IsNullOrWhiteSpace(token))
        {
            return HostyScopedTokenResult.Inactive;
        }

        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            $"/api/internal/apps/{Uri.EscapeDataString(options.AppId)}/token/introspect")
        {
            Content = JsonContent.Create(new IntrospectionRequest(token, tool)),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", options.ServiceToken);

        HttpResponseMessage response;
        try
        {
            response = await httpClientFactory.CreateClient(HttpClientName).SendAsync(request, cancellationToken);
        }
        catch (HttpRequestException ex)
        {
            throw new HostyScopedTokenException(
                "The token introspection request to Core failed.", HostyScopedTokenErrorCodes.Unavailable, ex);
        }
        catch (OperationCanceledException ex) when (!cancellationToken.IsCancellationRequested)
        {
            // HttpClient timeouts surface as TaskCanceledException; only genuine caller cancellation
            // may propagate.
            throw new HostyScopedTokenException(
                "The token introspection request to Core timed out.", HostyScopedTokenErrorCodes.Timeout, ex);
        }

        using (response)
        {
            if (!response.IsSuccessStatusCode)
            {
                throw new HostyScopedTokenException(
                    $"Core answered {(int)response.StatusCode} for the token introspection request.",
                    HostyScopedTokenErrorCodes.Refused);
            }

            IntrospectionResponse? payload;
            try
            {
                payload = await response.Content.ReadFromJsonAsync<IntrospectionResponse>(cancellationToken);
            }
            catch (Exception ex) when (ex is System.Text.Json.JsonException or HttpRequestException)
            {
                throw new HostyScopedTokenException(
                    "Core returned an unreadable introspection body.",
                    HostyScopedTokenErrorCodes.ResponseInvalid,
                    ex);
            }

            // Fail closed on the shape: an answer without a subject is one that could not be read,
            // and an unreadable answer is not a grant.
            return payload is { Active: true, Sub: { Length: > 0 } sub }
                ? new HostyScopedTokenResult(true, sub, payload.Role, payload.Scopes ?? [])
                : HostyScopedTokenResult.Inactive;
        }
    }

    private sealed record IntrospectionRequest(
        [property: JsonPropertyName("token")] string Token,
        [property: JsonPropertyName("tool")] string? Tool);

    private sealed record IntrospectionResponse(
        [property: JsonPropertyName("active")] bool Active,
        [property: JsonPropertyName("sub")] string? Sub,
        [property: JsonPropertyName("role")] string? Role,
        [property: JsonPropertyName("scopes")] IReadOnlyList<string>? Scopes);
}

/// <summary>What Core said about a credential.</summary>
/// <param name="Active">Whether the credential is live and scoped to this app.</param>
/// <param name="Sub">The acting Host user id; null when inactive.</param>
/// <param name="Role">The actor's Host role at this moment; null when inactive.</param>
/// <param name="Scopes">What the credential may do here; empty when inactive.</param>
public sealed record HostyScopedTokenResult(
    bool Active,
    string? Sub,
    string? Role,
    IReadOnlyList<string> Scopes)
{
    /// <summary>The single shape every refusal takes, so an app cannot leak which reason applied.</summary>
    public static HostyScopedTokenResult Inactive { get; } = new(false, null, null, []);

    /// <summary>Whether the credential carries a scope. Ordinal, because a scope is a protocol
    /// constant rather than text to be normalized.</summary>
    public bool HasScope(string scope) => Active && Scopes.Contains(scope, StringComparer.Ordinal);
}

/// <summary>Codes on <see cref="HostyScopedTokenException"/>.</summary>
public static class HostyScopedTokenErrorCodes
{
    /// <summary>The app is not running under Core, so there is no service token to ask with.</summary>
    public const string ServiceTokenMissing = "app_service_token_missing";

    /// <summary>Core could not be reached.</summary>
    public const string Unavailable = "introspection_unavailable";

    /// <summary>Core did not answer within the client's budget.</summary>
    public const string Timeout = "introspection_timeout";

    /// <summary>Core answered a non-success status — usually this app's own service token being stale.</summary>
    public const string Refused = "introspection_failed";

    /// <summary>Core answered with a body this client could not read.</summary>
    public const string ResponseInvalid = "core_response_invalid";
}

/// <summary>Core could not be asked, or could not be understood. Never means "not a valid
/// credential" — that is an ordinary inactive result.</summary>
public sealed class HostyScopedTokenException(string message, string code, Exception? innerException = null)
    : Exception(message, innerException)
{
    /// <summary>Machine-readable cause, from <see cref="HostyScopedTokenErrorCodes"/>.</summary>
    public string Code { get; } = code;
}
