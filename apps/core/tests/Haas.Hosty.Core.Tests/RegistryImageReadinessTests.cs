using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed class RegistryImageReadinessTests
{
    [Fact]
    public async Task ReadyRequiresMatchingIndexManifestConfigurationAndLayerPresence()
    {
        using var registry = new Registry();
        var result = await registry.Check();
        Assert.True(result.Ready); Assert.Equal(registry.RootDigest, result.Digest);
        Assert.Contains(registry.Calls, call => call.Contains("/blobs/", StringComparison.Ordinal));
        Assert.Equal("linux/arm64", result.Platform);
    }

    [Fact]
    public async Task AnAdvertisedDigestDoesNotMakeCorruptBytesReady()
    {
        using var registry = new Registry();
        registry.Documents["/v2/app/manifests/" + registry.RootDigest] = Encoding.UTF8.GetBytes("{}");
        var result = await registry.Check();
        Assert.False(result.Ready); Assert.Equal("image_digest_mismatch", result.ErrorCode);
    }

    [Fact]
    public async Task MissingHostPlatformIsNotAnAvailableUpdate()
    {
        using var registry = new Registry();
        var result = await registry.Check("linux/amd64");
        Assert.False(result.Ready); Assert.Equal("image_platform_unavailable", result.ErrorCode);
    }

    [Fact]
    public async Task ADeletedLayerMakesAnOtherwiseValidManifestUnavailable()
    {
        using var registry = new Registry { MissingLayer = true };
        var result = await registry.Check();
        Assert.False(result.Ready); Assert.Equal("image_missing", result.ErrorCode);
    }

    [Fact]
    public async Task ChildManifestBytesMustMatchTheIndexDescriptor()
    {
        using var registry = new Registry();
        registry.Documents["/v2/app/manifests/" + registry.ChildDigest] = Encoding.UTF8.GetBytes("{}");
        var result = await registry.Check();
        Assert.False(result.Ready); Assert.Equal("image_manifest_invalid", result.ErrorCode);
    }

    [Theory]
    [InlineData(403, "registry_access_denied")]
    [InlineData(429, "registry_rate_limited")]
    [InlineData(404, "image_missing")]
    public async Task RegistryFailuresAreDistinctFromInvalidContent(int status, string code)
    {
        using var registry = new Registry { Status = (HttpStatusCode)status };
        var result = await registry.Check();
        Assert.False(result.Ready); Assert.Equal(code, result.ErrorCode);
    }

    [Fact]
    public async Task ExpiredCachedAnonymousTokenIsRefreshedWithoutAcceptingAnUnverifiedImage()
    {
        using var registry = new Registry { RequireToken = true };
        Assert.True((await registry.Check()).Ready);
        registry.TokenVersion++;
        Assert.True((await registry.Check()).Ready);
        Assert.Equal(2, registry.TokenRequests);
    }

    [Theory]
    [InlineData("{\"schemaVersion\":\"2\"}")]
    [InlineData("{\"schemaVersion\":2,\"config\":{\"digest\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"size\":\"10\"},\"layers\":[]}")]
    public async Task MalformedNumericFieldsAreInvalidContent(string json)
    {
        using var registry = new Registry();
        registry.SetRoot(Encoding.UTF8.GetBytes(json));
        Assert.Equal("image_manifest_invalid", (await registry.Check()).ErrorCode);
    }

    private sealed class Registry : HttpMessageHandler, IHttpClientFactory
    {
        public Dictionary<string, byte[]> Documents { get; } = new(StringComparer.Ordinal);
        public List<string> Calls { get; } = [];
        public string RootDigest { get; private set; }
        public string ChildDigest { get; }
        public HttpStatusCode Status = HttpStatusCode.OK;
        public bool MissingLayer;
        public bool RequireToken;
        public int TokenVersion = 1;
        public int TokenRequests;
        private RegistryDigestResolver? resolver;
        public void SetRoot(byte[] bytes) { RootDigest = Digest(bytes); Documents["/v2/app/manifests/" + RootDigest] = bytes; }
        private readonly string layerDigest = "sha256:" + new string('a', 64);

        public Registry()
        {
            var configuration = JsonSerializer.SerializeToUtf8Bytes(new { os = "linux", architecture = "arm64" });
            var configurationDigest = Digest(configuration);
            Documents["/v2/app/blobs/" + configurationDigest] = configuration;
            var child = JsonSerializer.SerializeToUtf8Bytes(new
            {
                schemaVersion = 2, mediaType = "application/vnd.oci.image.manifest.v1+json",
                config = new { digest = configurationDigest, size = configuration.Length, mediaType = "application/vnd.oci.image.config.v1+json" },
                layers = new[] { new { digest = layerDigest, size = 17, mediaType = "application/vnd.oci.image.layer.v1.tar+gzip" } },
            });
            ChildDigest = Digest(child); Documents["/v2/app/manifests/" + ChildDigest] = child;
            var index = JsonSerializer.SerializeToUtf8Bytes(new
            {
                schemaVersion = 2, mediaType = "application/vnd.oci.image.index.v1+json",
                manifests = new[] { new { digest = ChildDigest, size = child.Length, mediaType = "application/vnd.oci.image.manifest.v1+json", platform = new { os = "linux", architecture = "arm64" } } },
            });
            RootDigest = Digest(index); Documents["/v2/app/manifests/" + RootDigest] = index;
        }
        public Task<ImageReadiness> Check(string platform = "linux/arm64")
            => (resolver ??= new RegistryDigestResolver(this, NullLogger<RegistryDigestResolver>.Instance))
                .CheckAsync(new RuntimeDockerImage("registry.test/app", "", RootDigest), platform, default);
        public HttpClient CreateClient(string name) => new(this, disposeHandler: false);
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var path = Uri.UnescapeDataString(request.RequestUri!.AbsolutePath);
            Calls.Add(request.Method + " " + path);
            if (path == "/token")
            {
                TokenRequests++;
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"token\":\"token-" + TokenVersion + "\",\"expires_in\":3600}") });
            }
            if (RequireToken && request.Headers.Authorization?.Parameter != "token-" + TokenVersion)
            {
                var denied = new HttpResponseMessage(HttpStatusCode.Unauthorized);
                denied.Headers.TryAddWithoutValidation("WWW-Authenticate", "Bearer realm=\"https://registry.test/token\",service=\"registry.test\",scope=\"repository:app:pull\"");
                return Task.FromResult(denied);
            }
            if (Status != HttpStatusCode.OK) return Task.FromResult(new HttpResponseMessage(Status));
            if (path.EndsWith(layerDigest, StringComparison.Ordinal))
            {
                if (MissingLayer) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(new byte[17]) });
            }
            return Task.FromResult(Documents.TryGetValue(path, out var body)
                ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(request.Method == HttpMethod.Head ? [] : body) }
                : new HttpResponseMessage(HttpStatusCode.NotFound));
        }
        private static string Digest(byte[] bytes) => "sha256:" + Convert.ToHexStringLower(SHA256.HashData(bytes));
    }
}
