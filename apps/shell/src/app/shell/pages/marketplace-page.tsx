"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { CheckCircle2, Download, LoaderCircle, Package, RefreshCw, Search, Settings2, Store } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { getCatalogApp, getCatalogApps } from "../catalog-api";
import { CatalogAppDetailsDialog } from "../dialogs/catalog-app-details-dialog";
import { MarketplaceSourcesDialog } from "../dialogs/marketplace-sources-dialog";
import type { CatalogAppDetail, CatalogAppSummary, CatalogAppVersion, CatalogListState } from "../types";
import { EmptyState, PageHeader } from "../ui";

type SendCsrfJson = (endpoint: string, body?: unknown, method?: string) => Promise<Response>;

// The marketplace storefront: a discovery layer over the configured catalog sources. Browsing and
// install both go through Core's existing reviewed flow — a card opens the app detail, and installing a
// version hands its manifestRef to the install dialog. Optional/non-intrusive: an empty catalog (no
// sources configured) simply shows an empty state.
export function MarketplacePage({
  coreOrigin,
  onInstall,
  sendCsrfJson,
}: {
  coreOrigin: string;
  onInstall: (manifestRef: string) => void;
  sendCsrfJson: SendCsrfJson;
}) {
  const [state, setState] = useState<CatalogListState>({ loading: true, error: null, apps: [] });
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);

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
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setSourcesOpen(true)}>
              <Settings2 className="h-4 w-4" />
              Sources
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={state.loading}>
              {state.loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
          </div>
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
          description="No marketplace source is configured, or the configured sources are empty. Use Sources to add one."
        />
      ) : filtered.length === 0 ? (
        <EmptyState icon={Search} title="No matches" description="No catalog app matches the current search or category." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((app) => (
            <MarketplaceCard key={app.id} app={app} coreOrigin={coreOrigin} onOpen={() => setSelectedId(app.id)} onInstall={onInstall} />
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

      <MarketplaceSourcesDialog
        open={sourcesOpen}
        coreOrigin={coreOrigin}
        sendCsrfJson={sendCsrfJson}
        onClose={() => setSourcesOpen(false)}
        onChanged={refresh}
      />
    </div>
  );
}

type MarketplaceCardBadge = {
  label: string;
  variant: "secondary" | "outline";
};

function MarketplaceCard({
  app,
  coreOrigin,
  onOpen,
  onInstall,
}: {
  app: CatalogAppSummary;
  coreOrigin: string;
  onOpen: () => void;
  onInstall: (manifestRef: string) => void;
}) {
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  const startInstall = useCallback(async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      const detail = await getCatalogApp(coreOrigin, app.id);
      const version = selectInstallVersion(detail);
      if (!version) {
        throw new Error("No installable release is published for this app.");
      }

      onInstall(version.manifestRef);
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : "Install review is unavailable.");
    } finally {
      setInstalling(false);
    }
  }, [app.id, coreOrigin, onInstall]);

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

      <MarketplaceCardBadges category={app.category} tags={app.tags ?? []} />

      <div className="mt-4 flex items-center gap-2">
        <Button type="button" size="sm" onClick={onOpen}>
          Details
        </Button>
        {!app.installed && (
          <Button type="button" size="sm" variant="outline" onClick={startInstall} disabled={installing}>
            {installing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Install
          </Button>
        )}
      </div>
      {installError && <p className="mt-2 text-xs text-destructive">{installError}</p>}
    </div>
  );
}

function MarketplaceCardBadges({ category, tags }: { category?: string | null; tags: string[] }) {
  const items = useMemo<MarketplaceCardBadge[]>(() => {
    const badges: MarketplaceCardBadge[] = [];
    if (category) {
      badges.push({ label: category, variant: "secondary" });
    }
    for (const tag of tags) {
      badges.push({ label: tag, variant: "outline" });
    }
    return badges;
  }, [category, tags]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const measuringRef = useRef<HTMLDivElement | null>(null);
  const moreMeasureRef = useRef<HTMLSpanElement | null>(null);
  const badgeRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const [visibleCount, setVisibleCount] = useState(items.length);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowTooltipId = useId();

  useEffect(() => {
    if (items.length === 0) {
      return;
    }

    const calculateVisibleCount = () => {
      const container = containerRef.current;
      const measuring = measuringRef.current;
      const more = moreMeasureRef.current;
      if (!container || !measuring || !more) {
        return;
      }

      const containerWidth = container.getBoundingClientRect().width;
      const gap = Number.parseFloat(getComputedStyle(measuring).columnGap || "0") || 0;
      const widths = items.map((_, index) => badgeRefs.current[index]?.getBoundingClientRect().width ?? 0);
      const totalBadgesWidth = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1);
      if (totalBadgesWidth <= containerWidth) {
        setVisibleCount((current) => (current === items.length ? current : items.length));
        return;
      }

      const moreWidth = more.getBoundingClientRect().width;
      let visible = 0;
      for (let count = items.length - 1; count >= 0; count -= 1) {
        const visibleWidth = widths.slice(0, count).reduce((sum, width) => sum + width, 0);
        const gaps = count > 0 ? gap * count : 0;
        const candidateWidth = visibleWidth + gaps + moreWidth;
        if (candidateWidth <= containerWidth) {
          visible = count;
          break;
        }
      }

      setVisibleCount((current) => (current === visible ? current : visible));
    };

    calculateVisibleCount();
    const observer = new ResizeObserver(calculateVisibleCount);
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    window.addEventListener("resize", calculateVisibleCount);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", calculateVisibleCount);
    };
  }, [items]);

  if (items.length === 0) {
    return null;
  }

  const visible = items.slice(0, visibleCount);
  const hidden = items.slice(visibleCount);

  return (
    <div className="relative mt-3">
      <div ref={containerRef} className="flex min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden">
        {visible.map((item, index) => (
          <MarketplaceTagBadge key={`${item.label}-${index}`} item={item} />
        ))}
        {hidden.length > 0 && (
          <span
            tabIndex={0}
            aria-describedby={overflowOpen ? overflowTooltipId : undefined}
            aria-label={`${hidden.length} hidden tag${hidden.length === 1 ? "" : "s"}: ${hidden.map((item) => item.label).join(", ")}`}
            className="inline-flex outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            onBlur={() => setOverflowOpen(false)}
            onFocus={() => setOverflowOpen(true)}
            onMouseEnter={() => setOverflowOpen(true)}
            onMouseLeave={() => setOverflowOpen(false)}
          >
            <Badge variant="outline" className="cursor-default tabular-nums">
              +{hidden.length}
            </Badge>
          </span>
        )}
      </div>

      {hidden.length > 0 && overflowOpen && (
        <div
          id={overflowTooltipId}
          role="tooltip"
          className="absolute bottom-full right-0 z-50 mb-2 max-w-xs rounded-md bg-foreground px-3 py-1.5 text-xs text-background shadow-md"
        >
          <div className="flex max-w-xs flex-wrap gap-1.5">
            {hidden.map((item, index) => (
              <MarketplaceTagBadge key={`${item.label}-${index}`} item={item} tooltip />
            ))}
          </div>
        </div>
      )}

      <div
        ref={measuringRef}
        aria-hidden="true"
        className="pointer-events-none invisible fixed left-0 top-0 flex max-w-none flex-nowrap items-center gap-1.5 whitespace-nowrap"
      >
        {items.map((item, index) => (
          <span key={`${item.label}-${index}`} ref={(node) => { badgeRefs.current[index] = node; }} className="inline-flex">
            <MarketplaceTagBadge item={item} />
          </span>
        ))}
        <span ref={moreMeasureRef} className="inline-flex">
          <Badge variant="outline" className="tabular-nums">
            +{items.length}
          </Badge>
        </span>
      </div>
    </div>
  );
}

function MarketplaceTagBadge({ item, tooltip = false }: { item: MarketplaceCardBadge; tooltip?: boolean }) {
  return (
    <Badge
      variant={item.variant}
      className={cn("max-w-full", tooltip && "border-background/20 bg-background/10 text-background")}
    >
      <span className="min-w-0 truncate">{item.label}</span>
    </Badge>
  );
}

function selectInstallVersion(app: CatalogAppDetail): CatalogAppVersion | null {
  if (!app.versions || app.versions.length === 0) {
    return null;
  }

  if (app.stableVersion) {
    const stable = app.versions.find((version) => version.version === app.stableVersion);
    if (stable) {
      return stable;
    }
  }

  return app.versions[0] ?? null;
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
