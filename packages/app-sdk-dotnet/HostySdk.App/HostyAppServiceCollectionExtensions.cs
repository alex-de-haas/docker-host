using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace HostySdk.App;

public static class HostyAppServiceCollectionExtensions
{
    /// <summary>
    /// Registers <see cref="HostySecretsClient"/> for the app's Core-managed secrets store.
    /// Independent of the auth stack — a headless service may need secrets without owning a
    /// public endpoint — and safe to combine with
    /// <see cref="AddHostyAppAuthentication"/> in either order, since both only add the shared
    /// Core client and options when they are missing.
    /// </summary>
    public static IServiceCollection AddHostySecrets(this IServiceCollection services, HostyAppOptions options)
    {
        services.TryAddSingleton(options);
        AddCoreHttpClient(services, options);
        services.TryAddSingleton<HostySecretsClient>();
        return services;
    }

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
        Action<HostyAuthenticationOptions>? configure = null,
        bool useAsDefaultScheme = true)
    {
        services.TryAddSingleton(options);
        services.AddMemoryCache();
        AddCoreHttpClient(services, options);

        services.AddSingleton<CoreIdentityValidator>();
        services.AddSingleton<IHostyIdentityValidator>(provider => new CachingIdentityValidator(
            provider.GetRequiredService<CoreIdentityValidator>(),
            provider.GetRequiredService<Microsoft.Extensions.Caching.Memory.IMemoryCache>(),
            CachingIdentityValidator.DefaultTimeToLive));

        // Registering a default scheme is opt-out so composing with an app's existing
        // authentication setup never silently overrides its default.
        var builder = useAsDefaultScheme
            ? services.AddAuthentication(HostyAuthenticationHandler.SchemeName)
            : services.AddAuthentication();
        return builder.AddScheme<HostyAuthenticationOptions, HostyAuthenticationHandler>(
            HostyAuthenticationHandler.SchemeName,
            configure ?? (_ => { }));
    }

    // One named client serves every app→Core call. AddHttpClient is additive per name, so the
    // configure delegate would run twice if both entry points registered it; the guard keeps a
    // single registration regardless of which is called first.
    private static void AddCoreHttpClient(IServiceCollection services, HostyAppOptions options)
    {
        if (services.Any(descriptor => descriptor.ServiceType == typeof(CoreHttpClientMarker)))
        {
            return;
        }

        services.AddSingleton<CoreHttpClientMarker>();
        services.AddHttpClient(CoreIdentityValidator.HttpClientName, client =>
        {
            client.BaseAddress = new Uri(options.CoreOrigin);
            client.Timeout = TimeSpan.FromSeconds(5);
        });
    }

    private sealed class CoreHttpClientMarker;
}
