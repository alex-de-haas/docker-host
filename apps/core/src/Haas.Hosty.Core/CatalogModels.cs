namespace Haas.Hosty.Core;

// Marketplace catalog data contracts (`marketplace.0.1`). One layer, fetched by Core, never written
// by it: the catalog INDEX (`catalog.json` — the membership/storefront directory). Each entry carries
// its FEEDS inline — named pointers at moving manifest refs (branch raw URLs); releasing = pushing to
// the ref, and update detection compares content digests, never version strings. The index is
// runtime-agnostic: a feed only points at a manifest; the manifest declares docker/image or
// localCommand/source. See docs/features/catalog-hosted-app-feeds.md (A1–A4) and
// docs/features/runtime-app-marketplace.md ("Schemas", B1/B4).
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
// author's own repo/registry; the catalog never contains it. `feeds` are the app's update feeds;
// `signerIdentity` is the trust anchor for the entry (verified in WS5).
internal sealed class CatalogAppEntry
{
    public string? Id { get; init; }
    public string? Name { get; init; }
    public CatalogPublisher? Publisher { get; init; }
    public string? Category { get; init; }
    public IReadOnlyList<string> Tags { get => field ?? []; init; } = [];
    public CatalogDisplay? Display { get; init; }
    public IReadOnlyList<CatalogFeedEntry> Feeds { get => field ?? []; init; } = [];
    public string? SignerIdentity { get; init; }
}

// A feed: an author-named pointer at the app's manifest at a moving ref (typically a branch raw URL).
// `Default` marks the quick-install feed when several are declared (at most one per entry, validated
// at catalog publish); feed array order carries no meaning.
internal sealed class CatalogFeedEntry
{
    public string? Id { get; init; }
    public string? ManifestRef { get; init; }
    public bool? Default { get; init; }
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

// App detail: the entry's display + its feeds + install/update state. `UpdateAvailable` is a display
// hint: installed, following a feed, and the feed head's manifest content digest differs from the
// installed copy — version strings never gate detection (catalog-hosted-app-feeds.md A2). Applying an
// update still goes through the existing reviewed-update flow with the feed's `manifestRef`.
// `FollowedFeedId` is the installed app's recorded feed; null means "no feed set" (pre-feeds install
// or cleared) and clients surface the choose-a-feed guidance instead of an update state (A3).
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
    IReadOnlyList<CatalogAppFeed> Feeds,
    bool Installed,
    string? InstalledVersion,
    string? FollowedFeedId,
    bool UpdateAvailable,
    string? DescriptionUrl = null);

// One resolvable feed on the detail response. `Default` is normalized (absent -> false, and a sole
// feed reports true) so clients can drive A4 quick-install without re-deriving the rule.
internal sealed record CatalogAppFeed(string Id, string ManifestRef, bool Default);

// ---- API responses (`/api/catalog/sources`, `/control/v1/catalog/sources`) -----------------------

// The configured catalog sources (WS7 federation). `Managed` is false while the list is still the
// untouched env default (`HOSTY_CATALOG_SOURCES`) and true once an operator has added/removed a source
// (the list is then persisted and env changes no longer apply). `Name` is derived from the URL host.
internal sealed record CatalogSourcesResponse(IReadOnlyList<CatalogSourceSummary> Sources, bool Managed);

internal sealed record CatalogSourceSummary(string Url, string Name);

internal sealed record CatalogSourceUpsertRequest(string? Url = null);
