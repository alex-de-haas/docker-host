using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Releases;

internal sealed record PlatformFeedIndex(string SchemaVersion, IReadOnlyList<PlatformFeed> Feeds);
internal sealed record PlatformFeed(string Id, string ReleaseRef, string ReleaseSha256, bool Default = false, string? Label = null);
internal sealed record PlatformRelease(string SchemaVersion, string ReleaseId, string Version, string SourceCommit,
    IReadOnlyList<PlatformReleaseAsset> Assets);
internal sealed record PlatformReleaseAsset(string Role, string Rid, string FileName, string Url, long Size,
    string Sha256, string InputFingerprint, string Provenance);
internal sealed record PlatformUpdateSource(string SchemaVersion, string IndexRef, string FeedId, string Revision, bool LegacyIndex = false);
internal sealed record PlatformReleaseSelection(PlatformUpdateSource Source, PlatformFeed Feed, PlatformRelease Release,
    string IndexSha256, string DescriptorSha256);
internal sealed record PlatformInstallReceipt(string SchemaVersion, PlatformReleaseSelection Selection, string Rid,
    DateTimeOffset InstalledAt);
internal sealed record PlatformDistribution(string IndexRef, string LegacyRepository, string LegacyFeedId,
    string LegacyReleaseTag, string MigratedFeedId, string? BridgeRef = null, string? LegacyShellManifestPath = null);

internal sealed class PlatformReleaseException(string code, string message) : InvalidOperationException(message)
{
    public string Code { get; } = code;
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, RespectNullableAnnotations = true)]
[JsonSerializable(typeof(PlatformFeedIndex))]
[JsonSerializable(typeof(PlatformRelease))]
[JsonSerializable(typeof(PlatformUpdateSource))]
[JsonSerializable(typeof(PlatformReleaseSelection))]
[JsonSerializable(typeof(PlatformInstallReceipt))]
[JsonSerializable(typeof(PlatformDistribution))]
internal partial class PlatformReleaseJson : JsonSerializerContext;

internal sealed partial class PlatformReleaseReader(HttpClient client)
{
    public const int MaxDocumentBytes = 1024 * 1024;

    public async Task<(PlatformFeedIndex Index, string Sha256)> ReadIndexAsync(string indexRef, CancellationToken ct = default, bool allowLegacy = false)
    {
        var bytes = await ReadDocumentAsync(indexRef, IsLocalReference(indexRef), ct);
        var index = ParseIndex(bytes, indexRef, allowLegacy);
        ValidateIndex(index, IsLocalReference(indexRef));
        return (index, Hash(bytes));
    }

    public async Task<PlatformReleaseSelection> ResolveAsync(string indexRef, string? feedId,
        string? sourceRevision = null, CancellationToken ct = default, bool allowLegacy = false)
    {
        var indexBytes = await ReadDocumentAsync(indexRef, IsLocalReference(indexRef), ct);
        var index = ParseIndex(indexBytes, indexRef, allowLegacy);
        var hash = Hash(indexBytes);
        if (index.SchemaVersion == "hosty-platform-legacy-feeds.0.1")
            return await ResolveLegacyAsync(indexBytes, indexRef, index, feedId, sourceRevision, ct);
        var feed = SelectFeed(index, feedId);
        var bytes = await ReadDocumentAsync(feed.ReleaseRef, IsLocalReference(indexRef), ct);
        var descriptorHash = Hash(bytes);
        if (descriptorHash != feed.ReleaseSha256)
            throw new PlatformReleaseException("platform_descriptor_hash_mismatch", "The release descriptor differs from the feed's pinned SHA256.");
        var release = Parse(bytes, PlatformReleaseJson.Default.PlatformRelease);
        ValidateRelease(release, IsLocalReference(indexRef));
        return new(new("hosty-platform-update-source.0.1", indexRef, feed.Id, sourceRevision ?? Guid.NewGuid().ToString("N")),
            feed, release, hash, descriptorHash);
    }

    public static PlatformFeed SelectFeed(PlatformFeedIndex index, string? requested)
    {
        ValidateIndex(index, allowLocal: true);
        if (requested is not null)
            return index.Feeds.SingleOrDefault(f => f.Id == requested)
                ?? throw new PlatformReleaseException("platform_feed_not_found", $"The selected feed '{requested}' is not present in this index.");
        if (index.Feeds.Count == 1) return index.Feeds[0];
        return index.Feeds.SingleOrDefault(f => f.Default)
            ?? throw new PlatformReleaseException("platform_feed_selection_required", "This index has several feeds and no default. Select a feed explicitly.");
    }

    public static void ValidateIndex(PlatformFeedIndex index, bool allowLocal = false)
    {
        if (index.SchemaVersion is not ("hosty-platform-feeds.0.1" or "hosty-platform-legacy-feeds.0.1") || index.Feeds is not { Count: > 0 })
            throw new PlatformReleaseException("platform_feed_index_invalid", "Unsupported or empty platform feed index.");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var defaults = 0;
        foreach (var feed in index.Feeds)
        {
            if (feed is null || string.IsNullOrWhiteSpace(feed.Id) || feed.Id != feed.Id.Trim() || feed.Id.Length > 128
                || feed.Id.Any(char.IsControl) || !ids.Add(feed.Id) || !ArtifactIdentity.IsHash(feed.ReleaseSha256))
                throw new PlatformReleaseException("platform_feed_invalid", "Feed IDs must be unique, nonempty and at most 128 characters; release SHA256 is required.");
            ValidateReference(feed.ReleaseRef, allowLocal);
            if (feed.Default && ++defaults > 1)
                throw new PlatformReleaseException("platform_feed_defaults_invalid", "An index can declare at most one default feed.");
        }
    }

    public static void ValidateRelease(PlatformRelease release, bool allowLocal = false)
    {
        if (release.SchemaVersion is not ("hosty-platform-release.0.1" or "hosty-platform-legacy-release.0.1") || !ArtifactIdentity.IsHash(release.ReleaseId)
            || (release.SchemaVersion == "hosty-platform-release.0.1" ? !ArtifactIdentity.IsCommit(release.SourceCommit) : release.SourceCommit != "") || string.IsNullOrWhiteSpace(release.Version)
            || release.Assets is not { Count: > 0 })
            throw new PlatformReleaseException("platform_release_invalid", "The platform release descriptor is invalid or unsupported.");
        var identities = new HashSet<string>(StringComparer.Ordinal);
        foreach (var asset in release.Assets)
        {
            if (asset is null || asset.Role is not ("cli" or "core") || !IsRid(asset.Rid)
                || string.IsNullOrWhiteSpace(asset.FileName) || asset.FileName is "." or ".."
                || asset.FileName.Any(c => c is '/' or '\\' or ':' || char.IsControl(c))
                || !identities.Add(asset.Role + "/" + asset.Rid) || asset.Size <= 0
                || !ArtifactIdentity.IsHash(asset.Sha256) || !ArtifactIdentity.IsHash(asset.InputFingerprint)
                || string.IsNullOrWhiteSpace(asset.Provenance))
                throw new PlatformReleaseException("platform_asset_invalid", "Release assets require distinct roles/targets, safe names, size, SHA256 and build provenance.");
            ValidateReference(asset.Url, allowLocal);
        }
        foreach (var target in release.Assets.Select(a => a.Rid).Distinct(StringComparer.Ordinal))
            if (!identities.Contains("cli/" + target) || !identities.Contains("core/" + target))
                throw new PlatformReleaseException("platform_release_incomplete", $"The release lacks the CLI/Core pair for '{target}'.");
    }

    public static PlatformReleaseAsset Asset(PlatformRelease release, string role, string rid)
        => release.Assets.SingleOrDefault(a => a.Role == role && a.Rid == rid)
            ?? throw new PlatformReleaseException("platform_target_unsupported", $"This release does not provide {role} for '{rid}'.");

    public async Task StageAssetAsync(PlatformReleaseAsset asset, string targetPath, bool allowLocal, CancellationToken ct)
    {
        ValidateReference(asset.Url, allowLocal);
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(targetPath))!);
        if (File.Exists(targetPath) && await MatchesAssetAsync(targetPath, asset, ct)) return;
        var temporary = targetPath + "." + Guid.NewGuid().ToString("N") + ".download";
        try
        {
            using var response = IsLocalReference(asset.Url) ? null
                : await client.GetAsync(asset.Url, HttpCompletionOption.ResponseHeadersRead, ct);
            if (response is not null) EnsureSuccess(response);
            if (response?.Content.Headers.ContentLength is { } declared && declared != asset.Size)
                throw new PlatformReleaseException("platform_asset_size_mismatch", "The asset size differs from the release descriptor.");
            await using var input = response is null ? File.OpenRead(asset.Url) : await response.Content.ReadAsStreamAsync(ct);
            await using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, true))
            {
                using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                var buffer = new byte[81920];
                long total = 0;
                while (true)
                {
                    var count = await input.ReadAsync(buffer, ct);
                    if (count == 0) break;
                    total += count;
                    if (total > asset.Size) throw new PlatformReleaseException("platform_asset_size_mismatch", "The asset exceeded its declared size.");
                    hash.AppendData(buffer, 0, count);
                    await output.WriteAsync(buffer.AsMemory(0, count), ct);
                }
                if (total != asset.Size || Convert.ToHexStringLower(hash.GetHashAndReset()) != asset.Sha256)
                    throw new PlatformReleaseException("platform_asset_hash_mismatch", "The downloaded asset failed release SHA256/size verification.");
                await output.FlushAsync(ct);
            }
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            File.Move(temporary, targetPath, overwrite: true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    public async Task CheckAssetsAsync(PlatformReleaseSelection selection, string rid, CancellationToken ct)
    {
        var local = IsLocalReference(selection.Source.IndexRef);
        foreach (var role in new[] { "cli", "core" })
        {
            var asset = Asset(selection.Release, role, rid);
            ValidateReference(asset.Url, local);
            if (IsLocalReference(asset.Url))
            {
                if (!await MatchesAssetAsync(asset.Url, asset, ct))
                    throw new PlatformReleaseException("platform_asset_unavailable", "The selected release asset is missing or has changed.");
                continue;
            }
            using var request = new HttpRequestMessage(HttpMethod.Head, asset.Url);
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            EnsureSuccess(response);
            if (response.Content.Headers.ContentLength is { } length && length != asset.Size)
                throw new PlatformReleaseException("platform_asset_size_mismatch", "The published asset size differs from its descriptor.");
        }
    }

    public static async Task<bool> MatchesAssetAsync(string path, PlatformReleaseAsset asset, CancellationToken ct)
    {
        if (!File.Exists(path) || new FileInfo(path).Length != asset.Size) return false;
        await using var stream = File.OpenRead(path);
        return Convert.ToHexStringLower(await SHA256.HashDataAsync(stream, ct)) == asset.Sha256;
    }

    internal async Task<byte[]> ReadDocumentAsync(string reference, bool allowLocal, CancellationToken ct)
    {
        ValidateReference(reference, allowLocal);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(30));
        using var response = IsLocalReference(reference) ? null
            : await client.GetAsync(reference, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
        if (response is not null) EnsureSuccess(response);
        if (response?.Content.Headers.ContentLength > MaxDocumentBytes)
            throw new PlatformReleaseException("platform_document_too_large", "The release document exceeded the size limit.");
        await using var stream = response is null ? File.OpenRead(reference) : await response.Content.ReadAsStreamAsync(deadline.Token);
        var bytes = new byte[MaxDocumentBytes + 1];
        var total = 0;
        while (total < bytes.Length)
        {
            var count = await stream.ReadAsync(bytes.AsMemory(total), deadline.Token);
            if (count == 0) break;
            total += count;
        }
        if (total is 0 or > MaxDocumentBytes)
            throw new PlatformReleaseException("platform_document_invalid_size", "The release document is empty or exceeds the size limit.");
        return bytes[..total];
    }

    private static T Parse<T>(byte[] bytes, JsonTypeInfo<T> type) where T : class
    {
        try { return JsonSerializer.Deserialize(bytes, type) ?? throw new JsonException("Empty JSON."); }
        catch (JsonException) { throw new PlatformReleaseException("platform_document_invalid", "The release document is malformed."); }
    }

    private static void EnsureSuccess(HttpResponseMessage response)
    {
        if (response.RequestMessage?.RequestUri is { } final && final.Scheme != Uri.UriSchemeHttps)
            throw new PlatformReleaseException("platform_source_invalid", "A release source redirected away from HTTPS.");
        if (response.IsSuccessStatusCode) return;
        var code = response.StatusCode switch
        {
            HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden => "platform_source_access_denied",
            HttpStatusCode.NotFound => "platform_source_not_found",
            HttpStatusCode.TooManyRequests => "platform_source_rate_limited",
            _ => "platform_source_unavailable",
        };
        throw new PlatformReleaseException(code, $"Release source returned HTTP {(int)response.StatusCode}; no other feed was selected.");
    }

    internal static bool IsLocalReference(string reference) => Path.IsPathFullyQualified(reference)
        && (!Uri.TryCreate(reference, UriKind.Absolute, out var uri) || uri.IsFile);

    public static void ValidateReference(string? reference, bool allowLocal)
    {
        if (string.IsNullOrWhiteSpace(reference) || reference.Any(char.IsControl))
            throw new PlatformReleaseException("platform_source_invalid", "Release references must be absolute HTTPS URLs or explicitly selected local files.");
        if (allowLocal && IsLocalReference(reference)) return;
        if (!Uri.TryCreate(reference, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps
            || uri.UserInfo.Length != 0 || uri.Fragment.Length != 0)
            throw new PlatformReleaseException("platform_source_invalid", "Remote release references require HTTPS without embedded credentials or fragments.");
    }

    private static bool IsRid(string? value) => !string.IsNullOrEmpty(value) && value.Length <= 64
        && value.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '.');
    public static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
}

internal static class PlatformFeedFiles
{
    public static string SourcePath(string root) => Path.Combine(root, "core", "update-source.json");
    public static string ReceiptPath(string root) => Path.Combine(root, "core", "installed-release.json");
    public static string BootstrapPath(string executable) => executable + ".release.json";

    public static PlatformUpdateSource? ReadSource(string root)
    {
        var source = CoreLaunchFiles.Read(SourcePath(root), PlatformReleaseJson.Default.PlatformUpdateSource);
        if (source is null) return null;
        if (source.SchemaVersion != "hosty-platform-update-source.0.1" || string.IsNullOrWhiteSpace(source.FeedId)
            || string.IsNullOrWhiteSpace(source.Revision))
            throw new PlatformReleaseException("platform_update_source_invalid", "The saved platform feed is invalid; select an update source explicitly.");
        PlatformReleaseReader.ValidateReference(source.IndexRef, allowLocal: true);
        return source;
    }

    // Caller holds the selected data root's launch/source mutation lock.
    public static PlatformUpdateSource SaveSource(string root, PlatformUpdateSource next, string? expectedRevision)
    {
        var current = ReadSource(root);
        if (current?.Revision != expectedRevision)
            throw new PlatformReleaseException("platform_update_source_stale", "The selected update source changed. Read the current selection before saving.");
        var saved = next with { Revision = Guid.NewGuid().ToString("N") };
        // Explicit selection also archives custom legacy configuration without reinterpreting it.
        var legacy = Path.Combine(root, "core", "product-channel.json");
        if (File.Exists(legacy))
        {
            var bytes = File.ReadAllBytes(legacy);
            var backup = legacy + ".pre-feeds-" + PlatformReleaseReader.Hash(bytes);
            if (File.Exists(backup) && PlatformReleaseReader.Hash(File.ReadAllBytes(backup)) != PlatformReleaseReader.Hash(bytes))
                throw new PlatformReleaseException("platform_migration_conflict", "The legacy selection backup differs.");
            if (!File.Exists(backup)) File.WriteAllBytes(backup, bytes);
        }
        CoreLaunchFiles.Write(SourcePath(root), saved, PlatformReleaseJson.Default.PlatformUpdateSource);
        if (File.Exists(legacy)) File.Delete(legacy);
        return saved;
    }
}
