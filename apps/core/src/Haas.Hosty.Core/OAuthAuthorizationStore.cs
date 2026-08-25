using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace Haas.Hosty.Core;

// The ephemeral half of the OAuth flow: authorization requests waiting for consent, and the
// one-time codes minted when consent is given.
//
// In memory only, like the device-authorization store and for the same reason: a request lives
// minutes, and a Core restart inside that window leaves the client at its redirect_uri without a
// code — the same recovery it already needs for a consent nobody gave. Durability would buy nothing.
internal sealed class OAuthAuthorizationStore(IClock clock)
{
    /// <summary>How long a request may wait for consent. Long enough to sign in first.</summary>
    public static readonly TimeSpan RequestLifetime = TimeSpan.FromMinutes(10);

    /// <summary>How long an issued code stays collectable. The spec's ceiling; a client redeems
    /// within seconds.</summary>
    public static readonly TimeSpan CodeLifetime = TimeSpan.FromMinutes(1);

    // Pending requests per source address. Per source, never global — the device store's lesson: a
    // global ceiling is the availability hole, because one remote caller could hold it full.
    public const int MaxPendingPerSource = 8;

    private readonly ConcurrentDictionary<string, OAuthAuthorizationRequest> requests = new(StringComparer.Ordinal);

    /// <summary>Parks a validated authorization request for the consent page. Null when the source
    /// is over its cap.</summary>
    public OAuthAuthorizationRequest? Create(
        string clientId,
        string clientName,
        string redirectUri,
        string? state,
        string codeChallenge,
        string audience,
        string audienceDisplayName,
        IReadOnlyList<string> scopes,
        string resource,
        string sourceKey)
    {
        var now = clock.UtcNow;
        Sweep(now);

        if (requests.Values.Count(r => r.SourceKey == sourceKey && r.Code is null) >= MaxPendingPerSource)
        {
            return null;
        }

        var request = new OAuthAuthorizationRequest(
            Id: Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant(),
            ClientId: clientId,
            ClientName: clientName,
            RedirectUri: redirectUri,
            State: state,
            CodeChallenge: codeChallenge,
            Audience: audience,
            AudienceDisplayName: audienceDisplayName,
            Scopes: scopes,
            Resource: resource,
            SourceKey: sourceKey,
            CreatedAt: now,
            ExpiresAt: now + RequestLifetime);
        requests[request.Id] = request;
        return request;
    }

    /// <summary>The request as the consent page sees it; null when unknown or expired.</summary>
    public OAuthAuthorizationRequest? Find(string id)
        => requests.TryGetValue(id, out var request) && request.ExpiresAt > clock.UtcNow && request.Code is null
            ? request
            : null;

    /// <summary>Consent given: mints the one-time code, remembering who approved. Null when the
    /// request is gone or already answered — the code must not be mintable twice.</summary>
    public OAuthAuthorizationRequest? Approve(string id, string userId)
    {
        var now = clock.UtcNow;
        while (true)
        {
            if (!requests.TryGetValue(id, out var current) || current.ExpiresAt <= now || current.Code is not null)
            {
                return null;
            }

            var approved = current with
            {
                Code = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant(),
                CodeExpiresAt = now + CodeLifetime,
                ApprovedUserId = userId,
            };
            if (requests.TryUpdate(id, approved, current))
            {
                return approved;
            }
        }
    }

    /// <summary>Consent refused: the request is simply gone. The client learns access_denied from
    /// the redirect; nothing here is worth keeping.</summary>
    public bool Deny(string id) => requests.TryRemove(id, out _);

    /// <summary>
    /// Redeems a code exactly once, returning the request it belonged to. The removal is the
    /// once-guarantee: two racing redemptions collect one request between them, exactly as the
    /// device flow's collecting poll works.
    /// </summary>
    public OAuthAuthorizationRequest? Redeem(string code)
    {
        var now = clock.UtcNow;
        foreach (var (id, request) in requests)
        {
            if (request.Code is null || !CryptographicOperations.FixedTimeEquals(
                    System.Text.Encoding.UTF8.GetBytes(request.Code),
                    System.Text.Encoding.UTF8.GetBytes(code)))
            {
                continue;
            }

            if (!requests.TryRemove(id, out var removed))
            {
                return null;
            }

            return removed.CodeExpiresAt > now ? removed : null;
        }

        return null;
    }

    private void Sweep(DateTimeOffset now)
    {
        foreach (var (id, request) in requests)
        {
            var expired = request.Code is null ? request.ExpiresAt <= now : request.CodeExpiresAt <= now;
            if (expired)
            {
                requests.TryRemove(id, out _);
            }
        }
    }
}

internal sealed record OAuthAuthorizationRequest(
    string Id,
    string ClientId,
    string ClientName,
    string RedirectUri,
    string? State,
    string CodeChallenge,
    string Audience,
    string AudienceDisplayName,
    IReadOnlyList<string> Scopes,
    string Resource,
    string SourceKey,
    DateTimeOffset CreatedAt,
    DateTimeOffset ExpiresAt,
    string? Code = null,
    DateTimeOffset CodeExpiresAt = default,
    string? ApprovedUserId = null);
