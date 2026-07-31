using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Haas.Hosty.Core;

// Resolves a `repository:tag` to its manifest digest by talking to the registry's HTTP API directly,
// instead of shelling out to `docker buildx imagetools inspect`. Measured on macOS (docker 29.6.2,
// buildx v0.35.0), the same lookup costs ~3.5s through buildx and ~0.5s here — and process spawn is
// only ~50ms of that, so the gap is buildx's own round-trip, not the subprocess. A fleet update check
// resolves one digest per compiled service, so this is the dominant term in "Check updates".
//
// Deliberately narrow: it answers the one question the reviewed-update plan asks, does not
// authenticate beyond an anonymous bearer challenge, and returns null for anything it cannot answer
// cleanly, leaving DockerRuntimeAdapter to fall back to the docker CLI (which can reach a private
// registry the operator has `docker login`-ed to, using credentials Core never reads).
internal interface IRegistryDigestResolver
{
    Task<string?> TryResolveDigestAsync(RuntimeDockerImage image, CancellationToken cancellationToken = default);
}

internal sealed class RegistryDigestResolver(
    IHttpClientFactory httpClientFactory,
    ILogger<RegistryDigestResolver> logger) : IRegistryDigestResolver
{
    public const string HttpClientName = "registry-digest";

    // The media types a manifest probe must declare it understands. Without these a registry answers
    // with the legacy v1 manifest (or a 404), and the digest would not match what docker pulls: the
    // index digest for a multi-arch image is what the artifact lock records.
    private const string ManifestAcceptHeader =
        "application/vnd.oci.image.index.v1+json, " +
        "application/vnd.docker.distribution.manifest.list.v2+json, " +
        "application/vnd.oci.image.manifest.v1+json, " +
        "application/vnd.docker.distribution.manifest.v2+json";

    // Anonymous bearer tokens keyed by the challenge they answered. Registries issue these per
    // repository scope, so a fleet check re-requests one per app — cheap, but not free, and Docker Hub
    // rate-limits the token endpoint separately from the manifest endpoint.
    private readonly ConcurrentDictionary<string, CachedRegistryToken> tokens = new(StringComparer.Ordinal);

    public async Task<string?> TryResolveDigestAsync(RuntimeDockerImage image, CancellationToken cancellationToken = default)
    {
        if (!TryParseReference(image.Repository, out var registry, out var repository))
        {
            return null;
        }

        try
        {
            var client = httpClientFactory.CreateClient(HttpClientName);
            var manifestUrl = $"https://{registry}/v2/{repository}/manifests/{Uri.EscapeDataString(image.Tag)}";
            var scope = $"repository:{repository}:pull";

            var response = await SendManifestProbeAsync(client, manifestUrl, registry, scope, useCachedToken: true, cancellationToken);

            // A cached token that has just expired (or been revoked) looks exactly like never having
            // had one. Drop it and re-challenge once rather than reporting the image unresolvable.
            if (response.StatusCode == HttpStatusCode.Unauthorized)
            {
                response.Dispose();
                response = await SendManifestProbeAsync(client, manifestUrl, registry, scope, useCachedToken: false, cancellationToken);
            }

            using (response)
            {
                if (!response.IsSuccessStatusCode)
                {
                    // Includes 401 after a failed challenge (a private registry needing real
                    // credentials) and 3xx, which AllowAutoRedirect=false surfaces here rather than
                    // following a manifest probe to an unvetted host. Both are the CLI's problem now.
                    logger.LogDebug(
                        "Registry digest probe for '{Image}' returned {Status}; falling back to the docker CLI.",
                        image.TagReference,
                        (int)response.StatusCode);
                    return null;
                }

                // The registry is supposed to state the digest in a header, which is why a HEAD
                // suffices and no body is transferred.
                if (response.Headers.TryGetValues("Docker-Content-Digest", out var values) &&
                    ParseDigest(values.FirstOrDefault()) is { } headerDigest)
                {
                    return headerDigest;
                }

                // Not every registry sends it. The digest is by definition the SHA-256 of the manifest
                // bytes exactly as served, so fetching and hashing them yields the same value — one
                // extra round-trip, still far cheaper than the CLI.
                return await ResolveByHashingManifestAsync(client, manifestUrl, registry, scope, image, cancellationToken);
            }
        }
        // Only a genuine caller abort propagates. HttpClient reports its own Timeout as a
        // TaskCanceledException, which is an OperationCanceledException and so is indistinguishable
        // by type from cancellation — and the named client's timeout is deliberately shorter than the
        // adapter's probe deadline, so when it fires no deadline above has. Letting it escape did not
        // merely skip the CLI fallback: every layer up to SweepAsync rethrows an unexplained
        // cancellation, whose shutdown handler exits the sweep quietly, so one slow registry ended the
        // whole fleet check with the remaining apps left unverdicted. Keying on the caller's token
        // rather than sniffing for an inner TimeoutException also covers any other stray cancellation
        // from inside the stack.
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            logger.LogDebug(
                "Registry digest probe for '{Image}' timed out; falling back to the docker CLI.",
                image.TagReference);
            return null;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Same contract as the docker probe it fronts: unresolvable is null, never an exception,
            // so a plan degrades one service to "unknown" instead of failing outright.
            logger.LogDebug(
                ex,
                "Registry digest probe for '{Image}' failed; falling back to the docker CLI.",
                image.TagReference);
            return null;
        }
    }

    private async Task<HttpResponseMessage> SendManifestProbeAsync(
        HttpClient client,
        string manifestUrl,
        string registry,
        string scope,
        bool useCachedToken,
        CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Head, manifestUrl);
        request.Headers.TryAddWithoutValidation("Accept", ManifestAcceptHeader);

        var cacheKey = $"{registry}\n{scope}";
        if (!useCachedToken)
        {
            tokens.TryRemove(cacheKey, out _);
        }
        else if (tokens.TryGetValue(cacheKey, out var cached) && !cached.IsExpired)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", cached.Token);
            return await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        }

        var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (response.StatusCode != HttpStatusCode.Unauthorized)
        {
            // Public registries that need no token at all (a plain local registry) answer immediately.
            return response;
        }

        // The challenge names where to get a token and for what; anything else means this registry
        // wants a scheme we do not implement (Basic, for instance), which is the CLI's job.
        var challenge = response.Headers.WwwAuthenticate.FirstOrDefault(header =>
            string.Equals(header.Scheme, "Bearer", StringComparison.OrdinalIgnoreCase));
        if (challenge?.Parameter is null)
        {
            return response;
        }

        response.Dispose();
        var token = await RequestAnonymousTokenAsync(client, challenge.Parameter, scope, cancellationToken);
        if (token is null)
        {
            // Report it as the 401 it is, so the caller falls back rather than retrying bare.
            return new HttpResponseMessage(HttpStatusCode.Unauthorized);
        }

        tokens[cacheKey] = token;

        using var authorized = new HttpRequestMessage(HttpMethod.Head, manifestUrl);
        authorized.Headers.TryAddWithoutValidation("Accept", ManifestAcceptHeader);
        authorized.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.Token);
        return await client.SendAsync(authorized, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
    }

    // Fetches an anonymous pull token from the realm the challenge named. The scope is taken from our
    // own request rather than the challenge, so a registry cannot widen what we ask for.
    private async Task<CachedRegistryToken?> RequestAnonymousTokenAsync(
        HttpClient client,
        string challengeParameter,
        string scope,
        CancellationToken cancellationToken)
    {
        var parameters = ParseChallengeParameters(challengeParameter);
        if (!parameters.TryGetValue("realm", out var realm) ||
            !Uri.TryCreate(realm, UriKind.Absolute, out var realmUri) ||
            realmUri.Scheme != Uri.UriSchemeHttps)
        {
            // An http realm would leak the request, and a relative one is malformed. Neither is worth
            // supporting when the CLI fallback handles the registry anyway.
            return null;
        }

        var query = $"scope={Uri.EscapeDataString(scope)}";
        if (parameters.TryGetValue("service", out var service) && !string.IsNullOrWhiteSpace(service))
        {
            query += $"&service={Uri.EscapeDataString(service)}";
        }

        var separator = string.IsNullOrEmpty(realmUri.Query) ? "?" : "&";
        using var response = await client.GetAsync($"{realm}{separator}{query}", HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            return null;
        }

        // Same exposure as the manifest body: deserializing straight off an unbounded remote stream
        // lets the auth endpoint decide how much Core allocates. A token document is a few hundred
        // bytes, so cap the read well above that and refuse anything larger.
        if (response.Content.Headers.ContentLength > MaxTokenBytes)
        {
            return null;
        }

        // Reads at most one byte past the cap, so an oversized document is detected without ever being
        // held in full (a CopyToAsync into a MemoryStream would have re-introduced the very problem).
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        var buffer = new byte[MaxTokenBytes + 1];
        var total = 0;
        while (total < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(total), cancellationToken);
            if (read == 0)
            {
                break;
            }

            total += read;
        }

        if (total is 0 or > MaxTokenBytes)
        {
            return null;
        }

        var payload = JsonSerializer.Deserialize(buffer.AsSpan(0, total), CoreJsonSerializerContext.Default.RegistryTokenResponse);

        // Registries disagree on the field name: the OAuth2 shape says `access_token`, the older
        // Docker token spec says `token`, and Docker Hub sends both.
        var value = payload?.Token ?? payload?.AccessToken;
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        // `expires_in` is optional and the spec's default is 60s. Expire early so a token is never
        // used in the last moments of its life, and cap the trusted lifetime: a registry claiming a
        // year-long token should not keep us from re-challenging.
        var lifetime = TimeSpan.FromSeconds(Math.Clamp(payload!.ExpiresIn ?? 60, 30, 3600));
        return new CachedRegistryToken(value, DateTimeOffset.UtcNow + lifetime - TimeSpan.FromSeconds(10));
    }

    // GET-and-hash fallback for registries that omit Docker-Content-Digest on a HEAD.
    private async Task<string?> ResolveByHashingManifestAsync(
        HttpClient client,
        string manifestUrl,
        string registry,
        string scope,
        RuntimeDockerImage image,
        CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, manifestUrl);
        request.Headers.TryAddWithoutValidation("Accept", ManifestAcceptHeader);
        if (tokens.TryGetValue($"{registry}\n{scope}", out var cached) && !cached.IsExpired)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", cached.Token);
        }

        // ResponseHeadersRead, so the body is streamed under the cap below rather than buffered whole
        // before anyone gets to check its size.
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            return null;
        }

        if (response.Headers.TryGetValues("Docker-Content-Digest", out var values) &&
            ParseDigest(values.FirstOrDefault()) is { } headerDigest)
        {
            return headerDigest;
        }

        // A declared length past the cap is refused before a single byte is read.
        if (response.Content.Headers.ContentLength > MaxManifestBytes)
        {
            return RejectOversizedManifest(image, response.Content.Headers.ContentLength.Value);
        }

        // Hash incrementally, stopping the moment the body outgrows the cap. Reading it whole first
        // and checking the length afterwards is what makes such a limit decorative: a misconfigured —
        // or hostile — registry could have Core buffer hundreds of megabytes during a routine update
        // check, and every app's check hits this path against its own registry.
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[8192];
        var total = 0L;
        while (true)
        {
            var read = await stream.ReadAsync(buffer, cancellationToken);
            if (read == 0)
            {
                break;
            }

            total += read;
            if (total > MaxManifestBytes)
            {
                return RejectOversizedManifest(image, total);
            }

            hash.AppendData(buffer, 0, read);
        }

        if (total == 0)
        {
            logger.LogDebug(
                "Registry manifest for '{Image}' was empty; falling back to the docker CLI.",
                image.TagReference);
            return null;
        }

        return $"sha256:{Convert.ToHexStringLower(hash.GetHashAndReset())}";
    }

    // A manifest is kilobytes; a body past this is not one, and hashing it would only produce a digest
    // no registry would agree with. Generous enough that no legitimate index is refused.
    private const long MaxManifestBytes = 4 * 1024 * 1024;

    // A token document is a few hundred bytes; this leaves ample room for long-lived JWTs.
    private const int MaxTokenBytes = 64 * 1024;

    private string? RejectOversizedManifest(RuntimeDockerImage image, long length)
    {
        logger.LogDebug(
            "Registry manifest for '{Image}' exceeded {Limit} bytes (saw at least {Length}), which is not a manifest; falling back to the docker CLI.",
            image.TagReference,
            MaxManifestBytes,
            length);
        return null;
    }

    // Splits a docker repository reference into registry host and repository path, applying Docker
    // Hub's implicit defaults. The first path component is a registry only when it looks like a host
    // (contains a dot or port, or is literally localhost) — otherwise `alex/app` would be read as host
    // `alex`, which is exactly the ambiguity docker's own reference parser resolves this way.
    internal static bool TryParseReference(string? repository, out string registry, out string repositoryPath)
    {
        registry = string.Empty;
        repositoryPath = string.Empty;

        var trimmed = repository?.Trim();
        if (string.IsNullOrEmpty(trimmed) || trimmed.Contains(' ') || trimmed.StartsWith('/') || trimmed.EndsWith('/'))
        {
            return false;
        }

        var separator = trimmed.IndexOf('/');
        var firstComponent = separator < 0 ? string.Empty : trimmed[..separator];
        var looksLikeHost = firstComponent.Length > 0 &&
            (firstComponent.Contains('.') ||
             firstComponent.Contains(':') ||
             string.Equals(firstComponent, "localhost", StringComparison.Ordinal));

        if (looksLikeHost)
        {
            registry = firstComponent;
            repositoryPath = trimmed[(separator + 1)..];
        }
        else
        {
            // Docker Hub. Official single-name images live under the implicit `library/` namespace.
            registry = "registry-1.docker.io";
            repositoryPath = separator < 0 ? $"library/{trimmed}" : trimmed;
        }

        // Docker Hub's canonical names are not the host that serves the registry API.
        if (registry is "docker.io" or "index.docker.io")
        {
            registry = "registry-1.docker.io";
        }

        if (repositoryPath.Length == 0 || repositoryPath.Contains("//", StringComparison.Ordinal))
        {
            return false;
        }

        // The path segments go into a URL unescaped, so anything that could alter its structure — a
        // traversal, a query, a fragment — disqualifies the reference rather than being encoded away.
        foreach (var character in repositoryPath)
        {
            if (character is '?' or '#' or '\\' or '@' or ' ')
            {
                return false;
            }
        }

        return !repositoryPath.Split('/').Any(segment => segment is "." or ".." or "");
    }

    // `Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="..."` — a
    // comma-separated list of key="value" pairs, values optionally unquoted.
    internal static Dictionary<string, string> ParseChallengeParameters(string parameter)
    {
        var parsed = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var index = 0;
        while (index < parameter.Length)
        {
            while (index < parameter.Length && (parameter[index] == ',' || char.IsWhiteSpace(parameter[index])))
            {
                index++;
            }

            var keyStart = index;
            while (index < parameter.Length && parameter[index] != '=' && parameter[index] != ',')
            {
                index++;
            }

            if (index >= parameter.Length || parameter[index] != '=')
            {
                break;
            }

            var key = parameter[keyStart..index].Trim();
            index++; // '='

            string value;
            if (index < parameter.Length && parameter[index] == '"')
            {
                index++;
                var valueStart = index;
                while (index < parameter.Length && parameter[index] != '"')
                {
                    index++;
                }

                value = parameter[valueStart..Math.Min(index, parameter.Length)];
                index = Math.Min(index + 1, parameter.Length);
            }
            else
            {
                var valueStart = index;
                while (index < parameter.Length && parameter[index] != ',')
                {
                    index++;
                }

                value = parameter[valueStart..index].Trim();
            }

            if (key.Length > 0)
            {
                parsed[key] = value;
            }
        }

        return parsed;
    }

    // Accepts only a well-formed lowercase-hex sha256 digest; anything else is treated as no answer
    // rather than written into an artifact lock.
    private static string? ParseDigest(string? value)
    {
        var trimmed = value?.Trim();
        if (trimmed is null || !trimmed.StartsWith("sha256:", StringComparison.Ordinal))
        {
            return null;
        }

        var hex = trimmed["sha256:".Length..];
        if (hex.Length != 64)
        {
            return null;
        }

        foreach (var character in hex)
        {
            if (!char.IsAsciiDigit(character) && character is < 'a' or > 'f')
            {
                return null;
            }
        }

        return trimmed;
    }

    private sealed record CachedRegistryToken(string Token, DateTimeOffset ExpiresAt)
    {
        public bool IsExpired => DateTimeOffset.UtcNow >= ExpiresAt;
    }
}

// Token endpoint response. `token` is the Docker registry auth spec's field, `access_token` the OAuth2
// one; Docker Hub sends both, GHCR sends `token`.
internal sealed record RegistryTokenResponse
{
    [JsonPropertyName("token")]
    public string? Token { get; init; }

    [JsonPropertyName("access_token")]
    public string? AccessToken { get; init; }

    [JsonPropertyName("expires_in")]
    public int? ExpiresIn { get; init; }
}
