using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Haas.Hosty.Releases;

internal sealed record LegacyPlatformIndex(IReadOnlyList<LegacyPlatformChannel> Channels);
internal sealed record LegacyPlatformChannel(string Id, string? Label = null, string? CliVersion = null,
    string? CoreArtifactPrefix = null, string? ShellManifestPath = null, string? ReleaseTag = null, string? Repository = null);

[JsonSerializable(typeof(LegacyPlatformIndex))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, RespectNullableAnnotations = true)]
internal partial class LegacyPlatformJson : JsonSerializerContext;

internal sealed partial class PlatformReleaseReader
{
    private static PlatformFeedIndex ParseIndex(byte[] bytes, string reference, bool allowLegacy)
    {
        using var document = JsonDocument.Parse(bytes);
        if (document.RootElement.TryGetProperty("schemaVersion", out var schema))
        {
            if (schema.GetString() != "hosty-platform-feeds.0.1")
                throw new PlatformReleaseException("platform_feed_index_invalid", "Unsupported platform feed schema.");
            return Parse(bytes, PlatformReleaseJson.Default.PlatformFeedIndex);
        }
        if (!allowLegacy) throw new PlatformReleaseException("platform_feed_index_invalid", "An unversioned product index must be selected explicitly.");
        var legacy = Parse(bytes, LegacyPlatformJson.Default.LegacyPlatformIndex);
        if (legacy.Channels is not { Count: > 0 }) throw new PlatformReleaseException("platform_legacy_index_invalid", "The explicit legacy product index has no channels.");
        return new("hosty-platform-legacy-feeds.0.1", legacy.Channels.Select(c =>
            new PlatformFeed(c.Id, reference, Hash(bytes), Label: c.Label)).ToArray());
    }

    private async Task<PlatformReleaseSelection> ResolveLegacyAsync(byte[] indexBytes, string indexRef,
        PlatformFeedIndex index, string? feedId, string? revision, CancellationToken ct)
    {
        var feed = SelectFeed(index, feedId);
        var channel = Parse(indexBytes, LegacyPlatformJson.Default.LegacyPlatformIndex).Channels.Single(c => c.Id == feed.Id);
        var distribution = PlatformFeedSource.Distribution;
        var repository = channel.Repository ?? distribution.LegacyRepository;
        var tag = channel.ReleaseTag ?? distribution.LegacyReleaseTag;
        static bool Part(string? value) => !string.IsNullOrWhiteSpace(value) && !value.Contains("..", StringComparison.Ordinal)
            && value.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-');
        if (repository.Split('/') is not [var owner, var name] || !Part(owner) || !Part(name) || !Part(tag)
            || !Part(channel.CoreArtifactPrefix ?? "hosty-core"))
            throw new PlatformReleaseException("platform_legacy_index_invalid", "The legacy repository, tag or artifact prefix is invalid.");
        var baseUrl = $"https://github.com/{repository}/releases/download/{tag}/";
        var checksums = await ReadDocumentAsync(baseUrl + "SHA256SUMS", false, ct);
        var checksumMap = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var line in Encoding.UTF8.GetString(checksums).Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = line.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length != 2 || !ArtifactIdentity.IsHash(parts[0]) || !checksumMap.TryAdd(parts[1].TrimStart('*'), parts[0]))
                throw new PlatformReleaseException("platform_legacy_checksums_invalid", "The legacy checksum snapshot is malformed or ambiguous.");
        }
        var version = channel.CliVersion ?? Encoding.UTF8.GetString(await ReadDocumentAsync(baseUrl + "VERSION", false, ct)).Trim();
        if (!Version.TryParse(version, out _)) throw new PlatformReleaseException("platform_legacy_version_invalid", "A legacy platform update requires a valid shared version.");
        var rid = PlatformFeedSource.CurrentRid;
        var suffix = rid.StartsWith("osx-", StringComparison.Ordinal) ? "darwin-" + rid[4..]
            : rid.StartsWith("win-", StringComparison.Ordinal) ? "windows-" + rid[4..] + ".exe" : rid;
        var assets = new List<PlatformReleaseAsset>();
        foreach (var role in new[] { "cli", "core" })
        {
            var file = (role == "cli" ? "hosty" : channel.CoreArtifactPrefix ?? "hosty-core") + "-" + suffix;
            if (!checksumMap.TryGetValue(file, out var hash))
                throw new PlatformReleaseException("platform_legacy_pair_missing", "The selected legacy checksum snapshot lacks the CLI/Core pair.");
            using var message = new HttpRequestMessage(HttpMethod.Head, baseUrl + file);
            using var response = await client.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, ct);
            EnsureSuccess(response);
            if (response.Content.Headers.ContentLength is not { } size || size <= 0)
                throw new PlatformReleaseException("platform_legacy_size_missing", "The legacy asset must declare its size before preparation.");
            assets.Add(new(role, rid, file, baseUrl + file, size, hash, Hash(checksums), "legacy-checksum:" + baseUrl + "SHA256SUMS"));
        }
        var identity = Hash(Encoding.UTF8.GetBytes(Hash(indexBytes) + "\n" + feed.Id + "\n" + repository + "\n" + tag + "\n" + Hash(checksums)));
        var release = new PlatformRelease("hosty-platform-legacy-release.0.1", identity, version, "", assets);
        ValidateRelease(release);
        return new(new("hosty-platform-update-source.0.1", indexRef, feed.Id, revision ?? Guid.NewGuid().ToString("N"), LegacyIndex: true),
            feed, release, Hash(indexBytes), Hash(JsonSerializer.SerializeToUtf8Bytes(release, PlatformReleaseJson.Default.PlatformRelease)));
    }
}
