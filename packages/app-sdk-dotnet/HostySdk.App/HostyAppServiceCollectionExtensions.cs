using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.DependencyInjection;

namespace HostySdk.App;

public static class HostyAppServiceCollectionExtensions
{
    /// <summary>
    /// Wires the Hosty app auth stack: the Core-backed identity validator behind the
    /// platform-decided 30s positive cache, an <c>IHttpClientFactory</c> client aimed at
    /// Core, and the <c>Hosty</c> authentication scheme. Per the trust model (decision 1 in
    /// docs/ideas/hosty-app-sdk.md) this exists for services with their own public
    /// endpoints; private intra-app endpoints keep trusting the per-app network.
    /// </summary>
    public static AuthenticationBuilder AddHostyAppAuthentication(
        this IServiceCollection services,
        HostyAppOptions options,
        Action<HostyAuthenticationOptions>? configure = null)
    {
        services.AddSingleton(options);
        services.AddMemoryCache();
        services.AddHttpClient(CoreIdentityValidator.HttpClientName, client =>
        {
            client.BaseAddress = new Uri(options.CoreOrigin);
            client.Timeout = TimeSpan.FromSeconds(5);
        });

        services.AddSingleton<CoreIdentityValidator>();
        services.AddSingleton<IHostyIdentityValidator>(provider => new CachingIdentityValidator(
            provider.GetRequiredService<CoreIdentityValidator>(),
            provider.GetRequiredService<Microsoft.Extensions.Caching.Memory.IMemoryCache>(),
            CachingIdentityValidator.DefaultTimeToLive));

        return services
            .AddAuthentication(HostyAuthenticationHandler.SchemeName)
            .AddScheme<HostyAuthenticationOptions, HostyAuthenticationHandler>(
                HostyAuthenticationHandler.SchemeName,
                configure ?? (_ => { }));
    }
}
