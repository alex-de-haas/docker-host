import path from "node:path";
import {
  CATALOG_SCHEMA_VERSION,
  type CatalogAppDetailResponse,
  type CatalogAppEntry,
  type CatalogAppFeed,
  type CatalogAppSummary,
  type CatalogAppsResponse,
  type CatalogIndex,
  type CatalogPublisher,
} from "@/lib/catalog-types";
import type { CatalogDocumentFetcher } from "@/lib/fetcher";
import type { CatalogSourceService, ResolvedCatalogSource } from "@/lib/source-service";

type Logger = (message: string) => void;

type LocatedEntry = {
  entry: CatalogAppEntry & { id: string };
  sourceName: string;
};

// Reads the configured catalog sources and serves the storefront data. A discovery/trust index over
// existing transport: it never installs anything — clients take a feed's `manifestRef` and drive
// Core's existing reviewed install/update. Sources are merged by priority (first configured source
// wins an id conflict). Optional and non-intrusive: no sources configured => an empty catalog.
//
// Unlike the pre-extraction Core implementation, responses carry NO installed/update projections:
// those are Core facts, joined by clients against Core's own APIs (marketplace-system-app.md,
// Target Boundary).
export class CatalogService {
  constructor(
    private readonly sourceService: CatalogSourceService,
    private readonly fetcher: CatalogDocumentFetcher,
    private readonly log: Logger = message => console.warn(message),
  ) {}

  async getApps(): Promise<CatalogAppsResponse> {
    const entries = await this.loadMergedEntries();
    const summaries: CatalogAppSummary[] = [...entries.values()].map(({ entry, sourceName }) => ({
      id: entry.id,
      name: resolveName(entry),
      summary: nullIfBlank(entry.display?.summary),
      category: nullIfBlank(entry.category),
      tags: normalizeList(entry.tags),
      icon: nullIfBlank(entry.display?.icon),
      publisher: normalizePublisher(entry.publisher),
      sourceName,
    }));

    summaries.sort((left, right) => left.name.toLowerCase().localeCompare(right.name.toLowerCase()));
    return { apps: summaries };
  }

  // Returns the detail for one catalog app, or null when no configured source lists that id (404).
  async getApp(id: string): Promise<CatalogAppDetailResponse | null> {
    const trimmed = id.trim();
    if (!trimmed) {
      return null;
    }

    const entries = await this.loadMergedEntries();
    const located = entries.get(trimmed.toLowerCase());
    if (!located) {
      return null;
    }

    const { entry, sourceName } = located;
    return {
      id: entry.id,
      name: resolveName(entry),
      summary: nullIfBlank(entry.display?.summary),
      category: nullIfBlank(entry.category),
      tags: normalizeList(entry.tags),
      icon: nullIfBlank(entry.display?.icon),
      screenshots: normalizeList(entry.display?.screenshots),
      publisher: normalizePublisher(entry.publisher),
      sourceName,
      signerIdentity: nullIfBlank(entry.signerIdentity),
      feeds: this.resolveFeeds(entry),
      descriptionUrl: nullIfBlank(entry.display?.descriptionUrl),
    };
  }

  // Merge every configured source's index into an id-keyed map, first source wins an id conflict.
  // App ids are lowercase by contract, but match case-insensitively so a catalog entry authored with
  // different casing still de-dupes across sources.
  private async loadMergedEntries(): Promise<Map<string, LocatedEntry>> {
    const merged = new Map<string, LocatedEntry>();
    const sources = await this.sourceService.getEffectiveSources();
    for (const source of sources) {
      const index = await this.loadIndex(source);
      if (index === null) {
        continue;
      }

      const sourceName = nullIfBlank(index.source?.name) ?? deriveSourceName(source.url);
      // Fetched documents are untrusted: the TS types don't exist at runtime, so a malformed `apps`
      // (or any nested field) must degrade like the C# typed deserialization did — skip, not crash.
      const entries = Array.isArray(index.apps) ? index.apps : [];
      for (const entry of entries) {
        const id = nullIfBlank(entry?.id);
        if (id === null) {
          continue;
        }

        const key = id.toLowerCase();
        if (merged.has(key)) {
          this.log(`Catalog id conflict: '${id}' from source '${sourceName}' is shadowed by a higher-priority source.`);
          continue;
        }

        merged.set(key, { entry: { ...entry, id }, sourceName });
      }
    }

    return merged;
  }

  private async loadIndex(source: ResolvedCatalogSource): Promise<CatalogIndex | null> {
    const raw = await this.fetcher.fetch(source.fetchLocation);
    if (raw === null) {
      return null;
    }

    let index: CatalogIndex;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        this.log(`Catalog source '${source.url}' returned a non-object document.`);
        return null;
      }

      index = parsed as CatalogIndex;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Catalog source '${source.url}' returned invalid JSON: ${message}`);
      return null;
    }

    // Reject an unsupported/absent schema version rather than silently accept a document of an
    // unknown shape (parity with Core's strict manifest schemaVersion check).
    if (index.schemaVersion !== CATALOG_SCHEMA_VERSION) {
      this.log(
        `Catalog source '${source.url}' declares unsupported schemaVersion '${index.schemaVersion ?? "(none)"}'; expected '${CATALOG_SCHEMA_VERSION}'.`,
      );
      return null;
    }

    return index;
  }

  // Normalizes an entry's declared feeds for the detail response: blank ids/refs are dropped, and
  // `default` is resolved to what quick-install needs — the explicitly flagged feed, or the sole
  // one. Publish-time validation enforces "at most one default", but a hand-crafted index could
  // still flag several; normalization keeps the first and logs, mirroring the id-conflict handling.
  private resolveFeeds(entry: CatalogAppEntry & { id: string }): CatalogAppFeed[] {
    const result: CatalogAppFeed[] = [];
    let sawDefault = false;
    const feeds = Array.isArray(entry.feeds) ? entry.feeds : [];
    for (const feed of feeds) {
      const id = nullIfBlank(feed?.id);
      const manifestRef = nullIfBlank(feed?.manifestRef);
      if (id === null || manifestRef === null) {
        continue;
      }

      let isDefault = feed.default === true;
      if (isDefault && sawDefault) {
        this.log(`Catalog entry '${entry.id}' flags more than one default feed; keeping the first.`);
        isDefault = false;
      }

      sawDefault ||= isDefault;
      result.push({ id, manifestRef, default: isDefault });
    }

    // A sole feed is the de-facto default even without the flag, so clients need no special case.
    if (result.length === 1 && !result[0].default) {
      result[0] = { ...result[0], default: true };
    }

    return result;
  }
}

// "https://raw.githubusercontent.com/org/hosty-catalog/…" -> "raw.githubusercontent.com"; a local
// path -> its file name. Cosmetic source label for federation legibility. Shared with the source
// service so the sources list and the storefront cards derive the same name.
export function deriveSourceName(source: string): string {
  try {
    const url = new URL(source);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.hostname;
    }
  } catch {
    // Not a URL: fall through to the path-derived name.
  }

  const name = path.basename(source.replace(/[/\\]+$/, ""));
  return name || source;
}

function resolveName(entry: CatalogAppEntry & { id: string }): string {
  return nullIfBlank(entry.name) ?? entry.id;
}

function normalizePublisher(publisher: CatalogPublisher | null | undefined): CatalogPublisher | null {
  if (!publisher) {
    return null;
  }

  const name = nullIfBlank(publisher.name);
  const url = nullIfBlank(publisher.url);
  const email = nullIfBlank(publisher.email);
  return name === null && url === null && email === null ? null : { name, url, email };
}

// `unknown` because values come from untrusted fetched JSON: a number/object where a string was
// expected must normalize to null, not throw mid-aggregation.
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

  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = nullIfBlank(value);
    if (trimmed !== null && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }

  return result;
}
