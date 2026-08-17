namespace Haas.Hosty.Cli.Mcp;

using Haas.Hosty.Cli.Commands;

/// <summary>
/// Obtains and holds the short-TTL delegated tokens the connector presents to app MCP endpoints.
/// </summary>
/// <remarks>
/// Cached rather than minted per call — settled in docs/features/hosty-mcp-connector/feature.md. What the
/// earlier "fresh token per call" wording was protecting is that <b>no expiring credential is written
/// into a client config</b>, and that holds either way: this cache lives in the connector process and
/// dies with it. Minting per call would add a control round trip to every tool call to shorten the
/// reuse window on a token that already lives five minutes.
/// <para>
/// The margin is why a token is replaced before it is dead: a call that starts inside the window must
/// not be carrying a credential that expires while the app is still working.
/// </para>
/// </remarks>
/// <param name="issue">
/// Asks Core for a token, or yields null when it refuses. A delegate rather than the control client:
/// the refusal and the expiry are the behaviour worth pinning, and neither needs a running host.
/// </param>
/// <param name="warn">
/// Where the reason a token was refused goes. Worth a parameter rather than a swallowed null: driving
/// the connector against a Core that predated the token route produced a bare "would not issue a
/// token for this user", which reads as an access problem and sent the reader to the wrong place. The
/// status line says 404 and settles it in one look.
/// </param>
internal sealed class DelegatedTokenCache(
    Func<string, CancellationToken, Task<IssuedToken?>> issue,
    TimeProvider time,
    Action<string>? warn = null)
{
    /// <summary>Replaced once this close to expiry, so no call departs on a token about to die.</summary>
    private static readonly TimeSpan ReuseMargin = TimeSpan.FromSeconds(60);

    private readonly Dictionary<string, IssuedToken> cache = new(StringComparer.Ordinal);

    // The fan-out asks for every app's token at once, so these continuations run concurrently and a
    // plain Dictionary would be mutated from several of them. Serializing the whole method rather than
    // guarding the two accesses buys single-flight as well: two targets of the same app — an app with
    // more than one mcp interface — mint once between them instead of racing to mint twice. The cost
    // is that the first fan-out issues its tokens in sequence, which against a loopback control
    // channel is not worth a more intricate scheme.
    private readonly SemaphoreSlim gate = new(1, 1);

    /// <summary>
    /// A usable token for <paramref name="appId"/>, or null when Core refuses to issue one — which
    /// means this actor may not reach that app, or the app is gone. Both are the caller's to report as
    /// the app being unavailable rather than as the session failing.
    /// </summary>
    public async Task<string?> TryGetAsync(string appId, CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            return await IssueAsync(appId, cancellationToken);
        }
        finally
        {
            gate.Release();
        }
    }

    private async Task<string?> IssueAsync(string appId, CancellationToken cancellationToken)
    {
        if (cache.TryGetValue(appId, out var cached) && cached.ExpiresAt - ReuseMargin > time.GetUtcNow())
        {
            return cached.Token;
        }

        IssuedToken? issued;
        try
        {
            issued = await issue(appId, cancellationToken);
        }
        catch (Exception ex) when (ex is CoreControlException or CoreControlTimeoutException)
        {
            warn?.Invoke(ex is CoreControlException { StatusCode: System.Net.HttpStatusCode.NotFound } notFound &&
                    string.IsNullOrWhiteSpace(notFound.ResponseBody)
                // An empty 404 is the route itself missing, not a refusal about this user or app.
                ? $"{appId}: this Hosty Core has no delegated-token control route; it predates 0.81.0 and needs updating."
                : $"{appId}: Hosty Core refused a token — {ex.Message}");
            // A stale entry is dropped rather than kept: once Core says no, continuing to present the
            // previous token would turn a clear refusal into an authorization error from the app.
            cache.Remove(appId);
            return null;
        }

        if (issued is not { } token || string.IsNullOrWhiteSpace(token.Token))
        {
            cache.Remove(appId);
            return null;
        }

        cache[appId] = token;
        return token.Token;
    }
}

/// <summary>A delegated token and when it stops being usable.</summary>
internal readonly record struct IssuedToken(string Token, DateTimeOffset ExpiresAt);
