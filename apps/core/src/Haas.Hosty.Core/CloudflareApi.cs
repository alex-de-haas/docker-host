using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Haas.Hosty.Core;

// One-click Cloudflare public ingress, phase 1: a read-only Cloudflare API client used to verify a pasted
// scoped API token and discover the account, zone, tunnel, and connectors to adopt. The token is passed
// per call as a Bearer header and never logged; this client holds no credential at rest (see
// CloudflareCredentialStore). Mutation (DNS + tunnel configuration writes) is deliberately out of scope
// here and lands in phase 2. See docs/planning/one-click-cloudflare-public-ingress.md.
internal sealed class CloudflareApiClient(IHttpClientFactory httpClientFactory)
{
    public const string HttpClientName = "cloudflare";
    private const string BaseUrl = "https://api.cloudflare.com/client/v4";

    // The primary validity check: a resource probe. An account-owned token (what the template flow yields)
    // returns "Invalid API Token" from /user/tokens/verify, so listing accounts is the reliable proof.
    public async Task<IReadOnlyList<CloudflareAccount>> ListAccountsAsync(string token, CancellationToken cancellationToken = default)
        => (await SendAsync(token, "/accounts?per_page=50", CoreJsonSerializerContext.Default.CloudflareAccountsResponse, cancellationToken)).Result ?? [];

    public async Task<IReadOnlyList<CloudflareZone>> ListZonesAsync(string token, CancellationToken cancellationToken = default)
        => (await SendAsync(token, "/zones?per_page=50", CoreJsonSerializerContext.Default.CloudflareZonesResponse, cancellationToken)).Result ?? [];

    public async Task<IReadOnlyList<CloudflareTunnel>> ListTunnelsAsync(string token, string accountId, CancellationToken cancellationToken = default)
        => (await SendAsync(token, $"/accounts/{Escape(accountId)}/cfd_tunnel?is_deleted=false&per_page=50", CoreJsonSerializerContext.Default.CloudflareTunnelsResponse, cancellationToken)).Result ?? [];

    // Flattens the connections response to the individual connector connections, which carry the origin_ip
    // used by the connector-locality check.
    public async Task<IReadOnlyList<CloudflareConnectorConn>> GetTunnelConnectionsAsync(string token, string accountId, string tunnelId, CancellationToken cancellationToken = default)
        => (await SendAsync(token, $"/accounts/{Escape(accountId)}/cfd_tunnel/{Escape(tunnelId)}/connections", CoreJsonSerializerContext.Default.CloudflareConnectionsResponse, cancellationToken))
            .Result?.SelectMany(client => client.Conns ?? []).ToArray() ?? [];

    // Account-owned token verify (/accounts/{id}/tokens/verify) for status + expiry, once the account id is
    // known from the resource probe above.
    public async Task<CloudflareTokenStatus?> VerifyAccountTokenAsync(string token, string accountId, CancellationToken cancellationToken = default)
        => (await SendAsync(token, $"/accounts/{Escape(accountId)}/tokens/verify", CoreJsonSerializerContext.Default.CloudflareTokenVerifyResponse, cancellationToken)).Result;

    private async Task<TResponse> SendAsync<TResponse>(
        string token,
        string path,
        System.Text.Json.Serialization.Metadata.JsonTypeInfo<TResponse> typeInfo,
        CancellationToken cancellationToken)
        where TResponse : ICloudflareResponse
    {
        var client = httpClientFactory.CreateClient(HttpClientName);
        using var request = new HttpRequestMessage(HttpMethod.Get, $"{BaseUrl}{path}");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var response = await client.SendAsync(request, cancellationToken);
        // Content is effectively always present for HttpClient responses, but the type is nullable and a
        // custom handler could omit it — treat that as an empty body rather than risking an NRE.
        var body = response.Content is null ? string.Empty : await response.Content.ReadAsStringAsync(cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            // 401 (revoked/invalid) and 403 (missing permission) are the classifiable auth failures the
            // connection flow turns into "Reconnect required"; carry the status and any Cloudflare error text.
            throw new CloudflareApiException((int)response.StatusCode, ReadErrors(body));
        }

        var parsed = SafeDeserialize(body, typeInfo)
            ?? throw new CloudflareApiException((int)response.StatusCode, ["Cloudflare returned an empty or unreadable response body."]);
        if (!parsed.Success)
        {
            // Cloudflare can return HTTP 200 with success=false; treat it as an error carrying the messages.
            throw new CloudflareApiException((int)response.StatusCode, MessagesOf(parsed.Errors));
        }

        return parsed;
    }

    private static TResponse? SafeDeserialize<TResponse>(string body, System.Text.Json.Serialization.Metadata.JsonTypeInfo<TResponse> typeInfo)
    {
        try
        {
            return JsonSerializer.Deserialize(body, typeInfo);
        }
        catch (JsonException)
        {
            return default;
        }
    }

    private static IReadOnlyList<string> ReadErrors(string body)
    {
        var parsed = SafeDeserialize(body, CoreJsonSerializerContext.Default.CloudflareErrorResponse);
        return parsed is null ? [] : MessagesOf(parsed.Errors);
    }

    private static IReadOnlyList<string> MessagesOf(IReadOnlyList<CloudflareError>? errors)
        => errors is null
            ? []
            : errors.Select(error => error.Message).OfType<string>().Where(message => message.Length > 0).ToArray();

    private static string Escape(string value) => Uri.EscapeDataString(value);
}

// Non-2xx (or success=false) Cloudflare responses. StatusCode lets the connection flow classify 401/403 as
// "Reconnect required"; CloudflareErrors carries the human-readable messages (never the token).
internal sealed class CloudflareApiException(int statusCode, IReadOnlyList<string> errors)
    : Exception($"Cloudflare API request failed with status {statusCode}{(errors.Count > 0 ? ": " + string.Join("; ", errors) : ".")}")
{
    public int StatusCode { get; } = statusCode;

    public IReadOnlyList<string> CloudflareErrors { get; } = errors;
}

// The shared Cloudflare response envelope (success + errors). Each concrete response implements it so the
// client can check success and surface errors generically.
internal interface ICloudflareResponse
{
    bool Success { get; }

    IReadOnlyList<CloudflareError>? Errors { get; }
}

internal sealed record CloudflareError(int Code, string? Message);

internal sealed record CloudflareErrorResponse(bool Success, IReadOnlyList<CloudflareError>? Errors) : ICloudflareResponse;

internal sealed record CloudflareAccount(string Id, string Name);

internal sealed record CloudflareAccountsResponse(bool Success, IReadOnlyList<CloudflareError>? Errors, IReadOnlyList<CloudflareAccount>? Result) : ICloudflareResponse;

internal sealed record CloudflareZone(string Id, string Name, string? Status);

internal sealed record CloudflareZonesResponse(bool Success, IReadOnlyList<CloudflareError>? Errors, IReadOnlyList<CloudflareZone>? Result) : ICloudflareResponse;

internal sealed record CloudflareTunnel(
    string Id,
    string Name,
    string? Status,
    [property: JsonPropertyName("config_src")] string? ConfigSrc,
    [property: JsonPropertyName("remote_config")] bool RemoteConfig)
{
    // A remotely managed tunnel is the only kind this feature adopts (config_src "cloudflare"); "healthy"
    // is the only status with live edge connections.
    public bool IsRemotelyManaged => string.Equals(ConfigSrc, "cloudflare", StringComparison.Ordinal);

    public bool IsHealthy => string.Equals(Status, "healthy", StringComparison.Ordinal);
}

internal sealed record CloudflareTunnelsResponse(bool Success, IReadOnlyList<CloudflareError>? Errors, IReadOnlyList<CloudflareTunnel>? Result) : ICloudflareResponse;

internal sealed record CloudflareConnectorConn(
    [property: JsonPropertyName("origin_ip")] string? OriginIp,
    [property: JsonPropertyName("colo_name")] string? ColoName,
    [property: JsonPropertyName("client_version")] string? ClientVersion,
    [property: JsonPropertyName("is_pending_reconnect")] bool IsPendingReconnect);

internal sealed record CloudflareConnectionClient([property: JsonPropertyName("conns")] IReadOnlyList<CloudflareConnectorConn>? Conns);

internal sealed record CloudflareConnectionsResponse(bool Success, IReadOnlyList<CloudflareError>? Errors, IReadOnlyList<CloudflareConnectionClient>? Result) : ICloudflareResponse;

internal sealed record CloudflareTokenStatus(
    string? Id,
    string? Status,
    [property: JsonPropertyName("expires_on")] DateTimeOffset? ExpiresOn,
    [property: JsonPropertyName("not_before")] DateTimeOffset? NotBefore);

internal sealed record CloudflareTokenVerifyResponse(bool Success, IReadOnlyList<CloudflareError>? Errors, CloudflareTokenStatus? Result) : ICloudflareResponse;
