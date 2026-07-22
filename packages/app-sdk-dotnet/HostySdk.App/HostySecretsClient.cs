using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Microsoft.Extensions.Logging;

namespace HostySdk.App;

/// <summary>
/// Reads and writes the app's Core-managed secrets:
/// <c>/api/internal/apps/{appId}/secrets…</c> with the app service token as bearer. The store
/// holds runtime-acquired credentials (OAuth tokens and the like) that an app must present to a
/// third party, so they cannot be hashed; Core keeps them outside the app's backed-up data
/// directory, which is why they must not be duplicated into app storage.
/// </summary>
/// <remarks>
/// Reads are served from a write-through in-memory cache, so a briefly unavailable Core does not
/// break an app that already read its secret. The cache is authoritative only for values this
/// process wrote or fetched: <see cref="GetAsync"/> caches both hits and misses, and every
/// mutation updates it, so no invalidation round-trip is needed. A read that overlaps a
/// concurrent write discards its own result rather than overwriting the newer one.
/// </remarks>
public sealed class HostySecretsClient(
    IHttpClientFactory httpClientFactory,
    HostyAppOptions options,
    ILogger<HostySecretsClient> logger)
{
    /// <summary>Named <c>IHttpClientFactory</c> client, shared with identity revalidation.</summary>
    public const string HttpClientName = CoreIdentityValidator.HttpClientName;

    // A missing entry and a cached "no value" are different states, so the cache stores the
    // nullable value rather than relying on presence.
    private readonly Dictionary<string, string?> cache = new(StringComparer.Ordinal);

    // Per-key mutation counter. A read samples it before calling Core and only writes its result
    // back if it is unchanged: the lock guards individual cache accesses, not a whole operation,
    // so without this a GET issued before a concurrent Set/Delete but completing after it would
    // overwrite the newer state and later cached reads would serve the stale value.
    private readonly Dictionary<string, long> mutations = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim cacheLock = new(1, 1);

    /// <summary>
    /// Returns the stored secret, or <see langword="null"/> when the app has none under this key.
    /// A missing secret is an expected state — an app that has never connected, or whose secrets
    /// were dropped when it was reinstalled on a new host — so callers should treat it as
    /// "reconnect required", not as an error.
    /// </summary>
    /// <param name="key">Secret key (<c>^[a-z0-9][a-z0-9._-]{0,127}$</c>).</param>
    /// <param name="refresh">Bypass the cache and re-read from Core.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <exception cref="HostySecretsException">Core was unreachable or rejected the request.</exception>
    public async Task<string?> GetAsync(string key, bool refresh = false, CancellationToken cancellationToken = default)
    {
        long generation;
        await cacheLock.WaitAsync(cancellationToken);
        try
        {
            if (!refresh && cache.TryGetValue(key, out var cached))
            {
                return cached;
            }

            generation = mutations.TryGetValue(key, out var current) ? current : 0;
        }
        finally
        {
            cacheLock.Release();
        }

        using var response = await SendAsync(HttpMethod.Get, key, content: null, cancellationToken);
        string? value = null;
        if (response.StatusCode != HttpStatusCode.NotFound)
        {
            value = (await ReadJsonAsync<SecretValueResponse>(response, cancellationToken))?.Value;
            if (value is null)
            {
                // A 200 without a usable value is a broken Core/proxy, not an absent secret;
                // reporting it as "no value" would send the app into a reconnect loop instead of
                // surfacing the fault.
                throw new HostySecretsException(
                    "Core returned a secret response without a value.",
                    HostySecretsErrorCodes.ResponseInvalid,
                    (int)response.StatusCode);
            }
        }

        await StoreReadAsync(key, value, generation, cancellationToken);
        return value;
    }

    /// <summary>Stores (or replaces) the secret under <paramref name="key"/>.</summary>
    /// <exception cref="HostySecretsException">
    /// Core rejected the value (malformed key, empty/oversize value, or the per-app key limit) or
    /// was unreachable.
    /// </exception>
    public async Task SetAsync(string key, string value, CancellationToken cancellationToken = default)
    {
        using var content = JsonContent.Create(new SecretWriteRequest(value));
        using var _ = await SendAsync(HttpMethod.Put, key, content, cancellationToken);
        await StoreMutationAsync(key, value, cancellationToken);
    }

    /// <summary>Deletes the secret under <paramref name="key"/>. Deleting an absent key succeeds.</summary>
    /// <exception cref="HostySecretsException">Core was unreachable or rejected the request.</exception>
    public async Task DeleteAsync(string key, CancellationToken cancellationToken = default)
    {
        using var _ = await SendAsync(HttpMethod.Delete, key, content: null, cancellationToken);
        await StoreMutationAsync(key, null, cancellationToken);
    }

    /// <summary>
    /// Lists the keys this app has stored. Always a live read — Core never returns values here,
    /// and the cache only knows about keys this process has touched.
    /// </summary>
    /// <exception cref="HostySecretsException">Core was unreachable or rejected the request.</exception>
    public async Task<IReadOnlyList<string>> ListKeysAsync(CancellationToken cancellationToken = default)
    {
        using var response = await SendAsync(HttpMethod.Get, key: null, content: null, cancellationToken);
        // An app with no secrets returns an empty array, so an absent one is a broken response,
        // not an empty store — surface it rather than reporting "no secrets".
        return (await ReadJsonAsync<SecretKeysResponse>(response, cancellationToken))?.Keys
            ?? throw new HostySecretsException(
                "Core returned a secret listing without a keys array.",
                HostySecretsErrorCodes.ResponseInvalid,
                (int)response.StatusCode);
    }

    // Write-through for a mutation: bumps the key's generation so a read still in flight discards
    // its now-stale result instead of overwriting this value.
    private async Task StoreMutationAsync(string key, string? value, CancellationToken cancellationToken)
    {
        await cacheLock.WaitAsync(cancellationToken);
        try
        {
            mutations[key] = (mutations.TryGetValue(key, out var current) ? current : 0) + 1;
            cache[key] = value;
        }
        finally
        {
            cacheLock.Release();
        }
    }

    // Write-back for a completed read: only lands when no mutation happened while it was running.
    private async Task StoreReadAsync(string key, string? value, long generation, CancellationToken cancellationToken)
    {
        await cacheLock.WaitAsync(cancellationToken);
        try
        {
            if ((mutations.TryGetValue(key, out var current) ? current : 0) == generation)
            {
                cache[key] = value;
            }
        }
        finally
        {
            cacheLock.Release();
        }
    }

    // A null key targets the collection route (list); otherwise the per-key route. A per-key GET
    // 404 is returned to the caller only when it is the "no secret stored" one — Core answers the
    // same status with app_not_found when the routed app is unknown or has been removed, and
    // collapsing the two would report a removed app as a routine reconnect.
    private async Task<HttpResponseMessage> SendAsync(
        HttpMethod method,
        string? key,
        HttpContent? content,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(options.ServiceToken))
        {
            throw new HostySecretsException(
                "HOSTY_APP_SERVICE_TOKEN is not set; the app secrets store is only reachable under Hosty Core.",
                HostySecretsErrorCodes.ServiceTokenMissing);
        }

        var path = $"/api/internal/apps/{Uri.EscapeDataString(options.AppId)}/secrets";
        if (key is not null)
        {
            path += $"/{Uri.EscapeDataString(key)}";
        }

        using var request = new HttpRequestMessage(method, path) { Content = content };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", options.ServiceToken);

        HttpResponseMessage response;
        try
        {
            response = await httpClientFactory.CreateClient(HttpClientName).SendAsync(request, cancellationToken);
        }
        catch (HttpRequestException ex)
        {
            throw new HostySecretsException(
                "The app secrets request to Core failed.", HostySecretsErrorCodes.Unavailable, ex);
        }
        catch (OperationCanceledException ex) when (!cancellationToken.IsCancellationRequested)
        {
            // HttpClient timeouts surface as TaskCanceledException; only genuine caller
            // cancellation may propagate.
            throw new HostySecretsException(
                "The app secrets request to Core timed out.", HostySecretsErrorCodes.Timeout, ex);
        }

        if (response.IsSuccessStatusCode)
        {
            return response;
        }

        using (response)
        {
            // The body is safe to read and surface: Core's error bodies carry codes and limits,
            // never secret values.
            var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            var code = ReadErrorCode(body);

            // The one 404 that is an answer rather than a failure: this app has no secret stored
            // under this key. Any other 404 (app_not_found) means the app itself is gone.
            if (method == HttpMethod.Get &&
                key is not null &&
                response.StatusCode == HttpStatusCode.NotFound &&
                code is not "app_not_found")
            {
                return new HttpResponseMessage(HttpStatusCode.NotFound);
            }

            logger.LogWarning(
                "Core rejected an app secrets {Method} for key {Key} with HTTP {Status} ({Code}).",
                method.Method,
                key ?? "(list)",
                (int)response.StatusCode,
                code ?? "no code");
            throw new HostySecretsException(
                $"Core returned HTTP {(int)response.StatusCode} for an app secrets {method.Method} request. {body}".TrimEnd(),
                code ?? HostySecretsErrorCodes.RequestFailed,
                (int)response.StatusCode);
        }
    }

    // Best-effort: an unparseable error body only costs the passed-through code, so the caller
    // falls back to the client's own classification.
    private static string? ReadErrorCode(string body)
    {
        try
        {
            using var document = System.Text.Json.JsonDocument.Parse(body);
            return document.RootElement.ValueKind == System.Text.Json.JsonValueKind.Object &&
                document.RootElement.TryGetProperty("code", out var code) &&
                code.ValueKind == System.Text.Json.JsonValueKind.String
                ? code.GetString()
                : null;
        }
        catch (System.Text.Json.JsonException)
        {
            return null;
        }
    }

    private static async Task<T?> ReadJsonAsync<T>(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        try
        {
            return await response.Content.ReadFromJsonAsync<T>(cancellationToken);
        }
        catch (Exception ex) when (ex is System.Text.Json.JsonException or NotSupportedException or InvalidOperationException)
        {
            throw new HostySecretsException(
                "Core returned an unreadable app secrets response.",
                HostySecretsErrorCodes.ResponseInvalid,
                ex,
                (int)response.StatusCode);
        }
    }

    private sealed record SecretValueResponse(string? Value);

    private sealed record SecretKeysResponse(IReadOnlyList<string>? Keys);

    private sealed record SecretWriteRequest(string Value);
}

/// <summary>
/// Raised when the app secrets store could not be reached or rejected a request. A *missing*
/// secret is not an error — <see cref="HostySecretsClient.GetAsync"/> returns null for that.
/// </summary>
public sealed class HostySecretsException : Exception
{
    /// <summary>Creates the exception with a message and machine-readable classification.</summary>
    public HostySecretsException(string message, string code, int? status = null)
        : base(message)
    {
        Code = code;
        Status = status;
    }

    /// <summary>Creates the exception with a message, classification, and the underlying failure.</summary>
    public HostySecretsException(string message, string code, Exception innerException, int? status = null)
        : base(message, innerException)
    {
        Code = code;
        Status = status;
    }

    /// <summary>
    /// Machine-readable cause, so callers can branch without matching on the message. Either a
    /// code passed through from Core's error body (e.g. <c>app_not_found</c>,
    /// <c>app_secret_value_invalid</c>) or one raised locally by this client — see
    /// <see cref="HostySecretsErrorCodes"/>. Mirrors the TypeScript client's codes.
    /// </summary>
    public string Code { get; }

    /// <summary>Core's HTTP status, or <see langword="null"/> when Core was never reached.</summary>
    public int? Status { get; }
}

/// <summary>Codes <see cref="HostySecretsClient"/> raises itself, as opposed to passing through
/// from Core's error body. Shared verbatim with the TypeScript client.</summary>
public static class HostySecretsErrorCodes
{
    /// <summary>No service token in the environment; the store is only reachable under Core.</summary>
    public const string ServiceTokenMissing = "app_service_token_missing";

    /// <summary>Core could not be reached.</summary>
    public const string Unavailable = "core_secrets_unavailable";

    /// <summary>The request to Core timed out.</summary>
    public const string Timeout = "core_secrets_timeout";

    /// <summary>Core answered 2xx with a body this client cannot use.</summary>
    public const string ResponseInvalid = "core_response_invalid";

    /// <summary>Core rejected the request and supplied no usable code of its own.</summary>
    public const string RequestFailed = "app_secrets_request_failed";
}
