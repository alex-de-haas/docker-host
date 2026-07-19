using System.Net;
using System.Text;
using System.Text.Json;
using HostySdk.App;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace HostySdk.App.Tests;

public sealed class HostyAppOptionsTests
{
    private static IConfiguration Config(params (string Key, string Value)[] pairs)
        => new ConfigurationBuilder().AddInMemoryCollection(pairs.ToDictionary(p => p.Key, p => (string?)p.Value)).Build();

    [Fact]
    public void FallsBackToAppIdAndLocalCoreForStandaloneRuns()
    {
        var options = HostyAppOptions.FromConfiguration(Config(), "com.example.app");
        Assert.Equal("com.example.app", options.AppId);
        Assert.Equal("http://localhost:7070", options.CoreOrigin);
        Assert.False(options.IsCoreManaged);
    }

    [Fact]
    public void ReadsTheInjectedEnvironmentAndReportsCoreManaged()
    {
        var options = HostyAppOptions.FromConfiguration(
            Config(
                ("HOSTY_APP_ID", "com.real.app"),
                ("HOSTY_APP_SERVICE_TOKEN", "hosty_app_service.1.a.b"),
                ("HOSTY_CORE_ORIGIN", "http://host.docker.internal:7070"),
                ("HOSTY_CORE_PUBLIC_ORIGIN", "http://127.0.0.1:7070")),
            "com.example.app");
        Assert.Equal("com.real.app", options.AppId);
        Assert.True(options.IsCoreManaged);
        Assert.Equal("http://127.0.0.1:7070", options.CorePublicOrigin);
    }
}

public sealed class CachingIdentityValidatorTests
{
    private sealed class StubValidator(Func<HostySession?> result) : IHostyIdentityValidator
    {
        public int Calls { get; private set; }

        public Task<HostySession?> ValidateAsync(string accessToken, CancellationToken cancellationToken)
        {
            Calls++;
            return Task.FromResult(result());
        }
    }

    private static HostySession Session(TimeSpan expiresIn)
        => new("com.example.app", "user_1", null, null, "host.admin", DateTimeOffset.UtcNow.Add(expiresIn));

    [Fact]
    public async Task CachesPositiveResultsWithinTheWindow()
    {
        var inner = new StubValidator(() => Session(TimeSpan.FromHours(1)));
        var validator = new CachingIdentityValidator(inner, new MemoryCache(new MemoryCacheOptions()), TimeSpan.FromSeconds(30));

        Assert.NotNull(await validator.ValidateAsync("hostyg_x", CancellationToken.None));
        Assert.NotNull(await validator.ValidateAsync("hostyg_x", CancellationToken.None));
        Assert.Equal(1, inner.Calls);
    }

    [Fact]
    public async Task NeverCachesNegativeResults()
    {
        var inner = new StubValidator(() => null);
        var validator = new CachingIdentityValidator(inner, new MemoryCache(new MemoryCacheOptions()), TimeSpan.FromSeconds(30));

        Assert.Null(await validator.ValidateAsync("hostyg_x", CancellationToken.None));
        Assert.Null(await validator.ValidateAsync("hostyg_x", CancellationToken.None));
        Assert.Equal(2, inner.Calls);
    }

    [Fact]
    public async Task NeverCachesBeyondTheTokenExpiry()
    {
        var inner = new StubValidator(() => Session(TimeSpan.FromMilliseconds(-1)));
        var validator = new CachingIdentityValidator(inner, new MemoryCache(new MemoryCacheOptions()), TimeSpan.FromSeconds(30));

        Assert.NotNull(await validator.ValidateAsync("hostyg_x", CancellationToken.None));
        Assert.NotNull(await validator.ValidateAsync("hostyg_x", CancellationToken.None));
        Assert.Equal(2, inner.Calls);
    }
}

public sealed class CoreIdentityValidatorTests
{
    private sealed class StubHandler(HttpStatusCode status, object? body) : HttpMessageHandler
    {
        public string? SeenAuthorization { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            SeenAuthorization = request.Headers.Authorization?.ToString();
            var response = new HttpResponseMessage(status);
            if (body is not null)
            {
                response.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
            }
            return Task.FromResult(response);
        }
    }

    private sealed class StubFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler) { BaseAddress = new Uri("http://core.test") };
    }

    private static HostyAppOptions Options(string? serviceToken = "hosty_app_service.1.a.b")
        => new() { AppId = "com.example.app", CoreOrigin = "http://core.test", ServiceToken = serviceToken };

    private static CoreIdentityValidator Validator(StubHandler handler, HostyAppOptions options)
        => new(new StubFactory(handler), options, NullLogger<CoreIdentityValidator>.Instance);

    [Fact]
    public async Task ReturnsNullWithoutAServiceToken()
    {
        var handler = new StubHandler(HttpStatusCode.OK, null);
        Assert.Null(await Validator(handler, Options(serviceToken: null)).ValidateAsync("hostyg_x", CancellationToken.None));
        Assert.Null(handler.SeenAuthorization);
    }

    [Fact]
    public async Task SendsTheServiceTokenAndMapsAnActiveGrant()
    {
        var handler = new StubHandler(HttpStatusCode.OK, new
        {
            active = true,
            appId = "com.example.app",
            userId = "user_1",
            email = "user@example.com",
            displayName = "User",
            hostRole = "host.admin",
            expiresAt = DateTimeOffset.UtcNow.AddHours(1),
        });

        var session = await Validator(handler, Options()).ValidateAsync("hostyg_x", CancellationToken.None);

        Assert.NotNull(session);
        Assert.Equal("user_1", session!.UserId);
        Assert.Equal("host.admin", session.HostRole);
        Assert.Equal("Bearer hosty_app_service.1.a.b", handler.SeenAuthorization);
    }

    [Fact]
    public async Task FailsClosedOnAudienceMismatchAndCoreErrors()
    {
        var mismatch = new StubHandler(HttpStatusCode.OK, new
        {
            active = true,
            appId = "other.app",
            userId = "user_1",
            expiresAt = DateTimeOffset.UtcNow.AddHours(1),
        });
        Assert.Null(await Validator(mismatch, Options()).ValidateAsync("hostyg_x", CancellationToken.None));

        var unauthorized = new StubHandler(HttpStatusCode.Unauthorized, new { code = "token_expired" });
        Assert.Null(await Validator(unauthorized, Options()).ValidateAsync("hostyg_x", CancellationToken.None));
    }
}
