"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, LoaderCircle, Package, RefreshCw, Search, Store } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { getCatalogApps } from "../catalog-api";
import { CatalogAppDetailsDialog } from "../dialogs/catalog-app-details-dialog";
import type { CatalogAppSummary, CatalogListState } from "../types";
import { EmptyState, PageHeader } from "../ui";

// The marketplace storefront: a discovery layer over the configured catalog sources. Browsing and
// install both go through Core's existing reviewed flow — a card opens the app detail, and installing a
// version hands its manifestRef to the install dialog. Optional/non-intrusive: an empty catalog (no
// sources configured) simply shows an empty state.
export function MarketplacePage({ coreOrigin, onInstall }: { coreOrigin: string; onInstall: (manifestRef: string) => void }) {
  const [state, setState] = useState<CatalogListState>({ loading: true, error: null, apps: [] });
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // No synchronous setState here: `load` only writes state after the fetch resolves (the initial
  // `loading: true` comes from the initial state), so calling it from the mount effect does not trigger
  // a cascading render. An AbortSignal cancels an in-flight fetch so a stale response can't overwrite a
  // newer one (or a fetch after unmount). The Refresh button flips `loading` in its own click handler.
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await getCatalogApps(coreOrigin, signal);
      setState({ loading: false, error: null, apps: data.apps ?? [] });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      setState({ loading: false, error: error instanceof Error ? error.message : "Failed to load the catalog.", apps: [] });
    }
  }, [coreOrigin]);

  const refresh = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState((current) => ({ ...current, loading: true, error: null }));
    void load(controller.signal);
  }, [load]);

  // Defer the initial fetch to a macrotask so the setState lands outside the effect's synchronous body
  // (the same pattern the observability pages use for their loads); abort it on unmount/reload.
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    const handle = setTimeout(() => void load(controller.signal), 0);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [load]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const app of state.apps) {
      if (app.category) {
        set.add(app.category);
      }
    }
    return [...set].sort((left, right) => left.localeCompare(right));
  }, [state.apps]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return state.apps.filter((app) => {
      if (category && app.category !== category) {
        return false;
      }
      if (!needle) {
        return true;
      }
      return (
        app.name.toLowerCase().includes(needle) ||
        app.id.toLowerCase().includes(needle) ||
        (app.summary?.toLowerCase().includes(needle) ?? false) ||
        (app.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))
      );
    });
  }, [state.apps, query, category]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Marketplace"
        description="Discover and install runtime apps from the configured catalog sources."
        actions={
          <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={state.loading}>
            {state.loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
        }
      />

      {state.error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{state.error}</div>
      )}

      {state.apps.length > 0 && (
        <div className="space-y-3">
          <div className="relative max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search apps" className="pl-8" />
          </div>
          {categories.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              <CategoryChip label="All" active={category === null} onClick={() => setCategory(null)} />
              {categories.map((name) => (
                <CategoryChip key={name} label={name} active={category === name} onClick={() => setCategory(name)} />
              ))}
            </div>
          )}
        </div>
      )}

      {state.loading && state.apps.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : state.apps.length === 0 ? (
        <EmptyState
          icon={Store}
          title="No catalog apps"
          description="No marketplace source is configured, or the configured sources are empty. Set HOSTY_CATALOG_SOURCES on Core to add one."
        />
      ) : filtered.length === 0 ? (
        <EmptyState icon={Search} title="No matches" description="No catalog app matches the current search or category." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((app) => (
            <MarketplaceCard key={app.id} app={app} onOpen={() => setSelectedId(app.id)} />
          ))}
        </div>
      )}

      {selectedId && (
        <CatalogAppDetailsDialog
          key={selectedId}
          coreOrigin={coreOrigin}
          appId={selectedId}
          onClose={() => setSelectedId(null)}
          onInstall={onInstall}
        />
      )}
    </div>
  );
}

function MarketplaceCard({ app, onOpen }: { app: CatalogAppSummary; onOpen: () => void }) {
  return (
    <div className="flex flex-col rounded-lg border bg-card p-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
          {app.icon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={app.icon} alt="" className="size-6 object-contain" />
          ) : (
            <Package className="h-5 w-5" />
          )}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="truncate text-base font-semibold">{app.name}</h2>
          <p className="truncate text-xs text-muted-foreground">{app.publisher?.name || app.id}</p>
        </div>
        {app.installed && (
          <Badge variant="outline" className="gap-1 border-transparent bg-emerald-500/10 text-emerald-700">
            <CheckCircle2 className="h-3 w-3" />
            Installed
          </Badge>
        )}
      </div>

      {app.summary && <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">{app.summary}</p>}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {app.category && <Badge variant="secondary">{app.category}</Badge>}
        {(app.tags ?? []).slice(0, 3).map((tag) => (
          <Badge key={tag} variant="outline">
            {tag}
          </Badge>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <Button type="button" size="sm" onClick={onOpen}>
          Details
        </Button>
      </div>
    </div>
  );
}

function CategoryChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-xs transition-colors",
        active ? "border-transparent bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
      )}
    >
      {label}
    </button>
  );
}
