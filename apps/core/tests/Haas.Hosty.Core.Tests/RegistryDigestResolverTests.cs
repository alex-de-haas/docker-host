using System.Net;
using System.Text;
using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

// The fast path for the reviewed-update plan's registry digest lookups: a direct registry HTTP probe
// fronting `docker buildx imagetools inspect`. Its contract is the same as the CLI probe it replaces —
// a digest, or null meaning "fall back", never an exception.
//
// Verified once against live registries during development: for every first-party image plus
// Docker Hub official/namespaced references, this resolver returned exactly the digest
// `docker buildx imagetools inspect` reported, at roughly a quarter of the time. That check is not
// committed — the suite must not depend on the network.
public sealed class RegistryDigestResolverTests
{
    private const string Digest = "sha256:592bee759fd7801be90af123fb7bb4adf47724e21e5f386ffdfebec495001f52";

    [Theory]
    // Docker Hub is implicit, and a single-component name is an official `library/` image.
    [InlineData("alpine", "registry-1.docker.io", "library/alpine")]
    [InlineData("alex/app", "registry-1.docker.io", "alex/app")]
    // The canonical Docker Hub names are not the host that serves the registry API.
    [InlineData("docker.io/library/busybox", "registry-1.docker.io", "library/busybox")]
    [InlineData("index.docker.io/alex/app", "registry-1.docker.io", "alex/app")]
    // A first path component that looks like a host (dot, port, or literal localhost) is one.
    [InlineData("ghcr.io/alex-de-haas/hosty-shell", "ghcr.io", "alex-de-haas/hosty-shell")]
    [InlineData("localhost/app", "localhost", "app")]
    [InlineData("localhost:5000/team/app", "localhost:5000", "team/app")]
    [InlineData("registry.example.com:5000/a/b/c", "registry.example.com:5000", "a/b/c")]
    public void TryParseReference_AppliesDockerHubDefaultsAndHostDetection(string repository, string expectedRegistry, string expectedPath)
    {
        Assert.True(RegistryDigestResolver.TryParseReference(repository, out var registry, out var path));
        Assert.Equal(expectedRegistry, registry);
        Assert.Equal(expectedPath, path);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    [InlineData("/leading")]
    [InlineData("trailing/")]
    [InlineData("has space/app")]
    // The path is interpolated into a URL, so anything that could restructure it is refused outright
    // rather than escaped — a traversal must never reach another repository's manifest.
    [InlineData("ghcr.io/../../etc/passwd")]
    [InlineData("ghcr.io/owner/../secret")]
    [InlineData("ghcr.io/owner//app")]
    [InlineData("ghcr.io/owner/app?x=1")]
    [InlineData("ghcr.io/owner/app#frag")]
    [InlineData("ghcr.io/owner@host/app")]
    public void TryParseReference_RejectsReferencesItCannotSafelyTurnIntoAUrl(string? repository)
        => Assert.False(RegistryDigestResolver.TryParseReference(repository, out _, out _));

    [Fact]
    public void ParseChallengeParameters_ReadsQuotedAndUnquotedPairs()
    {
        var parsed = RegistryDigestResolver.ParseChallengeParameters(
            "realm=\"https://auth.docker.io/token\",service=\"registry.docker.io\",scope=\"repository:library/alpine:pull\",error=invalid_token");

        Assert.Equal("https://auth.docker.io/token", parsed["realm"]);
        Assert.Equal("registry.docker.io", parsed["service"]);
        Assert.Equal("invalid_token", parsed["error"]);
    }

    [Fact]
    public async Task TryResolveDigestAsync_ReadsTheDigestHeaderFromAnUnauthenticatedRegistry()
    {
        var handler = new StubHandler(request => request.Method == HttpMethod.Head
            ? WithDigest(HttpStatusCode.OK, Digest)
            : new HttpResponseMessage(HttpStatusCode.NotFound));

        Assert.Equal(Digest, await Resolve(handler, "localhost:5000/team/app", "latest"));

        // A HEAD is the whole probe when the registry answers with the header: no body transferred.
        var probe = Assert.Single(handler.Requests);
        Assert.Equal(HttpMethod.Head, probe.Method);
        Assert.Equal("https://localhost:5000/v2/team/app/manifests/latest", probe.Url);
        Assert.Contains("application/vnd.oci.image.index.v1+json", probe.Accept);
    }

    [Fact]
    public async Task TryResolveDigestAsync_AnswersTheBearerChallengeAndRetries()
    {
        var handler = new StubHandler(request =>
        {
            if (request.Url.StartsWith("https://auth.example.test/token", StringComparison.Ordinal))
            {
                return Json("""{"token":"issued-token","expires_in":300}""");
            }

            return request.Authorization == "Bearer issued-token"
                ? WithDigest(HttpStatusCode.OK, Digest)
                : Challenge();
        });

        Assert.Equal(Digest, await Resolve(handler, "ghcr.io/alex-de-haas/hosty-shell", "latest"));

        // Unauthenticated probe, token fetch, authorized probe.
        Assert.Equal(3, handler.Requests.Count);
        var tokenRequest = handler.Requests[1];
        Assert.Contains("scope=repository%3Aalex-de-haas%2Fhosty-shell%3Apull", tokenRequest.Url);
        Assert.Contains("service=registry.example.test", tokenRequest.Url);
    }

    [Fact]
    public async Task TryResolveDigestAsync_ReusesACachedTokenAcrossProbes()
    {
        var handler = new StubHandler(request =>
        {
            if (request.Url.StartsWith("https://auth.example.test/token", StringComparison.Ordinal))
            {
                return Json("""{"token":"issued-token","expires_in":300}""");
            }

            return request.Authorization == "Bearer issued-token"
                ? WithDigest(HttpStatusCode.OK, Digest)
                : Challenge();
        });

        var resolver = CreateResolver(handler);
        var image = new RuntimeDockerImage("ghcr.io/alex-de-haas/hosty-shell", "latest");
        Assert.Equal(Digest, await resolver.TryResolveDigestAsync(image));
        Assert.Equal(Digest, await resolver.TryResolveDigestAsync(image));

        // A fleet check resolves many images against the same registry; re-challenging every time
        // would double the round-trips and hit the token endpoint's own rate limit.
        Assert.Equal(4, handler.Requests.Count);
        Assert.Single(handler.Requests, request => request.Url.StartsWith("https://auth.example.test/token", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TryResolveDigestAsync_ReChallengesOnceWhenACachedTokenStoppedWorking()
    {
        var tokens = 0;
        var handler = new StubHandler(request =>
        {
            if (request.Url.StartsWith("https://auth.example.test/token", StringComparison.Ordinal))
            {
                return Json($$"""{"token":"token-{{++tokens}}","expires_in":300}""");
            }

            // Only the newest token is accepted, standing in for one revoked or expired early.
            return request.Authorization == $"Bearer token-{tokens}"
                ? WithDigest(HttpStatusCode.OK, Digest)
                : Challenge();
        });

        var resolver = CreateResolver(handler);
        var image = new RuntimeDockerImage("ghcr.io/alex-de-haas/hosty-shell", "latest");
        Assert.Equal(Digest, await resolver.TryResolveDigestAsync(image));

        tokens++; // The cached token is now stale.
        Assert.Equal(Digest, await resolver.TryResolveDigestAsync(image));
    }

    [Fact]
    public async Task TryResolveDigestAsync_HashesTheManifestWhenTheRegistryOmitsTheDigestHeader()
    {
        var manifest = """{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json"}""";
        var handler = new StubHandler(request => request.Method == HttpMethod.Head
            ? new HttpResponseMessage(HttpStatusCode.OK)
            : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(manifest, Encoding.UTF8) });

        var expected = "sha256:" + Convert.ToHexStringLower(
            System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(manifest)));

        // The digest is by definition the hash of the manifest bytes as served, so this yields the
        // same value the header would have carried.
        Assert.Equal(expected, await Resolve(handler, "localhost:5000/team/app", "latest"));
        Assert.Equal([HttpMethod.Head, HttpMethod.Get], handler.Requests.Select(request => request.Method));
    }

    [Theory]
    // A private registry wanting real credentials — the docker CLI can reach it via `docker login`,
    // this resolver cannot, so it must decline rather than report the image unresolvable.
    [InlineData(HttpStatusCode.Unauthorized)]
    [InlineData(HttpStatusCode.Forbidden)]
    [InlineData(HttpStatusCode.NotFound)]
    [InlineData(HttpStatusCode.TooManyRequests)]
    [InlineData(HttpStatusCode.InternalServerError)]
    // Redirects are not followed: a manifest probe must not be bounced to an unvetted host.
    [InlineData(HttpStatusCode.Redirect)]
    public async Task TryResolveDigestAsync_FallsBackWhenTheRegistryDoesNotAnswerCleanly(HttpStatusCode status)
        => Assert.Null(await Resolve(new StubHandler(_ => new HttpResponseMessage(status)), "ghcr.io/owner/app", "latest"));

    [Fact]
    public async Task TryResolveDigestAsync_FallsBackWhenTheTransportFails()
    {
        // "Null, never an exception" is the contract the adapter leans on with no try/catch of its own.
        var handler = new StubHandler(_ => throw new HttpRequestException("connection refused"));
        Assert.Null(await Resolve(handler, "ghcr.io/owner/app", "latest"));
    }

    [Fact]
    public async Task TryResolveDigestAsync_RejectsAMalformedDigestRatherThanLockingIt()
    {
        // A bad value must not reach an artifact lock; falling back re-asks through the CLI.
        var handler = new StubHandler(_ => WithDigest(HttpStatusCode.OK, "sha256:not-a-digest"));
        Assert.Null(await Resolve(handler, "ghcr.io/owner/app", "latest"));
    }

    [Fact]
    public async Task TryResolveDigestAsync_DoesNotFollowAChallengeToAnInsecureRealm()
    {
        // An http realm would put the request — and any token — on the wire in clear.
        var handler = new StubHandler(request => request.Url.StartsWith("http://", StringComparison.Ordinal)
            ? Json("""{"token":"issued-token"}""")
            : Challenge(realm: "http://auth.example.test/token"));

        Assert.Null(await Resolve(handler, "ghcr.io/owner/app", "latest"));
        Assert.DoesNotContain(handler.Requests, request => request.Url.StartsWith("http://", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TryResolveDigestAsync_CancellationPropagates()
    {
        using var cancelled = new CancellationTokenSource();
        await cancelled.CancelAsync();
        var handler = new StubHandler(_ => WithDigest(HttpStatusCode.OK, Digest));

        // An aborted check is not an unresolvable digest — the probe deadline in DockerRuntimeAdapter
        // depends on this surfacing rather than being swallowed as a fallback.
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => CreateResolver(handler).TryResolveDigestAsync(new RuntimeDockerImage("ghcr.io/owner/app", "latest"), cancelled.Token));
    }

    private static Task<string?> Resolve(StubHandler handler, string repository, string tag)
        => CreateResolver(handler).TryResolveDigestAsync(new RuntimeDockerImage(repository, tag));

    private static RegistryDigestResolver CreateResolver(StubHandler handler)
        => new(new StubHttpClientFactory(handler), NullLogger<RegistryDigestResolver>.Instance);

    private static HttpResponseMessage WithDigest(HttpStatusCode status, string digest)
    {
        var response = new HttpResponseMessage(status);
        response.Headers.TryAddWithoutValidation("Docker-Content-Digest", digest);
        return response;
    }

    private static HttpResponseMessage Challenge(string realm = "https://auth.example.test/token")
    {
        var response = new HttpResponseMessage(HttpStatusCode.Unauthorized);
        response.Headers.TryAddWithoutValidation(
            "WWW-Authenticate",
            $"Bearer realm=\"{realm}\",service=\"registry.example.test\"");
        return response;
    }

    private static HttpResponseMessage Json(string body)
        => new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private sealed record CapturedRequest(HttpMethod Method, string Url, string? Authorization, string Accept);

    private sealed class StubHandler(Func<CapturedRequest, HttpResponseMessage> responder) : HttpMessageHandler
    {
        public List<CapturedRequest> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var captured = new CapturedRequest(
                request.Method,
                request.RequestUri!.ToString(),
                request.Headers.Authorization?.ToString(),
                string.Join(", ", request.Headers.Accept.Select(value => value.ToString())));
            Requests.Add(captured);
            return Task.FromResult(responder(captured));
        }
    }

    private sealed class StubHttpClientFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }
}
