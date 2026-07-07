using System.Text.Json;

namespace Haas.Hosty.Core;

// Host-level list of catalog sources an operator has configured (WS7 federation). Persisted at
// core/catalog-sources.json, seeded once from the HOSTY_CATALOG_SOURCES env default the first time an
// operator adds or removes a source. Until then the file is absent and the env default is used live, so
// an unconfigured install keeps its single official source with no migration. Separate from app records —
// never backed up or deleted by app lifecycle. See docs/features/runtime-app-marketplace.md (WS7, Variant B).
internal sealed class CatalogSourceStore(CoreDataPaths paths)
{
    private string StatePath => Path.Combine(paths.CoreRoot, "catalog-sources.json");

    // Null when the store has never been materialized (no operator edit yet) — the caller then falls back
    // to the env default. A present-but-empty list means the operator deliberately cleared every source.
    public async Task<CatalogSourceState?> ReadAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            var state = await JsonStorage.ReadAsync<CatalogSourceState>(StatePath, cancellationToken);
            // A corrupted/hand-edited file with "sources": null would otherwise NRE in the service.
            return state is null ? null : state with { Sources = state.Sources ?? [] };
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            // A corrupt/locked catalog-sources.json must degrade to the env-seeded default (null), never
            // 500 the best-effort storefront read. OperationCanceledException still propagates.
            return null;
        }
    }

    public async Task WriteAsync(CatalogSourceState state, CancellationToken cancellationToken = default)
        => await JsonStorage.WriteAsync(StatePath, state, restrictToOwner: true, cancellationToken);
}

internal sealed record CatalogSourceState(int SchemaVersion, IReadOnlyList<CatalogSource> Sources);

// One operator-configured catalog source: an http(s) URL or an absolute local path to a `catalog.json`.
// The display name is derived live (from the fetched index's declared name or the URL host), not stored,
// so it always reflects the source rather than a stale label.
internal sealed record CatalogSource(string Url);
