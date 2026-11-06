using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using Haas.Hosty.Releases;

namespace Haas.Hosty.Core;

internal sealed record ImageReadiness(string? Digest, string? ErrorCode = null, string? Error = null, string? Platform = null)
{
    public bool Ready => Digest is not null && ErrorCode is null;
}
internal interface IRegistryImageReadiness
{
    Task<ImageReadiness> CheckAsync(RuntimeDockerImage image, string platform, CancellationToken ct);
}
internal interface IImageReadinessResolver
{
    Task<ImageReadiness> CheckImageAsync(RuntimeDockerImage image, CancellationToken ct);
}

internal sealed partial class RegistryDigestResolver : IRegistryImageReadiness
{
    public async Task<ImageReadiness> CheckAsync(RuntimeDockerImage image, string platform, CancellationToken ct)
    {
        if (!TryParseReference(image.Repository, out var registry, out var repository))
            return new(null, "image_reference_invalid", "The image repository is invalid.", platform);
        try
        {
            var client = httpClientFactory.CreateClient(HttpClientName);
            var root = $"https://{registry}/v2/{repository}";
            var scope = $"repository:{repository}:pull";
            var url = root + "/manifests/" + Uri.EscapeDataString(image.Digest ?? image.Tag);
            // Reuse the existing bounded anonymous challenge/token cache. Credentialed access remains
            // Docker's responsibility and does not copy its registry secrets into Core.
            using (var probe = await SendManifestProbeAsync(client, url, registry, scope, true, ct))
            {
                if (probe.StatusCode == HttpStatusCode.Unauthorized)
                {
                    using var refreshed = await SendManifestProbeAsync(client, url, registry, scope, false, ct);
                    RequireRegistrySuccess(refreshed);
                }
                else RequireRegistrySuccess(probe);
            }
            var (bytes, digest) = await ReadRegistryDocumentAsync(client, url, registry, scope, image.Digest, null, ct);
            using var document = JsonDocument.Parse(bytes);
            var manifest = document.RootElement;
            RequireSchema(manifest);
            if (manifest.TryGetProperty("manifests", out var entries))
            {
                if (entries.ValueKind != JsonValueKind.Array || entries.GetArrayLength() > 256)
                    throw InvalidManifest();
                var matches = entries.EnumerateArray().Where(entry => entry.ValueKind == JsonValueKind.Object && entry.TryGetProperty("platform", out var target)
                    && ReadString(target, "os") + "/" + ReadString(target, "architecture") == platform
                    && ReadString(entry, "mediaType") is "application/vnd.oci.image.manifest.v1+json" or "application/vnd.docker.distribution.manifest.v2+json").ToArray();
                if (matches.Length != 1)
                    throw new PlatformReleaseException("image_platform_unavailable", $"The image has no manifest for '{platform}'.");
                var child = Descriptor(matches[0]);
                var (childBytes, _) = await ReadRegistryDocumentAsync(client, root + "/manifests/" + child.Digest,
                    registry, scope, child.Digest, child.Size, ct);
                using var childDocument = JsonDocument.Parse(childBytes);
                await ValidateImageManifestAsync(client, root, registry, scope, childDocument.RootElement, platform, ct);
            }
            else await ValidateImageManifestAsync(client, root, registry, scope, manifest, platform, ct);
            return new(digest, Platform: platform);
        }
        catch (PlatformReleaseException error) { return new(null, error.Code, error.Message, platform); }
        catch (JsonException) { return new(null, "image_manifest_invalid", "The registry returned a malformed image manifest.", platform); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { return new(null, "registry_timeout", "Registry verification timed out.", platform); }
        catch (Exception error) when (error is HttpRequestException or IOException or InvalidOperationException)
        { return new(null, "registry_unavailable", "The registry could not be verified.", platform); }
    }

    private async Task ValidateImageManifestAsync(HttpClient client, string root, string registry, string scope,
        JsonElement manifest, string platform, CancellationToken ct)
    {
        RequireSchema(manifest);
        if (!manifest.TryGetProperty("config", out var config) || !manifest.TryGetProperty("layers", out var layers)
            || layers.ValueKind != JsonValueKind.Array || layers.GetArrayLength() > 256) throw InvalidManifest();
        var configDescriptor = Descriptor(config);
        var (bytes, _) = await ReadRegistryDocumentAsync(client, root + "/blobs/" + configDescriptor.Digest,
            registry, scope, configDescriptor.Digest, configDescriptor.Size, ct);
        using var configuration = JsonDocument.Parse(bytes);
        if (ReadString(configuration.RootElement, "os") + "/" + ReadString(configuration.RootElement, "architecture") != platform)
            throw new PlatformReleaseException("image_platform_unavailable", $"The image configuration is not for '{platform}'.");
        foreach (var layer in layers.EnumerateArray())
        {
            var descriptor = Descriptor(layer);
            using var response = await SendRegistryContentAsync(client, HttpMethod.Head, root + "/blobs/" + descriptor.Digest, registry, scope, ct);
            RequireRegistrySuccess(response);
            if (response.Content.Headers.ContentLength != descriptor.Size)
                throw new PlatformReleaseException("image_blob_invalid", "A layer size differs from its image manifest.");
        }
    }

    private async Task<(byte[] Bytes, string Digest)> ReadRegistryDocumentAsync(HttpClient client, string url,
        string registry, string scope, string? expectedDigest, long? expectedSize, CancellationToken ct)
    {
        using var response = await SendRegistryContentAsync(client, HttpMethod.Get, url, registry, scope, ct);
        RequireRegistrySuccess(response);
        if (expectedSize > MaxManifestBytes || response.Content.Headers.ContentLength > MaxManifestBytes)
            throw new PlatformReleaseException("image_manifest_too_large", "Image metadata exceeds the supported size limit.");
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        var buffer = new byte[MaxManifestBytes + 1];
        var total = 0;
        while (total < buffer.Length)
        {
            var count = await stream.ReadAsync(buffer.AsMemory(total), ct);
            if (count == 0) break;
            total += count;
        }
        if (total == 0 || total > MaxManifestBytes || expectedSize is not null && total != expectedSize)
            throw new PlatformReleaseException("image_manifest_invalid", "Image metadata is empty, truncated or exceeds its declared size.");
        var bytes = buffer[..total];
        var actual = "sha256:" + Convert.ToHexStringLower(SHA256.HashData(bytes));
        if (expectedDigest is not null && actual != expectedDigest
            || response.Headers.TryGetValues("Docker-Content-Digest", out var values) && values.SingleOrDefault() != actual)
            throw new PlatformReleaseException("image_digest_mismatch", "The manifest bytes differ from the requested or advertised digest.");
        return (bytes, actual);
    }

    private async Task<HttpResponseMessage> SendRegistryContentAsync(HttpClient client, HttpMethod method, string url,
        string registry, string scope, CancellationToken ct)
    {
        var uri = new Uri(url);
        var refreshedToken = false;
        for (var redirects = 0; redirects <= 5; redirects++)
        {
            if (uri.Scheme != "https" || uri.UserInfo.Length != 0) throw InvalidManifest();
            using var request = new HttpRequestMessage(method, uri);
            request.Headers.TryAddWithoutValidation("Accept", ManifestAcceptHeader);
            if (uri.Authority == registry && tokens.TryGetValue($"{registry}\n{scope}", out var cached) && !cached.IsExpired)
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", cached.Token);
            var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            if (!refreshedToken && uri.Authority == registry && response.StatusCode == HttpStatusCode.Unauthorized)
            {
                refreshedToken = true;
                using var refreshed = await SendManifestProbeAsync(client, uri.AbsoluteUri, registry, scope, false, ct);
                if (refreshed.IsSuccessStatusCode) { response.Dispose(); continue; }
            }
            if ((int)response.StatusCode is >= 300 and < 400 && response.Headers.Location is { } location)
            {
                uri = new Uri(uri, location); response.Dispose(); continue;
            }
            return response;
        }
        throw new PlatformReleaseException("registry_unavailable", "The registry returned too many redirects.");
    }

    internal static (string Digest, long Size) Descriptor(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object || !ArtifactIdentity.IsDigest(ReadString(element, "digest"))
            || !element.TryGetProperty("size", out var size) || size.ValueKind != JsonValueKind.Number || !size.TryGetInt64(out var length) || length < 0)
            throw InvalidManifest();
        return (ReadString(element, "digest")!, length);
    }
    internal static string? ReadString(JsonElement element, string key) => element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    private static void RequireSchema(JsonElement manifest)
    {
        if (manifest.ValueKind != JsonValueKind.Object || !manifest.TryGetProperty("schemaVersion", out var schema)
            || schema.ValueKind != JsonValueKind.Number || !schema.TryGetInt32(out var version) || version != 2) throw InvalidManifest();
    }
    private static PlatformReleaseException InvalidManifest() => new("image_manifest_invalid", "The registry image manifest is malformed or unsupported.");
    private static void RequireRegistrySuccess(HttpResponseMessage response)
    {
        if (response.IsSuccessStatusCode) return;
        var (code, message) = response.StatusCode switch
        {
            HttpStatusCode.NotFound => ("image_missing", "An image manifest or required blob is not published or is no longer available."),
            HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden => ("registry_access_denied", "Registry access was denied."),
            HttpStatusCode.TooManyRequests => ("registry_rate_limited", "The registry rate limit was reached."),
            _ => ("registry_unavailable", "The registry could not verify this image."),
        };
        throw new PlatformReleaseException(code, message);
    }
}
