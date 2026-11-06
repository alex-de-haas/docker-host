using System.Net;
using System.Text;
using System.Text.Json;
using Haas.Hosty.Cli.Commands;
using Haas.Hosty.Releases;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class PlatformReleaseTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "hosty-platform-feed-" + Guid.NewGuid().ToString("N"));
    private const string Hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    public PlatformReleaseTests() => Directory.CreateDirectory(root);
    public void Dispose() => Directory.Delete(root, recursive: true);

    [Theory]
    [InlineData(1)] [InlineData(3)] [InlineData(10)]
    public void FeedNamesAndCountsArePublisherDefined(int count)
    {
        var index = new PlatformFeedIndex("hosty-platform-feeds.0.1", Enumerable.Range(0, count)
            .Select(i => new PlatformFeed("publisher-lane-" + i, "https://example.org/release.json", Hash, i == count - 1)).ToArray());
        Assert.Equal("publisher-lane-" + (count - 1), PlatformReleaseReader.SelectFeed(index, null).Id);
        Assert.Equal("publisher-lane-0", PlatformReleaseReader.SelectFeed(index, "publisher-lane-0").Id);
        Assert.Equal("platform_feed_not_found", Assert.Throws<PlatformReleaseException>(() => PlatformReleaseReader.SelectFeed(index, "daily")).Code);
    }

    [Fact]
    public void MultipleFeedsNeedExplicitDefaultAndIdsAreCaseSensitive()
    {
        var first = new PlatformFeed("A", "https://example.org/release.json", Hash);
        var second = first with { Id = "a" };
        var index = new PlatformFeedIndex("hosty-platform-feeds.0.1", [first, second]);
        Assert.Equal("platform_feed_selection_required", Assert.Throws<PlatformReleaseException>(() => PlatformReleaseReader.SelectFeed(index, null)).Code);
        Assert.Equal(second, PlatformReleaseReader.SelectFeed(index, "a"));
        Assert.Throws<PlatformReleaseException>(() => PlatformReleaseReader.ValidateIndex(index with { Feeds = [first, first] }));
        Assert.Throws<PlatformReleaseException>(() => PlatformReleaseReader.ValidateIndex(index with { Feeds = [first with { Default = true }, second with { Default = true }] }));
        Assert.Equal(first, PlatformReleaseReader.SelectFeed(index with { Feeds = [first] }, null));
    }

    [Fact]
    public async Task DescriptorHashIsCheckedBeforeReturningAnyRelease()
    {
        var descriptor = Path.Combine(root, "release.json");
        await File.WriteAllTextAsync(descriptor, "{}");
        var index = Path.Combine(root, "feeds.json");
        await File.WriteAllTextAsync(index, JsonSerializer.Serialize(new PlatformFeedIndex("hosty-platform-feeds.0.1",
            [new("custom", descriptor, Hash)]), PlatformReleaseJson.Default.PlatformFeedIndex));
        using var client = new HttpClient();
        var error = await Assert.ThrowsAsync<PlatformReleaseException>(() => new PlatformReleaseReader(client).ResolveAsync(index, null));
        Assert.Equal("platform_descriptor_hash_mismatch", error.Code);
    }

    [Fact]
    public void EveryDeclaredTargetNeedsBothRoles()
    {
        var asset = new PlatformReleaseAsset("cli", "linux-x64", "hosty", "https://example.org/hosty", 123, Hash, Hash, "https://example.org/provenance");
        var release = new PlatformRelease("hosty-platform-release.0.1", Hash, "1.0.0", new string('a', 40), [asset]);
        Assert.Equal("platform_release_incomplete", Assert.Throws<PlatformReleaseException>(() => PlatformReleaseReader.ValidateRelease(release)).Code);
        PlatformReleaseReader.ValidateRelease(release with { Assets = [asset, asset with { Role = "core", FileName = "hosty-core" }] });
    }

    [Fact]
    public async Task RemoteIndicesCannotReferenceLocalFiles()
    {
        using var client = new HttpClient(new Handler(_ => new(HttpStatusCode.OK)
        {
            Content = new StringContent(JsonSerializer.Serialize(new PlatformFeedIndex("hosty-platform-feeds.0.1",
                [new("lane", Path.Combine(root, "private.json"), Hash)]), PlatformReleaseJson.Default.PlatformFeedIndex))
        }));
        var error = await Assert.ThrowsAsync<PlatformReleaseException>(() => new PlatformReleaseReader(client).ReadIndexAsync("https://example.org/feeds.json"));
        Assert.Equal("platform_source_invalid", error.Code);
    }

    [Theory]
    [InlineData(403, "platform_source_access_denied")]
    [InlineData(404, "platform_source_not_found")]
    [InlineData(429, "platform_source_rate_limited")]
    public async Task SourceErrorsAreTypedWithoutFallback(int status, string code)
    {
        var calls = 0;
        using var client = new HttpClient(new Handler(_ => { calls++; return new((HttpStatusCode)status); }));
        var error = await Assert.ThrowsAsync<PlatformReleaseException>(() => new PlatformReleaseReader(client).ResolveAsync("https://example.org/feeds.json", "custom"));
        Assert.Equal(code, error.Code);
        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task DocumentReadsAreBounded()
    {
        using var client = new HttpClient(new Handler(_ => new(HttpStatusCode.OK) { Content = new StringContent(new string('x', PlatformReleaseReader.MaxDocumentBytes + 1)) }));
        Assert.Equal("platform_document_too_large", (await Assert.ThrowsAsync<PlatformReleaseException>(() => new PlatformReleaseReader(client).ReadIndexAsync("https://example.org/feeds.json"))).Code);
    }

    [Fact]
    public async Task FailedDownloadDoesNotReplaceAnExistingStagedFile()
    {
        var source = Path.Combine(root, "asset");
        var target = Path.Combine(root, "staged");
        await File.WriteAllTextAsync(source, "bad");
        await File.WriteAllTextAsync(target, "previous staging");
        using var client = new HttpClient();
        var asset = new PlatformReleaseAsset("core", "linux-x64", "core", source, 3, Hash, Hash, "build");
        await Assert.ThrowsAsync<PlatformReleaseException>(() => new PlatformReleaseReader(client).StageAssetAsync(asset, target, true, default));
        Assert.Equal("previous staging", await File.ReadAllTextAsync(target));
        Assert.Empty(Directory.GetFiles(root, "*.download"));
    }

    [Fact]
    public void AliasConflictsAndMissingValuesAreUsageErrors()
    {
        Assert.Equal("custom", UpdateCommand.ParseOptions(["--channel", "custom"]).FeedId);
        Assert.True(UpdateCommand.ParseOptions(["--list-channels"]).ListFeeds);
        Assert.Throws<CommandUsageException>(() => UpdateCommand.ParseOptions(["--feed", "a", "--channel", "b"]));
        Assert.Throws<CommandUsageException>(() => UpdateCommand.ParseOptions(["--feed", "--index", "file"]));
    }

    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> reply) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => Task.FromResult(reply(request));
    }
}
