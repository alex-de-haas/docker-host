using System.Net;
using System.Text;

namespace Haas.Hosty.Core.Tests;

public sealed class AppFeedServiceTests
{
    private const string FeedsUrl = "https://apps.example.test/notes/feeds.json";

    [Fact]
    public async Task LoadAsync_ValidSoleFeed_NormalizesItAsDefault()
    {
        var service = CreateService("""
            {
              "schemaVersion": "app-feeds.0.1",
              "appId": "com.example.notes",
              "feeds": [
                { "id": "main", "manifestRef": "https://apps.example.test/notes/main/manifest.json" }
              ]
            }
            """);

        var snapshot = await service.LoadAsync(FeedsUrl);

        Assert.Equal("com.example.notes", snapshot.AppId);
        var feed = Assert.Single(snapshot.Feeds);
        Assert.Equal("main", feed.Id);
        Assert.True(feed.Default);
        Assert.NotEmpty(snapshot.DocumentDigest);
    }

    [Fact]
    public async Task ResolveAsync_MultipleFeedsWithoutDefault_RequiresExplicitSelection()
    {
        var service = CreateService(Document(
            """{ "id": "main", "manifestRef": "https://apps.example.test/notes/main/manifest.json" }""",
            """{ "id": "beta", "manifestRef": "https://apps.example.test/notes/beta/manifest.json" }"""));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => service.ResolveAsync(FeedsUrl, null));
        var selected = await service.ResolveAsync(FeedsUrl, "beta");

        Assert.Equal("app_feed_selection_required", error.Code);
        Assert.Equal("beta", selected.Feed.Id);
    }

    [Fact]
    public async Task LoadAsync_TreatsFeedIdsAsOpaqueNonEmptyIdentifiers()
    {
        var service = CreateService(Document(
            """{ "id": "2026.07-preview", "manifestRef": "https://apps.example.test/notes/preview/manifest.json" }"""));

        var feed = Assert.Single((await service.LoadAsync(FeedsUrl)).Feeds);

        Assert.Equal("2026.07-preview", feed.Id);
    }

    [Fact]
    public async Task LoadAsync_AllowsFeedIdAtMaximumLength()
    {
        var id = new string('x', AppFeedsSchema.MaxFeedIdLength);
        var service = CreateService(Document(
            $$"""{ "id": "{{id}}", "manifestRef": "https://apps.example.test/notes/preview/manifest.json" }"""));

        var feed = Assert.Single((await service.LoadAsync(FeedsUrl)).Feeds);

        Assert.Equal(id, feed.Id);
    }

    [Fact]
    public async Task LoadAsync_RejectsFeedIdOverMaximumLength()
    {
        var id = new string('x', AppFeedsSchema.MaxFeedIdLength + 1);
        var service = CreateService(Document(
            $$"""{ "id": "{{id}}", "manifestRef": "https://apps.example.test/notes/preview/manifest.json" }"""));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => service.LoadAsync(FeedsUrl));

        Assert.Equal("app_feed_id_too_long", error.Code);
    }

    [Fact]
    public async Task ResolveAsync_RejectsRequestedFeedIdOverMaximumLength()
    {
        var service = CreateService(Document(
            """{ "id": "main", "manifestRef": "https://apps.example.test/notes/main/manifest.json" }"""));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            service.ResolveAsync(FeedsUrl, new string('x', AppFeedsSchema.MaxFeedIdLength + 1)));

        Assert.Equal("app_feed_id_too_long", error.Code);
    }

    [Theory]
    [InlineData("""{ "schemaVersion": "app-feeds.9.9", "appId": "com.example.notes", "feeds": [] }""", "app_feeds_schema_unsupported")]
    [InlineData("""{ "schemaVersion": "app-feeds.0.1", "appId": "Bad Id", "feeds": [] }""", "app_feeds_app_id_invalid")]
    [InlineData("""{ "schemaVersion": "app-feeds.0.1", "appId": "com.example.notes", "feeds": [] }""", "app_feeds_empty")]
    [InlineData("""{ "schemaVersion": "app-feeds.0.1", "appId": "com.example.notes", "feeds": [{ "id": "   ", "manifestRef": "https://example.test/manifest.json" }] }""", "app_feed_id_invalid")]
    [InlineData("""{ "schemaVersion": "app-feeds.0.1", "appId": "com.example.notes", "feeds": [null] }""", "app_feed_id_invalid")]
    [InlineData("""{ "schemaVersion": "app-feeds.0.1", "appId": "com.example.notes", "feeds": [{ "id": "main", "manifestRef": "file:///tmp/manifest.json" }] }""", "app_feed_manifest_ref_invalid")]
    public async Task LoadAsync_InvalidDocument_RejectsWithStableCode(string document, string expectedCode)
    {
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => CreateService(document).LoadAsync(FeedsUrl));

        Assert.Equal(expectedCode, error.Code);
    }

    [Fact]
    public async Task LoadAsync_DuplicateIds_RejectsDocument()
    {
        var service = CreateService(Document(
            """{ "id": "main", "manifestRef": "https://example.test/main.json" }""",
            """{ "id": "main", "manifestRef": "https://example.test/other.json" }"""));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => service.LoadAsync(FeedsUrl));

        Assert.Equal("app_feed_id_duplicate", error.Code);
    }

    [Fact]
    public async Task LoadAsync_MultipleDefaults_RejectsDocument()
    {
        var service = CreateService(Document(
            """{ "id": "main", "manifestRef": "https://example.test/main.json", "default": true }""",
            """{ "id": "beta", "manifestRef": "https://example.test/beta.json", "default": true }"""));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => service.LoadAsync(FeedsUrl));

        Assert.Equal("app_feed_default_duplicate", error.Code);
    }

    [Fact]
    public async Task LoadAsync_ChunkedBodyOverLimit_RejectsWhileStreaming()
    {
        var bytes = Encoding.UTF8.GetBytes(new string('x', AppFeedService.MaxFeedBytes + 1));
        var service = CreateService(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StreamContent(new MemoryStream(bytes)),
        });

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => service.LoadAsync(FeedsUrl));

        Assert.Equal("app_feeds_too_large", error.Code);
    }

    private static string Document(params string[] feeds)
        => $$"""
            {
              "schemaVersion": "app-feeds.0.1",
              "appId": "com.example.notes",
              "feeds": [{{string.Join(',', feeds)}}]
            }
            """;

    private static AppFeedService CreateService(string document)
        => CreateService(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(document, Encoding.UTF8, "application/json"),
        });

    private static AppFeedService CreateService(Func<HttpRequestMessage, HttpResponseMessage> handler)
        => new(new HttpClient(new StubHttpMessageHandler(handler)));

    private sealed class StubHttpMessageHandler(Func<HttpRequestMessage, HttpResponseMessage> handler) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(handler(request));
    }
}
