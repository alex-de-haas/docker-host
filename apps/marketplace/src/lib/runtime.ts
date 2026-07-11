import { CatalogService } from "@/lib/catalog-service";
import { HttpCatalogDocumentFetcher } from "@/lib/fetcher";
import { optionsFromEnvironment, type MarketplaceOptions } from "@/lib/options";
import { CatalogSourceService } from "@/lib/source-service";
import { CatalogSourceStore } from "@/lib/source-store";

export type MarketplaceRuntime = {
  options: MarketplaceOptions;
  catalog: CatalogService;
  sources: CatalogSourceService;
};

// Per-process singletons for the route handlers: the fetcher's TTL cache and the source service's
// mutation chain must be shared across requests. Stored on globalThis so Next's dev-mode module
// reloads reuse one instance instead of resetting state per recompile.
const globalKey = Symbol.for("hosty.marketplace.runtime");

type RuntimeHolder = { [globalKey]?: MarketplaceRuntime };

export function getRuntime(): MarketplaceRuntime {
  const holder = globalThis as RuntimeHolder;
  holder[globalKey] ??= createRuntime();
  return holder[globalKey];
}

function createRuntime(): MarketplaceRuntime {
  const options = optionsFromEnvironment();
  const store = new CatalogSourceStore(options);
  const sources = new CatalogSourceService(store, options);
  const catalog = new CatalogService(sources, new HttpCatalogDocumentFetcher());
  return { options, catalog, sources };
}
