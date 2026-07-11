import {
  CATALOG_SCHEMA_VERSION,
  FEEDS_SCHEMA_VERSION,
  type AppFeedEntry,
  type AppFeedsDocument,
  type CatalogAppDetailResponse,
  type CatalogAppEntry,
  type CatalogAppFeed,
  type CatalogAppSummary,
  type CatalogAppsResponse,
  type CatalogDiagnostic,
  type CatalogIndex,
  type CatalogPublisher,
  type CatalogSourceSummary,
} from "@/lib/catalog-types";
import type { CatalogDocumentFetcher } from "@/lib/fetcher";

type Logger = (message: string) => void;

type LoadedCatalog = {
  entries: Map<string, CatalogAppEntry & { id: string }>;
  source: CatalogSourceSummary;
  diagnostic: CatalogDiagnostic;
};

type FeedResult = {
  feeds: CatalogAppFeed[];
  diagnostic: CatalogDiagnostic;
};

type DescriptionResult = {
  content: string | null;
  diagnostic: CatalogDiagnostic;
};

export class CatalogService {
  constructor(
    private readonly sourceUrl: string | null,
    private readonly fetcher: CatalogDocumentFetcher,
    private readonly log: Logger = message => console.warn(message),
  ) {}

  async getApps(options: { refresh?: boolean } = {}): Promise<CatalogAppsResponse> {
    const catalog = await this.loadCatalog(options.refresh === true);
    // Summaries stay lightweight: feeds are resolved lazily per app when details open, since fetching
    // every entry's feeds document up front would be far too costly for a large catalog.
    const apps: CatalogAppSummary[] = [...catalog.entries.values()].map(entry => ({
      id: entry.id,
      name: resolveName(entry),
      summary: nullIfBlank(entry.display?.summary),
      category: nullIfBlank(entry.category),
      tags: normalizeList(entry.tags),
      icon: resolveHttpUrl(entry.display?.icon, this.sourceUrl),
      publisher: normalizePublisher(entry.publisher, this.sourceUrl),
      sourceName: catalog.source.name,
    }));

    apps.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
    return { apps, source: catalog.source, diagnostic: catalog.diagnostic };
  }

  async getApp(id: string, options: { refresh?: boolean } = {}): Promise<CatalogAppDetailResponse | null> {
    const trimmed = id.trim();
    if (!trimmed) {
      return null;
    }

    const refresh = options.refresh === true;
    const catalog = await this.loadCatalog(refresh);
    const entry = catalog.entries.get(trimmed.toLowerCase());
    if (!entry) {
      return null;
    }

    const feedsUrl = resolveHttpUrl(entry.feedsUrl, this.sourceUrl);
    const descriptionUrl = resolveHttpUrl(entry.display?.descriptionUrl, this.sourceUrl);
    const [feedResult, descriptionResult] = await Promise.all([
      this.loadFeeds(entry.id, feedsUrl, refresh),
      this.loadDescription(descriptionUrl, refresh),
    ]);
    return {
      id: entry.id,
      name: resolveName(entry),
      summary: nullIfBlank(entry.display?.summary),
      category: nullIfBlank(entry.category),
      tags: normalizeList(entry.tags),
      icon: resolveHttpUrl(entry.display?.icon, this.sourceUrl),
      screenshots: normalizeList(entry.display?.screenshots).flatMap(value => {
        const resolved = resolveHttpUrl(value, this.sourceUrl);
        return resolved ? [resolved] : [];
      }),
      publisher: normalizePublisher(entry.publisher, this.sourceUrl),
      sourceName: catalog.source.name,
      signerIdentity: nullIfBlank(entry.signerIdentity),
      feedsUrl,
      feeds: feedResult.feeds,
      feedDiagnostic: feedResult.diagnostic,
      descriptionUrl,
      description: descriptionResult.content,
      descriptionDiagnostic: descriptionResult.diagnostic,
    };
  }

  private async loadCatalog(refresh: boolean): Promise<LoadedCatalog> {
    const fallbackSource = sourceSummary(this.sourceUrl, null);
    if (!this.sourceUrl) {
      return {
        entries: new Map(),
        source: fallbackSource,
        diagnostic: diagnostic(
          "not-configured",
          "catalog_source_not_configured",
          "Configure HOSTY_MARKETPLACE_SOURCE_URL to an HTTP(S) marketplace.0.2 catalog.",
        ),
      };
    }

    const raw = await this.fetcher.fetch(this.sourceUrl, { refresh });
    if (raw === null) {
      return {
        entries: new Map(),
        source: fallbackSource,
        diagnostic: diagnostic(
          "unavailable",
          "catalog_source_unavailable",
          "The configured catalog could not be loaded. Check the URL and network access, then refresh.",
        ),
      };
    }

    const parsed = parseObject<CatalogIndex>(raw);
    if (!parsed || parsed.schemaVersion !== CATALOG_SCHEMA_VERSION) {
      const actual = parsed?.schemaVersion ?? "(none)";
      this.log(`Catalog declares unsupported schemaVersion '${actual}'; expected '${CATALOG_SCHEMA_VERSION}'.`);
      return {
        entries: new Map(),
        source: fallbackSource,
        diagnostic: diagnostic(
          "invalid",
          "catalog_schema_unsupported",
          `The catalog must declare ${CATALOG_SCHEMA_VERSION}; received ${actual}.`,
        ),
      };
    }

    const source = sourceSummary(this.sourceUrl, parsed);
    const entries = new Map<string, CatalogAppEntry & { id: string }>();
    for (const candidate of Array.isArray(parsed.apps) ? parsed.apps : []) {
      const id = nullIfBlank(candidate?.id);
      if (!id) {
        continue;
      }

      const key = id.toLowerCase();
      if (entries.has(key)) {
        this.log(`Catalog contains duplicate app id '${id}'; keeping the first entry.`);
        continue;
      }

      entries.set(key, { ...candidate, id });
    }

    return {
      entries,
      source,
      diagnostic: diagnostic("ready", "catalog_ready", `Loaded ${entries.size} catalog app${entries.size === 1 ? "" : "s"}.`),
    };
  }

  private async loadFeeds(appId: string, feedsUrl: string | null, refresh: boolean): Promise<FeedResult> {
    if (!feedsUrl) {
      return {
        feeds: [],
        diagnostic: diagnostic(
          "invalid",
          "catalog_feeds_url_invalid",
          "This catalog entry does not provide a valid HTTP(S) feedsUrl.",
        ),
      };
    }

    const raw = await this.fetcher.fetch(feedsUrl, { refresh, blockPrivateHosts: true });
    if (raw === null) {
      return {
        feeds: [],
        diagnostic: diagnostic(
          "unavailable",
          "app_feeds_unavailable",
          "Feed choices could not be loaded. Core will validate the feed again during install review.",
        ),
      };
    }

    const document = parseObject<AppFeedsDocument>(raw);
    const validationError = validateFeedsDocument(document, appId);
    if (validationError) {
      this.log(`Feed document for '${appId}' is invalid: ${validationError}`);
      return {
        feeds: [],
        diagnostic: diagnostic("invalid", "app_feeds_invalid", validationError),
      };
    }

    const feeds = normalizeFeeds(document!.feeds as AppFeedEntry[]);
    if (feeds.length === 1 && !feeds[0].default) {
      feeds[0] = { ...feeds[0], default: true };
    }

    return {
      feeds,
      diagnostic: diagnostic("ready", "app_feeds_ready", `Loaded ${feeds.length} feed${feeds.length === 1 ? "" : "s"}.`),
    };
  }

  private async loadDescription(descriptionUrl: string | null, refresh: boolean): Promise<DescriptionResult> {
    if (!descriptionUrl) {
      return {
        content: null,
        diagnostic: diagnostic(
          "not-configured",
          "catalog_description_not_configured",
          "This catalog entry does not provide a description document.",
        ),
      };
    }

    const content = await this.fetcher.fetch(descriptionUrl, { refresh, blockPrivateHosts: true });
    if (content === null) {
      return {
        content: null,
        diagnostic: diagnostic(
          "unavailable",
          "catalog_description_unavailable",
          "The app description could not be loaded.",
        ),
      };
    }

    return {
      content,
      diagnostic: diagnostic("ready", "catalog_description_ready", "Loaded the app description."),
    };
  }
}

function sourceSummary(sourceUrl: string | null, index: CatalogIndex | null): CatalogSourceSummary {
  return {
    url: sourceUrl,
    name: nullIfBlank(index?.source?.name) ?? deriveSourceName(sourceUrl),
    description: nullIfBlank(index?.source?.description),
  };
}

export function deriveSourceName(source: string | null): string {
  if (!source) {
    return "Catalog not configured";
  }

  try {
    return new URL(source).hostname;
  } catch {
    return "Configured catalog";
  }
}

function resolveName(entry: CatalogAppEntry & { id: string }): string {
  return nullIfBlank(entry.name) ?? entry.id;
}

function normalizePublisher(
  publisher: CatalogPublisher | null | undefined,
  baseUrl: string | null,
): CatalogPublisher | null {
  if (!publisher || typeof publisher !== "object") {
    return null;
  }

  const name = nullIfBlank(publisher.name);
  const url = resolveHttpUrl(publisher.url, baseUrl);
  const email = nullIfBlank(publisher.email);
  return name === null && url === null && email === null ? null : { name, url, email };
}

function validateFeedsDocument(document: AppFeedsDocument | null, expectedAppId: string): string | null {
  if (!document) {
    return "The feed document is not a JSON object.";
  }
  if (document.schemaVersion !== FEEDS_SCHEMA_VERSION) {
    return `The feed document must declare ${FEEDS_SCHEMA_VERSION}.`;
  }
  const appId = nullIfBlank(document.appId);
  if (!appId || !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(appId)) {
    return "The feed appId is invalid.";
  }
  if (appId !== expectedAppId) {
    return `The feed appId must match '${expectedAppId}'.`;
  }
  if (!Array.isArray(document.feeds) || document.feeds.length === 0) {
    return "The feed document must contain at least one feed.";
  }

  const ids = new Set<string>();
  let defaultCount = 0;
  for (const feed of document.feeds) {
    const id = nullIfBlank(feed?.id);
    const manifestRef = resolveHttpUrl(feed?.manifestRef, null);
    if (!id || id.length > 128) {
      return "Every feed needs a non-empty id no longer than 128 characters.";
    }
    if (!manifestRef) {
      return "Every feed needs an absolute HTTP(S) manifestRef without credentials.";
    }
    if (ids.has(id)) {
      return `Feed id '${id}' is duplicated.`;
    }
    ids.add(id);
    defaultCount += feed.default === true ? 1 : 0;
  }

  return defaultCount > 1 ? "At most one feed may be marked as default." : null;
}

function normalizeFeeds(feeds: AppFeedEntry[]): CatalogAppFeed[] {
  return feeds.map(feed => ({
    id: nullIfBlank(feed.id)!,
    manifestRef: resolveHttpUrl(feed.manifestRef, null)!,
    default: feed.default === true,
  }));
}

function diagnostic(
  status: CatalogDiagnostic["status"],
  code: string,
  message: string,
): CatalogDiagnostic {
  return { status, code, message };
}

function parseObject<T>(raw: string): T | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as T : null;
  } catch {
    return null;
  }
}

function nullIfBlank(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeList(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return [...new Set(values.flatMap(value => {
    const normalized = nullIfBlank(value);
    return normalized ? [normalized] : [];
  }))];
}

function resolveHttpUrl(value: unknown, baseUrl: string | null): string | null {
  const candidate = nullIfBlank(value);
  if (!candidate) {
    return null;
  }

  try {
    const url = baseUrl ? new URL(candidate, baseUrl) : new URL(candidate);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
