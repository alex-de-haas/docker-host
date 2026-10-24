import { CatalogService } from "@/lib/catalog-service";
import { HttpCatalogDocumentFetcher } from "@/lib/fetcher";
import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { optionsFromEnvironment, readHttpUrl, type MarketplaceOptions } from "@/lib/options";

export type MarketplaceRuntime = {
  options: MarketplaceOptions;
  catalog: CatalogService;
};

// Runtime creation stays lazy so `next build` never requires Hosty-injected settings or performs a
// network request. globalThis preserves the fetch cache through Next.js development module reloads.
const globalKey = Symbol.for("hosty.marketplace.runtime.v2");
type RuntimeHolder = { [globalKey]?: MarketplaceRuntime };

export function getRuntime(): MarketplaceRuntime {
  const holder = globalThis as RuntimeHolder;
  holder[globalKey] ??= createRuntime();
  return holder[globalKey];
}

function createRuntime(): MarketplaceRuntime {
  const options = readSettings();
  return {
    options,
    catalog: new CatalogService(options.sourceUrl, new HttpCatalogDocumentFetcher()),
  };
}

const defaultSource = "https://alex-de-haas.github.io/hosty-catalog/catalog.json";
function settingsPath() { return join(process.env.HOSTY_APP_DATA_DIR || "/var/lib/hosty-marketplace", "settings.json"); }
function readSettings(): MarketplaceOptions {
  try {
    const value = JSON.parse(readFileSync(settingsPath(), "utf8"));
    const sourceUrl = readHttpUrl(value.sourceUrl);
    if (!sourceUrl) throw new Error("Marketplace settings are invalid. Restore settings.json before starting.");
    return { sourceUrl };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const options = { sourceUrl: optionsFromEnvironment().sourceUrl || defaultSource };
    persistSettings(options); return options;
  }
}
function persistSettings(options: MarketplaceOptions) {
  const path = settingsPath();
  mkdirSync(join(path, ".."), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(options, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, path);
}
export class MarketplaceSettingsConflictError extends Error {
  readonly code = "settings_conflict";
  constructor() { super("Settings changed. Reload the current settings before saving again."); }
}

export function updateMarketplaceSettings(sourceUrl: string, expectedSourceUrl: string): MarketplaceOptions {
  const runtime = getRuntime();
  if (runtime.options.sourceUrl !== expectedSourceUrl) throw new MarketplaceSettingsConflictError();
  const normalized = readHttpUrl(sourceUrl);
  if (!normalized) throw new Error("Enter an HTTP(S) catalog address without credentials.");
  const options = { sourceUrl: normalized };
  persistSettings(options);
  runtime.options = options;
  runtime.catalog = new CatalogService(options.sourceUrl, new HttpCatalogDocumentFetcher());
  return options;
}
