namespace HostySdk.App;

/// <summary>
/// A Host user identity validated by Hosty Core (the result of revalidating a forwarded
/// app identity token). The app trusts only sessions produced this way — never client-set
/// headers or cookies on their own.
/// </summary>
public sealed record HostySession(
    string AppId,
    string UserId,
    string? Email,
    string? DisplayName,
    string HostRole,
    DateTimeOffset ExpiresAt);

/// <summary>
/// Turns a forwarded app identity token into a validated <see cref="HostySession"/> by
/// revalidating it against Core. Implementations must not trust a token without Core:
/// app identity tokens are opaque <c>hostyg_</c> grants, so the online round-trip is the
/// only trustworthy validation — and it is also Core's revocation guarantee (policy is
/// re-checked on every call).
/// </summary>
public interface IHostyIdentityValidator
{
    Task<HostySession?> ValidateAsync(string accessToken, CancellationToken cancellationToken);
}
