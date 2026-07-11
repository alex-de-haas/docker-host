import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import type { MarketplaceOptions } from "@/lib/options";

export const STATE_FILE_NAME = "catalog-sources.json";

// One-time source handoff written by Core's bootstrap import, only while this store has never
// materialized its own state. It is a SEED, not state: reading it never marks the list managed, and
// it is never written by this app.
export const BOOTSTRAP_FILE_NAME = "bootstrap-sources.json";

// Persisted source-list schema. `url` is the operator-facing identity (an http(s) URL or the
// original absolute path the operator configured); `importPath` is set only for local sources that
// were snapshot-imported into app data, and holds the data-dir-relative location actually fetched.
export type CatalogSourceState = {
  schemaVersion: number;
  sources: CatalogSource[];
};

export type CatalogSource = {
  url: string;
  importPath?: string | null;
};

// Persistent catalog-source list under this app's data directory. Absent until the first operator
// mutation materializes it; until then the effective list falls back to the bootstrap handoff, then
// to the env seed (see source-service.ts). Writes are atomic (unique temp file + rename) so a crash
// can never leave a half-written state file, and the file is owner-restricted best-effort.
export class CatalogSourceStore {
  constructor(private readonly options: MarketplaceOptions) {}

  // Null when the store has never been materialized — the caller then falls back to the bootstrap
  // handoff or env seed. A present-but-empty list means the operator deliberately cleared every source.
  read(): Promise<CatalogSourceState | null> {
    return readStateFile(path.join(this.options.dataDirectory, STATE_FILE_NAME));
  }

  readBootstrap(): Promise<CatalogSourceState | null> {
    return readStateFile(path.join(this.options.dataDirectory, BOOTSTRAP_FILE_NAME));
  }

  async write(state: CatalogSourceState): Promise<void> {
    await fs.mkdir(this.options.dataDirectory, { recursive: true });
    const statePath = path.join(this.options.dataDirectory, STATE_FILE_NAME);
    const tempPath = `${statePath}.${crypto.randomUUID().replaceAll("-", "")}.tmp`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(state), { mode: 0o600 });
      await fs.rename(tempPath, statePath);
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

async function readStateFile(filePath: string): Promise<CatalogSourceState | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    // Missing or unreadable state must degrade to the next seed in line (null), never 500 the
    // best-effort storefront read.
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const state = parsed as { schemaVersion?: unknown; sources?: unknown };
    const sources = Array.isArray(state.sources)
      ? state.sources.flatMap((entry): CatalogSource[] => {
          if (entry === null || typeof entry !== "object") {
            return [];
          }

          const candidate = entry as { url?: unknown; importPath?: unknown };
          if (typeof candidate.url !== "string" || !candidate.url.trim()) {
            return [];
          }

          return [
            {
              url: candidate.url,
              importPath: typeof candidate.importPath === "string" ? candidate.importPath : null,
            },
          ];
        })
      : [];

    return {
      schemaVersion: typeof state.schemaVersion === "number" ? state.schemaVersion : 1,
      sources,
    };
  } catch {
    // A corrupt/hand-edited file degrades the same way as an absent one.
    return null;
  }
}
