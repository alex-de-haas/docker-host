namespace Haas.Hosty.Core;

// Where Shell is publicly reachable, resolved from the installed app record instead of Core's launch
// config. Shell is an optional distribution app (`defaultEnabled`, not mandatory), so Core must not
// carry configuration for it and must cope with it being absent entirely: a null here means "no UI
// client installed", and every caller needs an answer for that rather than sending a browser to a dead
// origin — which is what the old `http://localhost:{ShellPort}` fallback did.
//
// Resolution is the same path every other app uses: the operator's HOSTY_PUBLIC_ORIGIN_<endpoint>
// setting, else the loopback URL Core assigned the endpoint. (The `PublicOrigin` field on the endpoint
// contract is projected onto summaries only and is null in the persisted record, so the setting is the
// authoritative read.)
//
// Reads are cached briefly. The CORS policy consults this on every cross-origin request and the registry
// reads state.json from disk each time. Staleness is harmless: a public-origin change only reaches Shell
// as container env, so it needs a restart to take effect anyway.
internal sealed class ShellPublicOriginResolver(AppRegistryStore apps, IClock clock)
{
    private static readonly TimeSpan CacheTtl = TimeSpan.FromSeconds(5);

    private readonly SemaphoreSlim gate = new(1, 1);

    // One immutable entry behind a volatile reference. The fast path reads it without the gate, and a
    // value/timestamp pair held as separate fields could not be read consistently there: DateTimeOffset is
    // a multi-word struct, so its read can tear against a concurrent write, and the two fields could be
    // observed from different refreshes. A reference assignment is atomic, so the pair is always coherent.
    private volatile CacheEntry cache = new(null, DateTimeOffset.MinValue);

    private sealed record CacheEntry(string? Value, DateTimeOffset ReadAt);

    public async ValueTask<string?> ResolveAsync(CancellationToken cancellationToken = default)
    {
        var entry = cache;
        if (clock.UtcNow - entry.ReadAt < CacheTtl)
        {
            return entry.Value;
        }

        await gate.WaitAsync(cancellationToken);
        try
        {
            // Re-check under the gate: a concurrent caller may have just refreshed it.
            entry = cache;
            if (clock.UtcNow - entry.ReadAt < CacheTtl)
            {
                return entry.Value;
            }

            var value = await ReadAsync(cancellationToken);
            cache = new CacheEntry(value, clock.UtcNow);
            return value;
        }
        finally
        {
            gate.Release();
        }
    }

    private async Task<string?> ReadAsync(CancellationToken cancellationToken)
    {
        var app = await apps.GetAppAsync(ShellBootstrap.AppId, cancellationToken);
        var publicEndpoints = (app?.Endpoints ?? []).Where(candidate => candidate.Public).ToArray();
        // Name the web endpoint rather than taking whichever public one comes first: the legacy-origin
        // migration stamps that exact key (ShellBootstrap.WebEndpointKey), so letting endpoint order pick
        // it here would have the two sides disagree the moment Shell publishes a second endpoint. Any
        // public endpoint still serves as a fallback, so a manifest that renames it is not a dead end.
        var endpoint = publicEndpoints.FirstOrDefault(candidate =>
                string.Equals(candidate.Key, ShellBootstrap.WebEndpointKey, StringComparison.Ordinal))
            ?? publicEndpoints.FirstOrDefault();
        if (app is null || endpoint is null)
        {
            return null;
        }

        var configured = app.Settings is { } settings &&
            settings.TryGetValue(PublicOriginSettings.BuildSettingKey(endpoint.Key), out var setting)
                ? setting.Value
                : null;
        if (PublicOriginSettings.TryNormalizeOrigin(configured, out var published))
        {
            return published;
        }

        // Not published: Shell is still reachable on the loopback URL Core assigned it.
        return PublicOriginSettings.TryNormalizeOrigin(endpoint.Url, out var local) ? local : null;
    }
}
