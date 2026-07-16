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
    private string? cached;
    private DateTimeOffset cachedAt = DateTimeOffset.MinValue;

    public async ValueTask<string?> ResolveAsync(CancellationToken cancellationToken = default)
    {
        if (clock.UtcNow - cachedAt < CacheTtl)
        {
            return cached;
        }

        await gate.WaitAsync(cancellationToken);
        try
        {
            // Re-check under the gate: a concurrent caller may have just refreshed it.
            if (clock.UtcNow - cachedAt < CacheTtl)
            {
                return cached;
            }

            cached = await ReadAsync(cancellationToken);
            cachedAt = clock.UtcNow;
            return cached;
        }
        finally
        {
            gate.Release();
        }
    }

    private async Task<string?> ReadAsync(CancellationToken cancellationToken)
    {
        var app = await apps.GetAppAsync(ShellBootstrap.AppId, cancellationToken);
        var endpoint = (app?.Endpoints ?? []).FirstOrDefault(candidate => candidate.Public);
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
