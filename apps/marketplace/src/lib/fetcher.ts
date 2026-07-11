import { resolvesToPrivateHost } from "@/lib/private-host";

export type CatalogDocumentFetcher = {
  // `blockPrivateHosts` is set for untrusted catalog-entry URLs (feedsUrl/descriptionUrl): the host
  // is rejected when it resolves to a non-public address, and redirects are not followed.
  fetch(source: string, options?: { refresh?: boolean; blockPrivateHosts?: boolean }): Promise<string | null>;
};

const MAX_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_TTL_MS = 60_000;

type CacheEntry = {
  document: string | null;
  expiry: number;
};

type Logger = (message: string) => void;

// All Marketplace inputs are remote documents. Fetches are bounded, cached briefly, and best-effort:
// CatalogService converts null into a user-visible diagnostic rather than an opaque server error.
export class HttpCatalogDocumentFetcher implements CatalogDocumentFetcher {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly log: Logger = message => console.warn(message),
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  async fetch(source: string, options: { refresh?: boolean; blockPrivateHosts?: boolean } = {}): Promise<string | null> {
    const key = normalizeHttpUrl(source);
    if (!key) {
      this.log(`Marketplace document source '${source}' is not an HTTP(S) URL.`);
      return null;
    }

    const now = this.now();
    const cached = this.cache.get(key);
    if (!options.refresh && cached && cached.expiry > now) {
      return cached.document;
    }

    const document = await this.fetchRaw(key, options.blockPrivateHosts === true);
    this.cache.set(key, { document, expiry: now + this.ttlMs });
    return document;
  }

  private async fetchRaw(source: string, blockPrivateHosts: boolean): Promise<string | null> {
    try {
      if (blockPrivateHosts && (await resolvesToPrivateHost(new URL(source).hostname))) {
        this.log(`Marketplace document fetch for '${source}' was blocked: host resolves to a non-public address.`);
        return null;
      }

      const response = await fetch(source, {
        headers: { Accept: "application/json, text/plain;q=0.9" },
        // Untrusted entry URLs must not be redirected to an internal host; a redirect becomes a
        // non-ok/opaque response and is treated as a fetch failure below.
        redirect: blockPrivateHosts ? "manual" : "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.log(`Marketplace document fetch for '${source}' returned HTTP ${response.status}.`);
        return null;
      }

      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (declaredLength > MAX_BYTES) {
        this.log(`Marketplace document at '${source}' exceeds the ${MAX_BYTES}-byte cap.`);
        return null;
      }

      const text = await readCappedText(response);
      if (text === null) {
        this.log(`Marketplace document at '${source}' exceeds the ${MAX_BYTES}-byte cap.`);
      }

      return text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Marketplace document fetch for '${source}' failed: ${message}`);
      return null;
    }
  }
}

function normalizeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

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
