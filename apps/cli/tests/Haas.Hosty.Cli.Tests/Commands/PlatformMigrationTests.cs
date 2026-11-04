using System.Net;
using System.Text;
using System.Text.Json;
using Haas.Hosty.Launch;
using Haas.Hosty.Releases;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class PlatformMigrationTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "hosty-platform-migration-" + Guid.NewGuid().ToString("N"));
    private readonly Dictionary<string, byte[]> documents = new(StringComparer.Ordinal);
    private readonly PlatformDistribution distribution = new("https://publisher.test/feeds.json", "vendor/platform", "old-main", "bridge-tag", "fast-lane", "https://publisher.test/bridge.json", "apps/client/manifest.json");
    private readonly string cli;
    private readonly HttpClient client;
    private readonly PlatformRelease release;
    private string OldPath => Path.Combine(root, "core", "product-channel.json");
    private static byte[] Encode<T>(T value, System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> type) => JsonSerializer.SerializeToUtf8Bytes(value, type);
    public PlatformMigrationTests()
    {
        Directory.CreateDirectory(Path.Combine(root, "core"));
        cli = Path.Combine(root, "hosty"); File.WriteAllText(cli, "reader-cli");
        var cliBytes = Encoding.UTF8.GetBytes("reader-cli"); var coreBytes = Encoding.UTF8.GetBytes("reader-core");
        var hash = new string('a', 64);
        release = new("hosty-platform-release.0.1", hash, "0.172.0", new string('b', 40), [
            new("cli", PlatformFeedSource.CurrentRid, "hosty", "https://publisher.test/cli", cliBytes.Length, PlatformReleaseReader.Hash(cliBytes), hash, "https://publisher.test/proof"),
            new("core", PlatformFeedSource.CurrentRid, "hosty-core", "https://publisher.test/core", coreBytes.Length, PlatformReleaseReader.Hash(coreBytes), hash, "https://publisher.test/proof")]);
        documents["https://publisher.test/release.json"] = Encode(release, PlatformReleaseJson.Default.PlatformRelease);
        documents[distribution.IndexRef] = Encode(new PlatformFeedIndex("hosty-platform-feeds.0.1", [new(distribution.MigratedFeedId, "https://publisher.test/release.json", PlatformReleaseReader.Hash(documents["https://publisher.test/release.json"]))]), PlatformReleaseJson.Default.PlatformFeedIndex);
        documents[distribution.BridgeRef!] = Encode(new PlatformBridge("hosty-platform-bridge.0.1", release.ReleaseId,
            "https://publisher.test/release.json", PlatformReleaseReader.Hash(documents["https://publisher.test/release.json"]),
            distribution.LegacyRepository, distribution.LegacyReleaseTag, distribution.MigratedFeedId, distribution.IndexRef,
            "frozen", DateTimeOffset.UtcNow), PlatformMigrationJson.Default.PlatformBridge);
        documents["https://publisher.test/cli"] = cliBytes; documents["https://publisher.test/core"] = coreBytes;
        client = new(new Handler(request => documents.TryGetValue(request.RequestUri!.AbsoluteUri, out var data)
            ? new(HttpStatusCode.OK) { Content = new ByteArrayContent(data) } : new(HttpStatusCode.NotFound)));
    }

    [Fact]
    public async Task VerifiedBridgeImportsExactLegacyBindingWithBackupAndDurableResult()
    {
        var old = "{\"id\":\"old-main\",\"label\":\"Old main\",\"cliVersion\":\"0.170.0\",\"coreArtifactPrefix\":\"hosty-core\",\"shellManifestPath\":\"apps/client/manifest.json\",\"releaseTag\":\"bridge-tag\"}";
        File.WriteAllText(OldPath, old);
        var result = await PlatformLegacyMigration.TryImportAsync(new(client), root, cli, distribution, false, default);
        Assert.Equal("fast-lane", result!.Source.FeedId);
        Assert.Equal(old, File.ReadAllText(OldPath + ".pre-feeds"));
        Assert.False(File.Exists(OldPath));
        var journal = CoreLaunchFiles.Read(Path.Combine(root, "core", "update-source-migration.json"), PlatformMigrationJson.Default.PlatformSourceMigrationResult);
        Assert.Equal("completed", journal!.Status);
        var repeated = await PlatformLegacyMigration.TryImportAsync(new(client), root, cli, distribution, false, default);
        Assert.Equal(result.Source, repeated!.Source);
        Assert.Equal("reader-cli", File.ReadAllText(cli));
    }

    [Fact]
    public async Task UnknownBinaryWithoutConfigurationNeverAcquiresDistributionDefaults()
    {
        File.WriteAllText(cli, "third-party-build");
        Assert.Null(await PlatformLegacyMigration.TryImportAsync(new(client), root, cli, distribution, false, default));
        Assert.False(File.Exists(PlatformFeedFiles.SourcePath(root)));
    }

    [Fact]
    public async Task CustomLegacyBindingIsPreservedEvenWhenItsNameMatches()
    {
        const string old = "{\"id\":\"old-main\",\"releaseTag\":\"custom-tag\"}";
        File.WriteAllText(OldPath, old);
        documents.Clear();
        Assert.Null(await PlatformLegacyMigration.TryImportAsync(new(client), root, cli, distribution, false, default));
        Assert.Equal(old, File.ReadAllText(OldPath));
        Assert.False(File.Exists(PlatformFeedFiles.SourcePath(root)));
    }

    [Fact]
    public async Task UnavailableDestinationDoesNotAlterLegacyFiles()
    {
        documents.Remove(distribution.IndexRef);
        await Assert.ThrowsAsync<PlatformReleaseException>(() => PlatformLegacyMigration.TryImportAsync(new(client), root, cli, distribution, false, default));
        Assert.False(File.Exists(PlatformFeedFiles.SourcePath(root)));
        Assert.False(File.Exists(Path.Combine(root, "core", "update-source-migration.json")));
    }

    [Fact]
    public async Task LegacyIndexRequiresExplicitSelectionAndSnapshotsBothChecksums()
    {
        const string index = "https://publisher.test/legacy.json";
        documents[index] = Encoding.UTF8.GetBytes("{\"channels\":[{\"id\":\"custom\",\"cliVersion\":\"0.172.0\",\"repository\":\"third/party\",\"releaseTag\":\"retained\"}]}");
        var suffix = OperatingSystem.IsMacOS() ? "darwin-" + PlatformFeedSource.CurrentRid[4..] : OperatingSystem.IsWindows() ? "windows-" + PlatformFeedSource.CurrentRid[4..] + ".exe" : PlatformFeedSource.CurrentRid;
        var baseUrl = "https://github.com/third/party/releases/download/retained/";
        var cliFile = "hosty-" + suffix; var coreFile = "hosty-core-" + suffix;
        documents[baseUrl + cliFile] = Encoding.UTF8.GetBytes("cli"); documents[baseUrl + coreFile] = Encoding.UTF8.GetBytes("core");
        documents[baseUrl + "SHA256SUMS"] = Encoding.UTF8.GetBytes(PlatformReleaseReader.Hash(documents[baseUrl + cliFile]) + "  " + cliFile + "\n" + PlatformReleaseReader.Hash(documents[baseUrl + coreFile]) + "  " + coreFile + "\n");
        var reader = new PlatformReleaseReader(client);
        await Assert.ThrowsAsync<PlatformReleaseException>(() => reader.ResolveAsync(index, "custom"));
        var selected = await reader.ResolveAsync(index, "custom", allowLegacy: true);
        Assert.True(selected.Source.LegacyIndex);
        Assert.Equal("hosty-platform-legacy-release.0.1", selected.Release.SchemaVersion);
        Assert.Equal("", selected.Release.SourceCommit);
        Assert.Equal(2, selected.Release.Assets.Count);
        documents[baseUrl + coreFile] = Encoding.UTF8.GetBytes("changed-core");
        await Assert.ThrowsAsync<PlatformReleaseException>(() => reader.StageAssetAsync(PlatformReleaseReader.Asset(selected.Release, "core", PlatformFeedSource.CurrentRid), Path.Combine(root, "staged-core"), false, default));
        documents[baseUrl + "SHA256SUMS"] = Encoding.UTF8.GetBytes(PlatformReleaseReader.Hash(documents[baseUrl + cliFile]) + "  " + cliFile + "\n");
        Assert.Equal("platform_legacy_pair_missing", (await Assert.ThrowsAsync<PlatformReleaseException>(() => reader.ResolveAsync(index, "custom", allowLegacy: true))).Code);
    }

    [Fact]
    public void SourceMigrationCompletesItsReceiptAfterAnInterruptedConfigurationWrite()
    {
        var source = new PlatformUpdateSource("hosty-platform-update-source.0.1", distribution.IndexRef, "fast-lane", "before");
        var path = Path.Combine(root, "core", "update-source-migration.json");
        CoreLaunchFiles.Write(path, new PlatformSourceMigrationResult("hosty-platform-source-migration.0.1", "prepared", release.ReleaseId, null, source, DateTimeOffset.UtcNow), PlatformMigrationJson.Default.PlatformSourceMigrationResult);
        var saved = PlatformFeedFiles.SaveSource(root, source, null);
        PlatformLegacyMigration.ReconcileSaved(root, saved, false);
        var recovered = CoreLaunchFiles.Read(path, PlatformMigrationJson.Default.PlatformSourceMigrationResult)!;
        Assert.Equal("completed", recovered.Status); Assert.Equal(saved, recovered.Selected);
    }

    [Fact]
    public void ExplicitFeedSelectionArchivesCustomLegacyBytesWithoutReinterpretingThem()
    {
        const string old = "{\"id\":\"custom\",\"repository\":\"other/fork\"}";
        File.WriteAllText(OldPath, old);
        var source = new PlatformUpdateSource("hosty-platform-update-source.0.1", distribution.IndexRef, "chosen", "before");
        PlatformFeedFiles.SaveSource(root, source, null);
        Assert.False(File.Exists(OldPath));
        Assert.Equal(old, File.ReadAllText(Assert.Single(Directory.GetFiles(Path.Combine(root, "core"), "product-channel.json.pre-feeds-*"))));
        Assert.Equal("chosen", PlatformFeedFiles.ReadSource(root)!.FeedId);
    }

    public void Dispose() { client.Dispose(); Directory.Delete(root, true); }
    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> response) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => Task.FromResult(response(request));
    }
}
