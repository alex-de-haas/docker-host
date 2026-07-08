namespace Haas.Hosty.Core;

// Marketplace catalog data contracts (`marketplace.0.1`). Two layers, both fetched by Core, never
// written by it: the catalog INDEX (`catalog.json` — the membership/storefront directory) and the
// per-app version FEED (`releasesUrl` — author-owned release list). The index is runtime-agnostic:
// an entry only points at a manifest; the manifest declares docker/image or localCommand/source. See
// docs/features/runtime-app-marketplace.md ("Schemas", B1/B4, and the artifact-agnostic feed revision).
//
// Deserialized via the source-generated context, so absent arrays coalesce to empty (matching the
// manifest-model convention) rather than throwing under Native AOT.

internal static class CatalogSchema
{
    public const string Version = "marketplace.0.1";
}

// ---- Wire schema: catalog index (`catalog.json`) --------------------------------------------------

internal sealed class CatalogIndex
{
    public string? SchemaVersion { get; init; }
    public CatalogSourceInfo? Source { get; init; }
    public IReadOnlyList<CatalogAppEntry> Apps { get => field ?? []; init; } = [];
}

internal sealed class CatalogSourceInfo
{
    public string? Name { get; init; }
    public string? Description { get; init; }
    public string? Url { get; init; }
}

// One catalog membership entry: pointers + trust + display metadata only. The app's code lives in the
// author's own repo/registry; the catalog never contains it. `releasesUrl` points at the version feed;
// `signerIdentity` is the trust anchor the feed's signature must match (verified in WS5).
internal sealed class CatalogAppEntry
{
    public string? Id { get; init; }
    public string? Name { get; init; }
    public CatalogPublisher? Publisher { get; init; }
    public string? Category { get; init; }
    public IReadOnlyList<string> Tags { get => field ?? []; init; } = [];
    public CatalogDisplay? Display { get; init; }
    public string? ReleasesUrl { get; init; }
    public string? SignerIdentity { get; init; }
}

internal sealed class CatalogPublisher
{
    public string? Name { get; init; }
    public string? Url { get; init; }
    public string? Email { get; init; }
}

internal sealed class CatalogDisplay
{
    public string? Summary { get; init; }
    public string? Icon { get; init; }
    public IReadOnlyList<string> Screenshots { get => field ?? []; init; } = [];
    // Absolute URL to a markdown long-description, generated at publish by vendoring the manifest's
    // catalogMetadata.descriptionFile (manifest-level app assets). Null when the entry declares none.
    public string? DescriptionUrl { get; init; }
}

// ---- Wire schema: per-app version feed (`releasesUrl`) --------------------------------------------

internal sealed class VersionFeed
{
    public IReadOnlyList<VersionFeedEntry> Versions { get => field ?? []; init; } = [];
    public VersionFeedTags? Tags { get; init; }
}

internal sealed class VersionFeedEntry
{
    public string? Version { get; init; }
    public string? ManifestRef { get; init; }
    // Optional resolved artifact identity, discriminated by `kind` (image/source/prebuilt). Optional
    // because Core re-resolves it at install from the manifest's declared runtime; it is a post-publish
    // optimization and the provenance anchor for signing. See the artifact-agnostic feed revision.
    public CatalogArtifact? Artifact { get; init; }
}

internal sealed class CatalogArtifact
{
    public string? Kind { get; init; }
    public string? ImageDigest { get; init; }
    public string? Commit { get; init; }
    public string? Ref { get; init; }
    public string? BundleHash { get; init; }
}

internal sealed class VersionFeedTags
{
    public string? Stable { get; init; }
    public string? Beta { get; init; }
}

// ---- API responses (`/api/catalog/*`) ------------------------------------------------------------

internal sealed record CatalogAppsResponse(IReadOnlyList<CatalogAppSummary> Apps);

// One storefront card. `SourceName` names the configured source it came from (for federation legibility,
// WS7). `Installed`/`InstalledVersion` are joined from Core's registry so the card shows install state.
internal sealed record CatalogAppSummary(
    string Id,
    string Name,
    string? Summary,
    string? Category,
    IReadOnlyList<string> Tags,
    string? Icon,
    CatalogPublisher? Publisher,
    string SourceName,
    bool Installed,
    string? InstalledVersion);

// App detail: the entry's display + the resolved feed versions + install/update state. `UpdateAvailable`
// is a display hint (installed and the feed's stable version differs from the installed one); applying an
// update still goes through the existing reviewed-update flow with the version's `manifestRef`.
internal sealed record CatalogAppDetailResponse(
    string Id,
    string Name,
    string? Summary,
    string? Category,
    IReadOnlyList<string> Tags,
    string? Icon,
    IReadOnlyList<string> Screenshots,
    CatalogPublisher? Publisher,
    string SourceName,
    string? SignerIdentity,
    string? ReleasesUrl,
    IReadOnlyList<CatalogAppVersion> Versions,
    string? StableVersion,
    string? BetaVersion,
    bool Installed,
    string? InstalledVersion,
    bool UpdateAvailable,
    string? DescriptionUrl = null);

internal sealed record CatalogAppVersion(string Version, string ManifestRef, CatalogArtifact? Artifact);

// ---- API responses (`/api/catalog/sources`, `/control/v1/catalog/sources`) -----------------------

// The configured catalog sources (WS7 federation). `Managed` is false while the list is still the
// untouched env default (`HOSTY_CATALOG_SOURCES`) and true once an operator has added/removed a source
// (the list is then persisted and env changes no longer apply). `Name` is derived from the URL host.
internal sealed record CatalogSourcesResponse(IReadOnlyList<CatalogSourceSummary> Sources, bool Managed);

internal sealed record CatalogSourceSummary(string Url, string Name);

internal sealed record CatalogSourceUpsertRequest(string? Url = null);
