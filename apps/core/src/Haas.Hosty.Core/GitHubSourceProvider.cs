using System.Net.Http.Headers;
using System.Text.Json;

namespace Haas.Hosty.Core;

// Only fixed provider authorities receive credentials. Redirects are disabled by the registered client.
internal sealed partial class GitHubSourceProvider(HttpClient client, IConfiguration config, IClock clock, IPublicationProvider? publication = null) : ISourceProvider
{
    // Public registration identifier for Hosty's device flow; no client secret is distributed.
    internal const string DefaultGitHubClientId = "Ov23liDBHP5MgRKVV30I";
    public SourceProviderDescriptor Descriptor => new("github", "GitHub", ["device", "pat"], ["repositories", "private-sources", "pull-requests"]);
    public IPublicationProvider Publication { get; } = publication ?? new GitHubPublicationProvider(client, clock);
    public string? ClientId => string.IsNullOrWhiteSpace(config["ProviderConnections:GitHubClientId"])
        ? DefaultGitHubClientId : config["ProviderConnections:GitHubClientId"]!.Trim();
    private const string TokenUrl = "https://github.com/login/oauth/access_token";
    public UserConnectionInput Validate(UserConnectionInput input) => input with { Organization = "", Tenant = "" };

    public async Task<ProviderDevice> StartAsync(UserConnectionInput input, string clientId, CancellationToken ct)
    {
        const string url = "https://github.com/login/device/code";
        using var json = await SendAsync(HttpMethod.Post, url, new Dictionary<string, string>
        {
            ["client_id"] = clientId,
            ["scope"] = (input.PrivateRepositories ? "repo" : "public_repo") + " user:email offline_access",
        }, ct: ct);
        CheckError(json.RootElement);
        var root = json.RootElement;
        return new(Required(root, "device_code"), Required(root, "user_code"),
            "https://github.com/login/device",
            Math.Clamp(Number(root, "expires_in", 900), 1, 1800), Math.Max(5, Number(root, "interval", 5)));
    }
    public async Task<(ProviderToken? Token, string? Pending)> PollAsync(string clientId, string deviceCode, CancellationToken ct)
    {
        using var json = await SendAsync(HttpMethod.Post, TokenUrl, new Dictionary<string, string>
        {
            ["client_id"] = clientId, ["device_code"] = deviceCode,
            ["grant_type"] = "urn:ietf:params:oauth:grant-type:device_code",
        }, ct: ct);
        var error = String(json.RootElement, "error");
        if (error is "authorization_pending" or "slow_down") return (null, error);
        CheckError(json.RootElement);
        return (ReadToken(json.RootElement), null);
    }
    public async Task<ProviderToken> RefreshAsync(UserProviderConnection connection, CancellationToken ct)
    {
        if (connection.RefreshToken is null || connection.ClientId is null)
            throw new UserConnectionException("connection_reconnect_required", "Reconnect this account to renew access.", 409);
        using var json = await SendAsync(HttpMethod.Post, TokenUrl, new Dictionary<string, string>
        {
            ["client_id"] = connection.ClientId, ["refresh_token"] = connection.RefreshToken, ["grant_type"] = "refresh_token",
        }, ct: ct);
        CheckError(json.RootElement);
        var token = ReadToken(json.RootElement);
        return token with { RefreshToken = token.RefreshToken ?? connection.RefreshToken };
    }
    public async Task<ProviderIdentity> IdentityAsync(string method, string token, CancellationToken ct)
    {
        using var json = await SendAsync(HttpMethod.Get, "https://api.github.com/user",
            authorization: new AuthenticationHeaderValue("Bearer", token), ct: ct);
        return new(Required(json.RootElement, "id"), Required(json.RootElement, "login"));
    }
    private ProviderToken ReadToken(JsonElement root)
        => new(Required(root, "access_token"), String(root, "refresh_token"),
            root.TryGetProperty("expires_in", out _) ? clock.UtcNow.AddSeconds(Math.Clamp(Number(root, "expires_in", 0), 1, 31536000)) : null);
    private async Task<JsonDocument> SendAsync(HttpMethod method, string url, Dictionary<string, string>? form = null,
        AuthenticationHeaderValue? authorization = null, CancellationToken ct = default)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        using var request = new HttpRequestMessage(method, url);
        request.Headers.Accept.ParseAdd("application/json");
        request.Headers.UserAgent.ParseAdd("Hosty/1.0");
        request.Headers.Authorization = authorization;
        if (form is not null) request.Content = new FormUrlEncodedContent(form);
        try
        {
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if ((int)response.StatusCode is 401 or 403)
                throw new UserConnectionException("provider_access_denied", "Provider access was denied. Check the account and organization permissions.", 409);
            if ((int)response.StatusCode is >= 300 and < 400 || (int)response.StatusCode >= 500 || response.StatusCode == System.Net.HttpStatusCode.TooManyRequests)
                throw new UserConnectionException("provider_unavailable", "The provider is unavailable or limiting requests. Try again later.", 502);
            await response.Content.LoadIntoBufferAsync(1024 * 1024, timeout.Token);
            var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(timeout.Token));
            if (json.RootElement.ValueKind != JsonValueKind.Object ||
                !response.IsSuccessStatusCode && !json.RootElement.TryGetProperty("error", out _))
            {
                json.Dispose();
                throw new UserConnectionException("provider_request_failed", "The provider could not process this request.", 502);
            }
            return json;
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException || ex is OperationCanceledException && !ct.IsCancellationRequested)
        {
            throw new UserConnectionException("provider_unavailable", "The provider response could not be read. Try again later.", 502);
        }
    }
    private static void CheckError(JsonElement root)
    {
        if (String(root, "error") is not { } error) return;
        throw new UserConnectionException(error is "access_denied" or "authorization_declined" ? "connection_declined" : "connection_reconnect_required",
            error is "access_denied" or "authorization_declined" ? "Authorization was declined." : "Authorization expired or could not be completed. Reconnect the account.", 409);
    }
    private static string Required(JsonElement root, string name)
    {
        var value = String(root, name);
        if (string.IsNullOrWhiteSpace(value) || value.Length > 16384)
            throw new UserConnectionException("provider_response_invalid", "The provider returned an incomplete response.", 502);
        return value;
    }
    private static string? String(JsonElement root, string name)
        => root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out var value)
            ? value.ValueKind == JsonValueKind.String ? value.GetString() : value.ValueKind == JsonValueKind.Number ? value.GetRawText() : null : null;
    private static int Number(JsonElement root, string name, int fallback)
        => root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number) ? number : fallback;
}
