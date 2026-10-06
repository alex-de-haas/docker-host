using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

// Like pending OAuth/device requests, browser intents live only until completion or a Core restart.
// Every field comes from the validated app-origin POST; the continuation can only name this record.
internal sealed class AppSignInIntentStore(IClock clock)
{
    internal static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(5);
    internal const int MaxPerBrowser = 16;
    internal const int MaxPending = 4096;
    private readonly object gate = new();
    private readonly Dictionary<string, AppSignInIntent> pending = new(StringComparer.Ordinal);
    private long sequence;

    internal AppSignInIntentCreated? Create(string appId, string redirectUri, string state, string challenge,
        AppSignInMode mode, string sourceKey, int browserCookieCount)
    {
        lock (gate)
        {
            Sweep();
            if (browserCookieCount >= MaxPerBrowser || pending.Count >= MaxPending ||
                pending.Values.Count(intent => intent.SourceKey == sourceKey) >= OAuthAuthorizationStore.MaxPendingPerSource)
                return null;
            var nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
            var intent = new AppSignInIntent(Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant(),
                appId, redirectUri, state, challenge, mode, Hash(nonce), sourceKey, clock.UtcNow.Add(Lifetime), ++sequence);
            pending.Add(intent.Id, intent);
            return new(intent, nonce);
        }
    }

    internal AppSignInIntent? Find(string appId, string? id, string? nonce)
    {
        lock (gate)
        {
            Sweep();
            if (id is null || !pending.TryGetValue(id, out var intent) || intent.AppId != appId || !MatchesNonce(intent, nonce))
                return null;
            return intent;
        }
    }

    internal bool TryClaim(AppSignInIntent intent)
    {
        lock (gate)
        {
            Sweep();
            return pending.TryGetValue(intent.Id, out var current) && ReferenceEquals(current, intent) && pending.Remove(intent.Id);
        }
    }

    internal bool Contains(string id)
    {
        lock (gate) { Sweep(); return pending.ContainsKey(id); }
    }

    // Only immutable public callback fields are used from this lookup. It cannot claim or issue.
    internal AppSignInIntent? FindCallback(string appId, string id)
    {
        lock (gate)
        {
            Sweep();
            return pending.TryGetValue(id, out var intent) && intent.AppId == appId ? intent : null;
        }
    }

    internal bool WithinBrowserCapacity(AppSignInIntent intent, Func<AppSignInIntent, string?> nonceFor)
    {
        lock (gate)
        {
            Sweep();
            // Count only live, nonce-bound earlier attempts. A newly arriving attempt cannot evict
            // an older one, including when cross-site POST omitted the browser's Lax cookies.
            return pending.Values.Count(other => other.Sequence < intent.Sequence && MatchesNonce(other, nonceFor(other))) < MaxPerBrowser;
        }
    }

    private static bool MatchesNonce(AppSignInIntent intent, string? nonce)
        => nonce is { Length: 64 } && nonce.All(Uri.IsHexDigit) && CryptographicOperations.FixedTimeEquals(
            Convert.FromHexString(intent.NonceHash), Convert.FromHexString(Hash(nonce)));

    private void Sweep()
    {
        foreach (var intent in pending.Values.Where(intent => intent.ExpiresAt <= clock.UtcNow).ToArray())
            pending.Remove(intent.Id);
    }

    private static string Hash(string nonce) => Convert.ToHexString(SHA256.HashData(Encoding.ASCII.GetBytes(nonce)));
}

internal enum AppSignInMode { Standalone, Silent, Popup }
internal sealed record AppSignInIntent(string Id, string AppId, string RedirectUri, string State, string CodeChallenge,
    AppSignInMode Mode, string NonceHash, string SourceKey, DateTimeOffset ExpiresAt, long Sequence);
internal sealed record AppSignInIntentCreated(AppSignInIntent Intent, string Nonce);
