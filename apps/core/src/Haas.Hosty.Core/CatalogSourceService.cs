namespace Haas.Hosty.Core;

// Operator management of catalog sources (WS7 federation). The list is seeded from the
// HOSTY_CATALOG_SOURCES env default and becomes runtime-mutable on the first add/remove — no Core
// restart. CatalogService reads GetEffectiveSourcesAsync on every storefront fetch, so an added tap's
// apps appear immediately. Sources merge by priority (first wins an id conflict) in CatalogService.
internal sealed class CatalogSourceService(CatalogSourceStore store, HostyCoreRuntimeConfig config)
{
    // Serializes read-modify-write so concurrent add/remove don't clobber each other.
    private readonly SemaphoreSlim mutationLock = new(1, 1);

    // The URLs the catalog is currently served from: the operator's stored list once materialized,
    // otherwise the env-configured default. Used by CatalogService on every storefront fetch.
    public async Task<IReadOnlyList<string>> GetEffectiveSourcesAsync(CancellationToken cancellationToken = default)
        => await ReadEffectiveUrlsAsync(cancellationToken);

    public async Task<CatalogSourcesResponse> ListAsync(CancellationToken cancellationToken = default)
    {
        var state = await store.ReadAsync(cancellationToken);
        var urls = state is null
            ? config.EffectiveCatalogSources
            : state.Sources.Select(source => source.Url).ToArray();
        return BuildResponse(urls, managed: state is not null);
    }

    public async Task<CatalogSourcesResponse> AddAsync(string? url, CancellationToken cancellationToken = default)
    {
        var normalized = NormalizeAndValidate(url);
        await mutationLock.WaitAsync(cancellationToken);
        try
        {
            var current = await ReadEffectiveUrlsAsync(cancellationToken);
            if (current.Any(existing => UrlEquals(existing, normalized)))
            {
                throw new AppLifecycleException("catalog_source_exists", $"Catalog source '{normalized}' is already configured.");
            }

            var updated = current.Append(normalized).ToArray();
            await WriteAsync(updated, cancellationToken);
            return BuildResponse(updated, managed: true);
        }
        finally
        {
            mutationLock.Release();
        }
    }

    public async Task<CatalogSourcesResponse> RemoveAsync(string? url, CancellationToken cancellationToken = default)
    {
        var target = url?.Trim() ?? string.Empty;
        if (target.Length == 0)
        {
            throw new AppLifecycleException("catalog_source_invalid", "Catalog source cannot be empty.");
        }

        await mutationLock.WaitAsync(cancellationToken);
        try
        {
            var current = await ReadEffectiveUrlsAsync(cancellationToken);
            var updated = current.Where(existing => !UrlEquals(existing, target)).ToArray();
            if (updated.Length == current.Count)
            {
                throw new AppLifecycleException("catalog_source_not_found", $"Catalog source '{target}' is not configured.");
            }

            await WriteAsync(updated, cancellationToken);
            return BuildResponse(updated, managed: true);
        }
        finally
        {
            mutationLock.Release();
        }
    }

    // The stored list once materialized, otherwise the env default — the seed the next mutation grows
    // from, so the official default is preserved when an operator adds their first private tap.
    private async Task<IReadOnlyList<string>> ReadEffectiveUrlsAsync(CancellationToken cancellationToken)
    {
        var state = await store.ReadAsync(cancellationToken);
        return state is null
            ? config.EffectiveCatalogSources
            : state.Sources.Select(source => source.Url).ToArray();
    }

    private Task WriteAsync(IReadOnlyList<string> urls, CancellationToken cancellationToken)
        => store.WriteAsync(
            new CatalogSourceState(1, urls.Select(url => new CatalogSource(url)).ToArray()),
            cancellationToken);

    private static CatalogSourcesResponse BuildResponse(IReadOnlyList<string> urls, bool managed)
        => new(urls.Select(url => new CatalogSourceSummary(url, CatalogService.DeriveSourceName(url))).ToArray(), managed);

    // Same rules as the CLI's launch-setting validation (LaunchSettingDefinitions.ValidateCatalogSource):
    // an absolute http(s) URL without credentials, or an already-absolute local path.
    private static string NormalizeAndValidate(string? url)
    {
        var value = url?.Trim() ?? string.Empty;
        if (value.Length == 0)
        {
            throw new AppLifecycleException("catalog_source_invalid", "Catalog source cannot be empty.");
        }

        if (Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
            (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
        {
            if (!string.IsNullOrWhiteSpace(uri.UserInfo))
            {
                throw new AppLifecycleException("catalog_source_invalid", "Catalog source URL must not include credentials.");
            }

            return value;
        }

        if (value.Contains("://", StringComparison.Ordinal))
        {
            throw new AppLifecycleException("catalog_source_invalid", "Catalog source URL must use http or https.");
        }

        if (!Path.IsPathFullyQualified(value))
        {
            throw new AppLifecycleException("catalog_source_invalid", "Catalog source must be an absolute path or an http(s) URL.");
        }

        return value;
    }

    private static bool UrlEquals(string left, string right)
        => string.Equals(left.Trim(), right.Trim(), StringComparison.Ordinal);
}
