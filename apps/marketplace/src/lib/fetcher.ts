import { promises as fs } from "node:fs";

// Fetches a catalog document (index or feed) by URL or local path, returning its raw JSON or null on
// any failure. Abstracted so the catalog service's parse/merge logic is unit-tested without network
// or disk.
export type CatalogDocumentFetcher = {
  fetch(source: string): Promise<string | null>;
};

const MAX_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_TTL_MS = 60_000;

type CacheEntry = {
  document: string | null;
  expiry: number;
};

type Logger = (message: string) => void;

// Real fetcher: http/https GET or local-file read, size-capped, with a small per-URL TTL cache so a
// storefront list does not re-fetch the index on each request. Best-effort — any transport/format
// failure yields null so an unreachable source degrades to "no data", never an error. Every failure
// is logged (the null cache bounds that to once per TTL per URL): an empty marketplace must stay
// diagnosable, since the storefront itself surfaces nothing.
//
// Local absolute paths resolve inside THIS app's filesystem. Under docker that is the container, so
// host-path sources configured before the extraction only keep working via an explicit Core-owned
// import into app data (docs/ideas/marketplace-system-app.md, "Host filesystem exposure").
export class HttpCatalogDocumentFetcher implements CatalogDocumentFetcher {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly log: Logger = message => console.warn(message),
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  async fetch(source: string): Promise<string | null> {
    // Normalize once so the cache lookup, the fetch, and the cache store all key on the same string
    // (otherwise the same URL with stray whitespace produces duplicate entries / spurious misses).
    const key = source.trim();
    if (!key) {
      return null;
    }

    const cached = this.cache.get(key);
    const now = this.now();
    if (cached && cached.expiry > now) {
      return cached.document;
    }

    const document = await this.fetchRaw(key);
    this.cache.set(key, { document, expiry: now + this.ttlMs });
    return document;
  }

  private async fetchRaw(source: string): Promise<string | null> {
    try {
      if (/^https?:\/\//i.test(source)) {
        const response = await fetch(source, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!response.ok) {
          this.log(`Catalog document fetch for '${source}' returned HTTP ${response.status}.`);
          return null;
        }

        const declaredLength = Number(response.headers.get("content-length") ?? "0");
        if (declaredLength > MAX_BYTES) {
          this.log(`Catalog document at '${source}' exceeds the ${MAX_BYTES}-byte cap.`);
          return null;
        }

        // Stream and enforce the cap while reading: a source that omits Content-Length (or uses
        // chunked encoding) would otherwise let text() buffer an unbounded body (DoS).
        const text = await readCappedText(response);
        if (text === null) {
          this.log(`Catalog document at '${source}' exceeds the ${MAX_BYTES}-byte cap.`);
        }

        return text;
      }

      const path = source.startsWith("file://") ? new URL(source) : source;
      const info = await fs.stat(path).catch(() => null);
      if (info === null || !info.isFile()) {
        this.log(`Catalog document was not found at '${source}'.`);
        return null;
      }

      if (info.size > MAX_BYTES) {
        this.log(`Catalog document at '${source}' exceeds the ${MAX_BYTES}-byte cap.`);
        return null;
      }

      return await fs.readFile(path, "utf8");
    } catch (error) {
      // The message matters here: transport failures include host-level causes an operator can't
      // otherwise see (DNS, TLS, fd exhaustion — the latter observed live rendering the marketplace
      // silently empty).
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Catalog document fetch for '${source}' failed: ${message}`);
      return null;
    }
  }
}

// Reads a response body into text, returning null as soon as it would exceed MAX_BYTES so an
// unbounded or Content-Length-less response cannot exhaust memory.
async function readCappedText(response: Response): Promise<string | null> {
  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      return null;
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks).toString("utf8");
}
