import { CatalogService } from "@/lib/catalog-service";
import { HttpCatalogDocumentFetcher } from "@/lib/fetcher";
import { optionsFromEnvironment, type MarketplaceOptions } from "@/lib/options";

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
  const options = optionsFromEnvironment();
  return {
    options,
    catalog: new CatalogService(options.sourceUrl, new HttpCatalogDocumentFetcher()),
  };
}
