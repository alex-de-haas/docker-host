import { promises as fs } from "node:fs";
import path from "node:path";
import { MarketplaceError } from "@/lib/errors";
import type { MarketplaceOptions } from "@/lib/options";
import type { CatalogSource, CatalogSourceStore } from "@/lib/source-store";
import type { CatalogSourcesResponse } from "@/lib/catalog-types";
import { deriveSourceName } from "@/lib/catalog-service";

// One effective source: the operator-facing identity plus where the document is actually read from
// (identical for http(s) and container-local paths; the app-data snapshot for imported local sources).
export type ResolvedCatalogSource = {
  url: string;
  fetchLocation: string;
};

// Operator management of catalog sources, moved out of Core (WS7 federation semantics preserved).
// The effective list is the operator's stored list once materialized; before that it falls back to
// the one-time bootstrap handoff Core wrote during migration, then to the env seed — so mutations
// grow from whichever seed was in effect and the defaults survive the first private tap.
export class CatalogSourceService {
  // Serializes read-modify-write so concurrent add/remove don't clobber each other.
  private mutationChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: CatalogSourceStore,
    private readonly options: MarketplaceOptions,
  ) {}

  // The sources the catalog is currently served from, resolved to fetchable locations. `url` stays
  // the operator-facing identity; a snapshot-imported local source fetches from its app-data copy.
  async getEffectiveSources(): Promise<ResolvedCatalogSource[]> {
    const sources = await this.readEffectiveSources();
    return Promise.all(sources.map(source => this.resolve(source)));
  }

  async list(): Promise<CatalogSourcesResponse> {
    const state = await this.store.read();
    const sources = state === null ? await this.readEffectiveSources() : state.sources;
    return buildResponse(sources, state !== null);
  }

  add(url: string | null | undefined): Promise<CatalogSourcesResponse> {
    return this.mutate(async () => {
      const normalized = normalizeAndValidate(url);
      const current = await this.readEffectiveSources();
      if (current.some(existing => urlEquals(existing.url, normalized))) {
        throw new MarketplaceError("catalog_source_exists", `Catalog source '${normalized}' is already configured.`);
      }

      const updated = [...current, { url: normalized }];
      await this.store.write({ schemaVersion: 1, sources: updated });
      return buildResponse(updated, true);
    });
  }

  remove(url: string | null | undefined): Promise<CatalogSourcesResponse> {
    return this.mutate(async () => {
      // Validate the same way as add so a malformed URL/path is a 400 (catalog_source_invalid),
      // not a misleading 404 — consistent with the documented error contract.
      const target = normalizeAndValidate(url);
      const current = await this.readEffectiveSources();
      const updated = current.filter(existing => !urlEquals(existing.url, target));
      if (updated.length === current.length) {
        throw new MarketplaceError("catalog_source_not_found", `Catalog source '${target}' is not configured.`);
      }

      await this.store.write({ schemaVersion: 1, sources: updated });
      return buildResponse(updated, true);
    });
  }

  // Stored state once materialized, otherwise the bootstrap handoff, otherwise the env seed. The
  // handoff and env lists are seeds: reading them never materializes state or marks it managed.
  private async readEffectiveSources(): Promise<CatalogSource[]> {
    const state = await this.store.read();
    if (state !== null) {
      return state.sources;
    }

    const bootstrap = await this.store.readBootstrap();
    if (bootstrap !== null) {
      return bootstrap.sources;
    }

    return this.options.seedSources.map(url => ({ url }));
  }

  // A snapshot-imported source fetches from its app-data copy; the import path must stay inside the
  // data directory (the handoff file is Core-written, but a hand-edited one must not become a read
  // primitive for arbitrary container paths). Containment is checked on symlink-resolved paths, so
  // neither `..` segments nor a planted symlink inside the data directory can escape it.
  private async resolve(source: CatalogSource): Promise<ResolvedCatalogSource> {
    const importPath = source.importPath?.trim();
    if (!importPath) {
      return { url: source.url, fetchLocation: source.url };
    }

    const dataRoot = await fs
      .realpath(path.resolve(this.options.dataDirectory))
      .catch(() => path.resolve(this.options.dataDirectory));
    const canonical = await fs
      .realpath(path.resolve(dataRoot, importPath))
      .catch(() => path.resolve(dataRoot, importPath));
    const relative = path.relative(dataRoot, canonical);
    const contained = relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
    return contained
      ? { url: source.url, fetchLocation: canonical }
      : { url: source.url, fetchLocation: source.url };
  }

  // Chains mutations behind one promise so interleaved awaits cannot clobber each other's
  // read-modify-write, while errors still propagate to the caller that queued the mutation.
  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(action, action);
    this.mutationChain = result.catch(() => undefined);
    return result;
  }
}

function buildResponse(sources: CatalogSource[], managed: boolean): CatalogSourcesResponse {
  return {
    sources: sources.map(source => ({ url: source.url, name: deriveSourceName(source.url) })),
    managed,
  };
}

// Same rules as Core's launch-setting validation: an absolute http(s) URL without credentials, or an
// already-absolute local path.
function normalizeAndValidate(url: string | null | undefined): string {
  const value = url?.trim() ?? "";
  if (!value) {
    throw new MarketplaceError("catalog_source_invalid", "Catalog source cannot be empty.");
  }

  const parsed = tryParseUrl(value);
  if (parsed && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
    if (parsed.username || parsed.password) {
      throw new MarketplaceError("catalog_source_invalid", "Catalog source URL must not include credentials.");
    }

    return value;
  }

  if (value.includes("://")) {
    throw new MarketplaceError("catalog_source_invalid", "Catalog source URL must use http or https.");
  }

  if (!path.isAbsolute(value)) {
    throw new MarketplaceError("catalog_source_invalid", "Catalog source must be an absolute path or an http(s) URL.");
  }

  return value;
}

// Dedup/lookup equality. For http(s) URLs, compare normalized (scheme/host casing and default ports
// fold via the URL parser); for local paths stay exact — Unix paths are case-sensitive, so folding
// case there would wrongly treat distinct paths as the same source.
function urlEquals(left: string, right: string): boolean {
  const l = left.trim();
  const r = right.trim();
  const leftUrl = tryParseUrl(l);
  const rightUrl = tryParseUrl(r);
  if (leftUrl && rightUrl && (leftUrl.protocol === "http:" || leftUrl.protocol === "https:")) {
    return leftUrl.href === rightUrl.href;
  }

  return l === r;
}

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
