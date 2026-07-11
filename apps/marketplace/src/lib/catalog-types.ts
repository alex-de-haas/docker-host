// Marketplace catalog data contracts (`marketplace.0.1`), moved out of Core (Phase 1 of
// docs/ideas/marketplace-system-app.md). One layer, fetched by this app, never written by it: the
// catalog INDEX (`catalog.json` — the membership/storefront directory). Each entry carries its FEEDS
// inline — named pointers at moving manifest refs (branch raw URLs); releasing = pushing to the ref.
// The index is runtime-agnostic: a feed only points at a manifest; the manifest declares
// docker/image or localCommand/source. See docs/features/catalog-hosted-app-feeds.md (A1–A4) and
// docs/features/runtime-app-marketplace.md ("Schemas", B1/B4).
//
// The API responses deliberately carry NO Core-owned projections (installed, installedVersion,
// followed feed, update availability): those are Core facts that clients join separately. This is
// the read-only boundary that keeps Marketplace out of install/update policy.

export const CATALOG_SCHEMA_VERSION = "marketplace.0.1";

// ---- Wire schema: catalog index (`catalog.json`) --------------------------------------------------
// Fetched documents are untrusted input: every field is optional/unknown until normalized.

export type CatalogIndex = {
  schemaVersion?: string | null;
  source?: CatalogSourceInfo | null;
  apps?: CatalogAppEntry[] | null;
};

export type CatalogSourceInfo = {
  name?: string | null;
  description?: string | null;
  url?: string | null;
};

// One catalog membership entry: pointers + trust + display metadata only. The app's code lives in
// the author's own repo/registry; the catalog never contains it. `feeds` are the app's update feeds;
// `signerIdentity` is the trust anchor for the entry (verified in WS5).
export type CatalogAppEntry = {
  id?: string | null;
  name?: string | null;
  publisher?: CatalogPublisher | null;
  category?: string | null;
  tags?: string[] | null;
  display?: CatalogDisplay | null;
  feeds?: CatalogFeedEntry[] | null;
  signerIdentity?: string | null;
};

// A feed: an author-named pointer at the app's manifest at a moving ref (typically a branch raw
// URL). `default` marks the quick-install feed when several are declared (at most one per entry,
// validated at catalog publish); feed array order carries no meaning.
export type CatalogFeedEntry = {
  id?: string | null;
  manifestRef?: string | null;
  default?: boolean | null;
};

export type CatalogPublisher = {
  name?: string | null;
  url?: string | null;
  email?: string | null;
};

export type CatalogDisplay = {
  summary?: string | null;
  icon?: string | null;
  screenshots?: string[] | null;
  // Absolute URL to a markdown long-description, generated at publish by vendoring the manifest's
  // catalogMetadata.descriptionFile (manifest-level app assets). Null when the entry declares none.
  descriptionUrl?: string | null;
};

// ---- API responses (`/v1/*`) ----------------------------------------------------------------------
// Optional scalar fields are explicit nulls (not omitted) for parity with Core's response style.

export type CatalogAppsResponse = {
  apps: CatalogAppSummary[];
};

// One storefront card. `sourceName` names the configured source it came from (federation legibility).
export type CatalogAppSummary = {
  id: string;
  name: string;
  summary: string | null;
  category: string | null;
  tags: string[];
  icon: string | null;
  publisher: CatalogPublisher | null;
  sourceName: string;
};

// App detail: the entry's display + its feeds. Install/update state is a Core projection and is
// deliberately absent; clients that need it join against Core's own APIs.
export type CatalogAppDetailResponse = {
  id: string;
  name: string;
  summary: string | null;
  category: string | null;
  tags: string[];
  icon: string | null;
  screenshots: string[];
  publisher: CatalogPublisher | null;
  sourceName: string;
  signerIdentity: string | null;
  feeds: CatalogAppFeed[];
  descriptionUrl: string | null;
};

// One resolvable feed on the detail response. `default` is normalized (absent -> false, and a sole
// feed reports true) so clients can drive quick-install without re-deriving the rule.
export type CatalogAppFeed = {
  id: string;
  manifestRef: string;
  default: boolean;
};

// ---- API responses (`/v1/catalog/sources`) --------------------------------------------------------

// The configured catalog sources. `managed` is false while the list is still the untouched seed
// (env/import default) and true once an operator has added/removed a source (the list is then
// persisted and seed changes no longer apply). `name` is derived from the URL host.
export type CatalogSourcesResponse = {
  sources: CatalogSourceSummary[];
  managed: boolean;
};

export type CatalogSourceSummary = {
  url: string;
  name: string;
};

export type CatalogSourceUpsertRequest = {
  url?: string | null;
};

export type ErrorResponse = {
  code: string;
  message: string;
};

export type HealthResponse = {
  status: string;
};
