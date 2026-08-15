namespace Haas.Hosty.Cli.Mcp;

using Haas.Hosty.Cli.Commands;

/// <summary>
/// Obtains and holds the short-TTL delegated tokens the connector presents to app MCP endpoints.
/// </summary>
/// <remarks>
/// Cached rather than minted per call — settled in docs/features/hosty-mcp-connector/plan.md. What the
/// earlier "fresh token per call" wording was protecting is that <b>no expiring credential is written
/// into a client config</b>, and that holds either way: this cache lives in the connector process and
/// dies with it. Minting per call would add a control round trip to every tool call to shorten the
/// reuse window on a token that already lives five minutes.
/// <para>
/// The margin is why a token is replaced before it is dead: a call that starts inside the window must
/// not be carrying a credential that expires while the app is still working.
/// </para>
/// </remarks>
internal sealed class DelegatedTokenCache(CoreControlClient control, string user, TimeProvider time)
{
    /// <summary>Replaced once this close to expiry, so no call departs on a token about to die.</summary>
    private static readonly TimeSpan ReuseMargin = TimeSpan.FromSeconds(60);

    private readonly Dictionary<string, CachedToken> cache = new(StringComparer.Ordinal);

    /// <summary>
    /// A usable token for <paramref name="appId"/>, or null when Core refuses to issue one — which
    /// means this actor may not reach that app, or the app is gone. Both are the caller's to report as
    /// the app being unavailable rather than as the session failing.
    /// </summary>
    public async Task<string?> TryGetAsync(string appId, CancellationToken cancellationToken)
    {
        if (cache.TryGetValue(appId, out var cached) && cached.ExpiresAt - ReuseMargin > time.GetUtcNow())
        {
            return cached.Token;
        }

        McpCommand.DelegatedTokenResponse? issued;
        try
        {
            issued = await control.PostAsync<McpCommand.DelegatedTokenResponse>(
                $"apps/{Uri.EscapeDataString(appId)}/delegated-token",
                new McpCommand.DelegatedTokenRequest(user),
                cancellationToken);
        }
        catch (Exception ex) when (ex is CoreControlException or CoreControlTimeoutException)
        {
            // A stale entry is dropped rather than kept: once Core says no, continuing to present the
            // previous token would turn a clear refusal into an authorization error from the app.
            cache.Remove(appId);
            return null;
        }

        if (issued is null || string.IsNullOrWhiteSpace(issued.Token))
        {
            cache.Remove(appId);
            return null;
        }

        cache[appId] = new CachedToken(issued.Token, issued.ExpiresAt);
        return issued.Token;
    }

    private readonly record struct CachedToken(string Token, DateTimeOffset ExpiresAt);
}
