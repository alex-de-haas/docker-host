using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Caching.Memory;

namespace HostySdk.App;

/// <summary>
/// Caches positive identity validations for a short TTL keyed by the opaque token, so a burst
/// of requests carrying the same session does not hammer Core. The cache window never outlives
/// the token's own expiry, and negative results are never cached (a token may become valid, or
/// the failure may be transient) — so a stuck-unauthenticated state is impossible. The platform
/// default TTL is 30 seconds (decision 9 in docs/ideas/hosty-app-sdk.md).
/// </summary>
public sealed class CachingIdentityValidator(
    IHostyIdentityValidator inner,
    IMemoryCache cache,
    TimeSpan timeToLive)
    : IHostyIdentityValidator
{
    /// <summary>The platform-decided default cache window.</summary>
    public static readonly TimeSpan DefaultTimeToLive = TimeSpan.FromSeconds(30);

    public async Task<HostySession?> ValidateAsync(string accessToken, CancellationToken cancellationToken)
    {
        var key = CacheKey(accessToken);
        if (cache.TryGetValue<HostySession>(key, out var cached) && cached is not null)
        {
            return cached;
        }

        var session = await inner.ValidateAsync(accessToken, cancellationToken);
        if (session is null)
        {
            return null;
        }

        var remaining = session.ExpiresAt - DateTimeOffset.UtcNow;
        var window = remaining < timeToLive ? remaining : timeToLive;
        if (window > TimeSpan.Zero)
        {
            cache.Set(key, session, window);
        }

        return session;
    }

    // Keyed by a hash so the opaque token does not sit in cache keys for the eviction
    // window in cleartext (the token itself is never cached, only the validated session).
    private static string CacheKey(string token)
        => $"hosty-identity:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)))}";
}
