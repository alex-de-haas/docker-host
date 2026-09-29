using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Haas.Hosty.Core;

// Registry locations are fixed, never supplied URLs. GitHub credentials never leave api.github.com.
// Public npm and GHCR reads are supported; a private/unavailable artifact cannot satisfy completion.
internal sealed class PublicationArtifacts(HttpClient http)
{
    internal static void Validate(PublicationArtifact a)
    {
        if (a.Kind == "release")
        {
            if (string.IsNullOrWhiteSpace(a.Tag) || a.Tag.Length > 200 || string.IsNullOrWhiteSpace(a.Asset) || a.Asset.Length > 200)
                throw new PublicationException("artifact_invalid", "Release evidence requires an exact tag and asset name.");
            return;
        }
        if (a.Kind is not ("npm" or "ghcr") || a.Package is null || a.Package.Length > 200 || a.Version is null ||
            !Regex.IsMatch(a.Version, @"^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$", RegexOptions.CultureInvariant))
            throw new PublicationException("artifact_invalid", "Registry evidence requires npm or ghcr, a package and an exact semantic version.");
        var pattern = a.Kind == "npm" ? @"^(?:@[a-z0-9_-]+/)?[a-z0-9][a-z0-9._-]*$" : @"^[a-z0-9][a-z0-9._-]*(?:/[a-z0-9][a-z0-9._-]*)+$";
        if (!Regex.IsMatch(a.Package, pattern, RegexOptions.CultureInvariant)) throw new PublicationException("artifact_invalid", "Invalid registry package identity.");
    }
    private async Task<(JsonNode Json, byte[] Bytes)> Get(string url, string? token, CancellationToken ct, bool redirected = false)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        if (token is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Headers.Accept.ParseAdd("application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/json");
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!redirected && response.StatusCode is System.Net.HttpStatusCode.TemporaryRedirect or System.Net.HttpStatusCode.Redirect &&
            url.StartsWith("https://ghcr.io/v2/", StringComparison.Ordinal) && url.Contains("/blobs/", StringComparison.Ordinal) &&
            response.Headers.Location is { IsAbsoluteUri: true } location && location.Scheme == "https" && location.Host == "pkg-containers.githubusercontent.com" && location.IsDefaultPort && location.UserInfo.Length == 0)
            return await Get(location.AbsoluteUri, null, ct, redirected: true);
        if (!response.IsSuccessStatusCode) throw new PublicationException("artifact_unavailable", "The exact public registry artifact is not available for verification.");
        using var buffer = new MemoryStream();
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        var chunk = new byte[16384]; int count;
        while ((count = await stream.ReadAsync(chunk, ct)) > 0)
        {
            buffer.Write(chunk, 0, count);
            if (buffer.Length > 4 * 1024 * 1024) throw new PublicationException("artifact_unavailable", "Artifact metadata exceeds the verification limit.");
        }
        var bytes = buffer.ToArray();
        return (JsonNode.Parse(bytes) ?? throw new PublicationException("artifact_unavailable", "Artifact metadata is empty."), bytes);
    }
    internal async Task<bool> Verify(PublicationArtifact a, string repository, string commit, CancellationToken ct)
    {
        Validate(a);
        if (a.Kind == "npm")
        {
            var (data, _) = await Get("https://registry.npmjs.org/" + Uri.EscapeDataString(a.Package!) + "/" + Uri.EscapeDataString(a.Version!), null, ct);
            return GitHubPublicationProvider.Text(data, "name") == a.Package && GitHubPublicationProvider.Text(data, "version") == a.Version &&
                GitHubPublicationProvider.Text(data, "gitHead") == commit && data["dist"]?["integrity"] is not null;
        }
        if (a.Kind != "ghcr") return false;
        var (auth, _) = await Get("https://ghcr.io/token?service=ghcr.io&scope=" + Uri.EscapeDataString("repository:" + a.Package + ":pull"), null, ct);
        var token = GitHubPublicationProvider.Text(auth, "token");
        if (token.Length == 0) return false;
        var root = "https://ghcr.io/v2/" + a.Package;
        var inspected = 0;
        async Task<bool> Manifest(string reference, int depth)
        {
            if (++inspected > 32 || depth > 2) return false;
            var (manifest, bytes) = await Get(root + "/manifests/" + reference, token, ct);
            if (reference.StartsWith("sha256:") && !Digest(reference, bytes)) return false;
            if (manifest["manifests"] is JsonArray children)
            {
                var runnable = children.Where(child => GitHubPublicationProvider.Text(child?["platform"], "os") != "unknown").ToArray();
                if (runnable.Length == 0) return false;
                foreach (var child in runnable)
                {
                    var digest = GitHubPublicationProvider.Text(child, "digest");
                    if (!IsDigest(digest) || !await Manifest(digest, depth + 1)) return false;
                }
                return true;
            }
            var configDigest = GitHubPublicationProvider.Text(manifest["config"], "digest");
            if (!IsDigest(configDigest)) return false;
            var (config, configBytes) = await Get(root + "/blobs/" + configDigest, token, ct);
            var labels = config["config"]?["Labels"];
            var source = GitHubPublicationProvider.Text(labels, "org.opencontainers.image.source").TrimEnd('/');
            return Digest(configDigest, configBytes) && GitHubPublicationProvider.Text(labels, "org.opencontainers.image.revision") == commit &&
                (source == "https://github.com/" + repository || source == "https://github.com/" + repository + ".git");
        }
        return await Manifest(a.Version!, 0);
    }
    private static bool IsDigest(string value) => Regex.IsMatch(value, "^sha256:[a-f0-9]{64}$", RegexOptions.CultureInvariant);
    private static bool Digest(string expected, byte[] bytes) => expected == "sha256:" + Convert.ToHexStringLower(SHA256.HashData(bytes));
}
