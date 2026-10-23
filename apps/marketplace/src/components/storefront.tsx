"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Download, LoaderCircle, Package, RefreshCw, Search, Store, TriangleAlert, Settings, ArrowRight, ArrowLeft, X } from "lucide-react";
import type {
  CatalogAppDetailResponse,
  CatalogAppFeed,
  CatalogAppSummary,
  CatalogAppsResponse,
  CatalogDiagnostic,
} from "@/lib/catalog-types";
import { createInstallationClient, openInstallationConfirmation, type InstallationSource } from "@hosty-sdk/app/install";
import { InstallDialog } from "@hosty-sdk/app/install/react";

import { fetchAppUpdateAvailable, fetchCatalogApp, fetchCatalogApps, fetchInstalledApps, MarketplaceApiError } from "@/lib/marketplace-api";
import { MarkdownDescription } from "@/components/markdown-description";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { HostyMark } from "../../../../shared/web/hosty-mark";
import { HostyLoader } from "../../../../shared/web/hosty-states";

import type { InstalledApp } from "@/lib/installed-types";

const installationClient = createInstallationClient();

function getDefaultFeed(feeds: CatalogAppFeed[]): CatalogAppFeed | null {
  return feeds.find(feed => feed.default) ?? (feeds.length === 1 ? feeds[0] : null);
}

const initialCatalog: CatalogAppsResponse = {
  apps: [],
  source: { url: null, name: "Marketplace", description: null },
  diagnostic: { status: "not-configured", code: "catalog_loading", message: "Loading catalog…" },
};

export function Storefront() {
  const [installation, setInstallation] = useState<{ source: InstallationSource; popup: Window | null } | null>(null);
  const installationBusy = useRef(false);
  const lookupPopup = useRef<Window | null>(null);
  const mounted = useRef(true);
  const [catalog, setCatalog] = useState(initialCatalog);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState("discover");
  const [installedLoading, setInstalledLoading] = useState(true);
  const [installedError, setInstalledError] = useState<string | null>(null);
  const [category, setCategory] = useState("all");
  const [selected, setSelected] = useState<CatalogAppDetailResponse | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailRequest = useRef<AbortController | null>(null);
  const detailOpener = useRef<HTMLElement | null>(null);
  const detailPane = useRef<HTMLElement | null>(null);
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const [installLoading, setInstallLoading] = useState<string | null>(null);
  const [hasCatalog, setHasCatalog] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [installedRoster, setInstalledRoster] = useState<InstalledApp[]>([]);
  const [hasInstalledRoster, setHasInstalledRoster] = useState(false);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const installedAppIds = useMemo(() => new Set(installedRoster.map(app => app.id)), [installedRoster]);
  const [notice, setNotice] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const installedRequest = useRef<AbortController | null>(null);

  const invalidateAccess = useCallback((failure: MarketplaceApiError) => {
    requestRef.current?.abort(); installedRequest.current?.abort(); detailRequest.current?.abort();
    setCatalog(initialCatalog); setHasCatalog(false); setInstalledRoster([]); setHasInstalledRoster(false);
    setSelected(null); setDetailId(null); setDetailError(null); setDetailLoading(null);
    setLoading(false); setInstalledLoading(false); setSessionExpired(failure.status === 401);
    setError(failure.message); setInstalledError(failure.message);
  }, []);

  // A promise chain rather than async/await: every state write then sits in a callback the
  // React Compiler lint recognizes as asynchronous when the mount effect starts this load.
  const loadCatalog = useCallback((refresh: boolean, signal?: AbortSignal) =>
    fetchCatalogApps(refresh, signal).then(response => {
      if (signal?.aborted) return;
      setCatalog(previous => response.diagnostic.status === "unavailable" && previous.apps.length > 0 && previous.source.url === response.source.url
        ? { ...response, apps: previous.apps } : response);
      setHasCatalog(true);
      setSessionExpired(false);
      setError(null);
    }, (loadError: unknown) => {
      if (loadError instanceof Error && loadError.name === "AbortError") {
        return;
      }
      if (signal?.aborted) return;
      if (loadError instanceof MarketplaceApiError && [401, 403].includes(loadError.status)) {
        invalidateAccess(loadError);
      }
      setError(loadError instanceof Error ? loadError.message : "The catalog could not be loaded.");
    }).finally(() => {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }), [invalidateAccess]);

  const loadInstalledAppIds = useCallback((signal?: AbortSignal) => {
    installedRequest.current?.abort();
    const controller = new AbortController(); installedRequest.current = controller;
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    void fetchInstalledApps(controller.signal)
      .then(apps => { if (!controller.signal.aborted && mounted.current) { setInstalledRoster(apps); setHasInstalledRoster(true); setInstalledError(null); } })
      .catch(error => {
        if (controller.signal.aborted || !mounted.current) return;
        // A transient read failure does not mean an installed app disappeared. Revocation does
        // discard the cached roster, and remains visible rather than becoming a successful empty list.
        if (error instanceof MarketplaceApiError && [401, 403].includes(error.status)) invalidateAccess(error);
        setInstalledError(error instanceof Error ? error.message : "Installed apps could not be loaded.");
      })
      .finally(() => { signal?.removeEventListener("abort", abort); if (!controller.signal.aborted && mounted.current) setInstalledLoading(false); });
  }, [invalidateAccess]);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    requestRef.current = controller;
    void loadCatalog(false, controller.signal);
    loadInstalledAppIds(controller.signal);
    return () => { controller.abort(); installedRequest.current?.abort(); detailRequest.current?.abort(); mounted.current = false; lookupPopup.current?.close(); };
  }, [loadCatalog, loadInstalledAppIds]);

  const refresh = () => {
    if (sessionExpired) { window.location.reload(); return; }
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setInstalledLoading(true);
    setError(null);
    setNotice(null);
    void loadCatalog(true, controller.signal);
    loadInstalledAppIds(controller.signal);
    if (detailId) void loadDetail(detailId, true);
  };

  const categories = useMemo(() => {
    const values = new Set(catalog.apps.flatMap(app => app.category ? [app.category] : []));
    return [...values].sort((left, right) => left.localeCompare(right));
  }, [catalog.apps]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return catalog.apps.filter(app => {
      if (category !== "all" && app.category !== category) {
        return false;
      }
      return !needle || [app.name, app.id, app.publisher?.name ?? "", app.category ?? "", app.summary ?? "", ...(app.tags ?? [])]
        .some(value => value.toLowerCase().includes(needle));
    });
  }, [catalog.apps, category, query]);

  const installedApps = installedRoster.filter(app => !query.trim() || [app.id, app.name, app.source].join(" ").toLowerCase().includes(query.trim().toLowerCase()));

  const closeDetail = () => {
    detailRequest.current?.abort();
    setDetailId(null); setSelected(null); setDetailError(null); setDetailLoading(null);
  };
  useEffect(() => {
    if (detailId) {
      detailPane.current?.focus({ preventScroll: true });
      if (window.matchMedia?.("(max-width: 1099px)").matches) detailPane.current?.scrollIntoView?.({ block: "start" });
    }
    else if (detailOpener.current?.isConnected) detailOpener.current.focus({ preventScroll: true });
    else if (detailOpener.current) searchInput.current?.focus({ preventScroll: true });
  }, [detailId]);
  const loadDetail = async (appId: string, refresh = false) => {
    detailRequest.current?.abort();
    const controller = new AbortController(); detailRequest.current = controller;
    if (detailId !== appId) {
      detailOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setSelected(null);
    }
    setDetailId(appId); setDetailLoading(appId); setDetailError(null); setNotice(null);
    try {
      const response = await fetchCatalogApp(appId, refresh, controller.signal);
      if (!mounted.current || controller.signal.aborted || detailRequest.current !== controller) return;
      if (response.id !== appId) throw new Error("The catalog returned another app. Refresh the catalog before continuing.");
      setSelected(response);
    } catch (detailError) {
      if (!mounted.current || controller.signal.aborted || detailRequest.current !== controller) return;
      if (detailError instanceof MarketplaceApiError && [401, 403].includes(detailError.status)) {
        invalidateAccess(detailError);
      } else setDetailError(detailError instanceof Error ? detailError.message : "App details could not be loaded.");
    } finally {
      if (mounted.current && !controller.signal.aborted && detailRequest.current === controller) setDetailLoading(null);
    }
  };
  const revealDetail = (app: CatalogAppDetailResponse) => {
    detailRequest.current?.abort();
    detailOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDetailId(app.id); setSelected(app); setDetailError(null); setDetailLoading(null);
  };

  // Card install always uses the default feed. Summaries carry no feeds, so resolve them on click;
  // feed selection lives in the detail pane, where the feed list is loaded.
  const installDefault = async (appId: string) => {
    if (installationBusy.current) return;
    installationBusy.current = true;
    // Reserve the popup during this click, before the catalog request loses browser activation.
    const popup = openInstallationConfirmation();
    lookupPopup.current = popup;
    setInstallLoading(appId);
    setNotice(null);
    try {
      const detail = await fetchCatalogApp(appId, false);
      if (!mounted.current) return;
      if (detail.id !== appId) throw new Error("The catalog returned another app. Refresh the catalog before continuing.");
      lookupPopup.current = null;
      const feed = getDefaultFeed(detail.feeds);
      if (feed && detail.feedsUrl) {
        setInstallation({ source: { feedsUrl: detail.feedsUrl, feedId: feed.id }, popup });
      } else {
        // Nothing installable — open details so the user sees the feed diagnostic.
        popup?.close();
        installationBusy.current = false;
        revealDetail(detail);
        if (!feed) {
          setNotice(detail.feeds.length ? "Choose a release feed before installing." : detail.feedDiagnostic?.message ?? "No installable feed found.");
        }
      }
    } catch (installError) {
      if (!mounted.current) return;
      lookupPopup.current = null;
      popup?.close();
      installationBusy.current = false;
      if (installError instanceof MarketplaceApiError && [401, 403].includes(installError.status)) invalidateAccess(installError);
      else setNotice(installError instanceof Error ? installError.message : "App details could not be loaded.");
    } finally {
      if (mounted.current) setInstallLoading(null);
    }
  };

  const requestInstall = (feedsUrl: string, feed: CatalogAppFeed) => {
    if (installationBusy.current) return;
    installationBusy.current = true;
    const popup = openInstallationConfirmation();
    setNotice(null);
    setInstallation({ source: { feedsUrl, feedId: feed.id }, popup });
  };
  const closeInstallation = () => {
    installationBusy.current = false;
    setInstallation(null);
  };

  return (
    <main aria-label="Marketplace" className="mx-auto w-full max-w-[1440px] space-y-5 px-4 py-5 sm:px-6">
      {installation && <InstallDialog client={installationClient} source={installation.source} confirmationWindow={installation.popup}
        onClose={closeInstallation}
        onInstalled={() => { closeInstallation(); loadInstalledAppIds(); }} />}
      <section className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm" aria-label="Catalog source">
        <div className="flex size-8 shrink-0 items-center justify-center text-muted-foreground" aria-hidden="true">
          <Store className="size-5" />
        </div>
        <div className="min-w-0 flex-1 basis-48">
          <div className="truncate text-sm font-medium">{hasCatalog ? catalog.source.name : "Catalog source"}</div>
          <div className="truncate text-xs text-muted-foreground">
            {hasCatalog ? catalog.source.description || catalog.source.url || "No source configured"
              : loading ? "Loading catalog…" : "Catalog source is unavailable."}
          </div>
        </div>
        <div className="ml-auto flex max-w-full flex-wrap items-center gap-2">
          {hasCatalog && <DiagnosticBadge diagnostic={catalog.diagnostic} />}
          {hasCatalog && catalog.diagnostic.status === "unavailable" && (catalog.apps.length > 0 || view === "installed") &&
            <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={loading}>Retry catalog</Button>}
          <Button asChild variant="ghost" size="sm"><a href="/settings"><Settings />Settings</a></Button>
        </div>
      </section>

      {hasCatalog && catalog.diagnostic.status !== "ready" && <DiagnosticBanner diagnostic={catalog.diagnostic} />}
      {error ? <div className="space-y-3"><NoticeBanner message={error} /><Button variant="outline" size="sm" onClick={refresh} disabled={loading}>{sessionExpired ? "Reconnect to Hosty" : "Retry catalog"}</Button></div> : null}
      {notice ? <NoticeBanner message={notice} /> : null}
      {installedError && view !== "installed" && <div role="status"><NoticeBanner message={`${installedError} ${hasInstalledRoster ? "Installed badges show the last successful check." : "Installed status is unavailable."}`} /><Button variant="outline" size="sm" onClick={refresh}>Retry installed apps</Button></div>}

      <div className="flex flex-wrap items-center gap-5 border-b" aria-label="Marketplace views">
        {[["discover", "Discover", hasCatalog ? catalog.apps.length : null], ["installed", "Installed", installedLoading || installedError ? null : installedAppIds.size]].map(([key, label, count]) => <Button key={key} type="button" variant="ghost" aria-pressed={view === key} onClick={() => { closeDetail(); detailOpener.current = null; setView(String(key)); }} className={cn("-mb-px rounded-none border-b-2 px-1 pb-3 pt-2", view === key ? "border-brand-strong text-foreground" : "border-transparent text-muted-foreground")}>{label}{count !== null && <span className="font-mono text-xs text-muted-foreground">{count}</span>}</Button>)}
      </div>
      {((hasCatalog && (catalog.diagnostic.status === "ready" || catalog.apps.length > 0)) || view === "installed") && <>
      <section className="flex flex-col gap-3 sm:flex-row sm:items-center" aria-label="Catalog filters">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <label className="sr-only" htmlFor="catalog-search">Search apps</label>
          <Input
            id="catalog-search"
            ref={searchInput}
            className="pl-9"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={view === "installed" ? "Search installed apps or sources" : "Search apps, tags, or publishers"}
          />
        </div>
        {(view !== "installed" || hasInstalledRoster) && <span className="shrink-0 font-mono text-xs text-muted-foreground">{view === "installed" ? installedApps.length : filtered.length} apps</span>}
      </section>

      <div className={cn("marketplace-browse", detailId && "marketplace-detail-open")}>
      <div className="marketplace-list min-w-0 space-y-4">
      {view === "installed" ? <section aria-label="Installed apps" className="divide-y rounded-xl border bg-card">
        {installedError && <div className="space-y-3 p-4"><NoticeBanner message={installedError} />
          {hasInstalledRoster && <p className="text-xs text-muted-foreground">Showing the last successful installed-app check.</p>}
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>Retry installed apps</Button></div>}
        {installedLoading ? <LoadingState label="Loading installed apps…" compact /> : null}
        {hasInstalledRoster && (installedApps.length ? installedApps.map(app => {
          const listing = catalog.apps.find(entry => entry.id === app.id);
          return <article key={app.id} className="marketplace-installed-row grid items-center gap-3 p-4">
            <AppIcon app={listing ?? { id: app.id, name: app.name, icon: null }} />
            <div className="min-w-0"><h2 className="truncate font-medium">{app.name}</h2><p className="truncate font-mono text-xs text-muted-foreground">{app.id}</p><p className="truncate text-xs text-muted-foreground">{app.source}</p></div>
            <div className="min-w-0 text-sm"><p className="font-mono">{app.version ?? "Version unavailable"}</p><p className="text-xs text-muted-foreground">{app.state}{app.runtime && ` · ${app.runtime}`}</p>
              {app.update?.state === "available" ? <p className="text-xs text-info-foreground">Update available{app.update.availableVersion && ` · ${app.update.availableVersion}`}</p> : app.update?.state === "failed" || app.update?.state === "unavailable" ? <p className="text-xs text-warning-foreground" title={app.update.message ?? undefined}>Update check incomplete</p> : <p className="text-xs text-muted-foreground">{app.update?.state === "current" ? "Up to date" : "Update not checked"}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-2 min-[701px]:justify-end">
              {app.openUrl && (app.state === "running" ? <Button asChild variant="outline" size="sm"><a href={app.openUrl} target="_blank" rel="noopener noreferrer">Open</a></Button> : <Button variant="outline" size="sm" disabled title="Start the app from Manage to open it">Open</Button>)}
              {app.manageUrl && <Button asChild variant="outline" size="sm"><a href={app.manageUrl} target="_blank" rel="noopener noreferrer">Manage</a></Button>}
              {listing && <Button variant="ghost" size="sm" disabled={detailLoading === app.id} onClick={() => void loadDetail(app.id)}>Details<ArrowRight className="size-3" /></Button>}
            </div>
          </article>;
        }) : !installedLoading ? <EmptyState title={query ? "No installed apps match your search" : "No installed apps found"}
          description={query ? "Try another app name or source." : "Browse the catalog to find apps for this host."}
          onAction={() => { if (query) { setQuery(""); searchInput.current?.focus(); } else setView("discover"); }} actionLabel={query ? "Clear search" : "Discover apps"} /> : null)}
      </section> : <>
      {catalog.diagnostic.status === "unavailable" && <p className="text-xs text-muted-foreground" role="status">Showing the last loaded catalog. Retry catalog to check the current source.</p>}
      <div className="flex flex-wrap gap-2" aria-label="Categories">{["all", ...categories].map(value => <Button key={value} variant={category === value ? "secondary" : "outline"} size="sm" className="h-auto max-w-full rounded-full py-2 whitespace-normal break-all" aria-pressed={category === value} onClick={() => setCategory(value)}>{value === "all" ? "All" : value}</Button>)}</div>
      {filtered.length === 0 ? (
        <EmptyState title={query || category !== "all" ? "No matching apps" : "Catalog is empty"}
          description={query || category !== "all" ? "Try another search or category." : "This source has no apps yet."}
          onAction={query || category !== "all" ? () => { setQuery(""); setCategory("all"); searchInput.current?.focus(); } : undefined}
          actionLabel="Clear filters" />
      ) : (
        <section className="marketplace-app-grid grid gap-3" aria-label="Catalog apps">
          {filtered.map(app => (
            <AppCard
              key={app.id}
              app={app}
              detailsBusy={detailLoading === app.id}
              installBusy={installLoading === app.id}
              installed={installedAppIds.has(app.id)}
              selected={detailId === app.id}
              update={installedRoster.find(item => item.id === app.id)?.update}
              onDetails={() => void loadDetail(app.id)}
              onInstall={() => void installDefault(app.id)}
            />
          ))}
        </section>
      )}

      </>}
      </div>
      {detailId && <aside ref={detailPane} tabIndex={-1} aria-label="App details" className="marketplace-detail-pane min-w-0 rounded-xl border bg-card outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-brand focus-visible:ring-0"
        onKeyDown={event => { if (event.key === "Escape" && !(event.target as HTMLElement).closest('[aria-expanded="true"]')) { event.stopPropagation(); closeDetail(); } }}>
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <Button variant="ghost" size="sm" onClick={closeDetail}><ArrowLeft className="size-4" />{view === "installed" ? "Back to installed" : "Back to catalog"}</Button>
          <Button variant="ghost" size="icon-sm" aria-label="Close app details" onClick={closeDetail}><X className="size-4" /></Button>
        </div>
        {detailError && <div className="space-y-3 border-b p-4"><NoticeBanner message={detailError} /><Button variant="outline" size="sm" onClick={() => void loadDetail(detailId, true)}>Retry app details</Button></div>}
        {selected && selected.id === detailId ? <CatalogAppDetails key={selected.id} app={selected}
          installedApp={installedRoster.find(app => app.id === selected.id)} refreshing={detailLoading === detailId} installUnavailable={!!detailError}
          onRefresh={() => void loadDetail(detailId, true)} onInstall={feed => selected.feedsUrl && requestInstall(selected.feedsUrl, feed)} />
          : detailLoading ? <LoadingState label="Loading app details…" /> : null}
      </aside>}
      </div>
      </>}
      {hasCatalog && catalog.diagnostic.status !== "ready" && catalog.apps.length === 0 && view === "discover" &&
        <EmptyState title={catalog.diagnostic.status === "not-configured" ? "Choose a catalog" : catalog.diagnostic.status === "unavailable" ? "Catalog is unavailable" : "Catalog needs attention"}
          description={catalog.diagnostic.status === "not-configured" ? "Add a catalog source in Settings to discover apps." : "Check the source address in Settings or retry the catalog."}
          actionHref={catalog.diagnostic.status === "unavailable" ? undefined : "/settings"} onAction={catalog.diagnostic.status === "unavailable" ? refresh : undefined}
          actionLabel={catalog.diagnostic.status === "unavailable" ? "Retry catalog" : "Configure catalog"} />}
      {!hasCatalog && loading && !error && view === "discover" ? (
        <div className="rounded-xl border bg-card"><LoadingState label="Loading catalog…" /></div>
      ) : null}


    </main>
  );
}

function AppCard({ app, detailsBusy, installBusy, installed, selected, update, onDetails, onInstall }: {
  app: CatalogAppSummary;
  detailsBusy: boolean;
  installBusy: boolean;
  installed: boolean;
  selected: boolean;
  update?: InstalledApp["update"];
  onDetails: () => void;
  onInstall: () => void;
}) {
  return (
    <article className={cn("group flex min-w-0 flex-col rounded-xl border bg-card p-4 transition-colors hover:border-brand-strong/50", selected && "border-brand-strong bg-brand/10")}>
      <span className="sr-only">{selected ? "Selected app" : "Catalog app"}</span>
      <div className="flex min-w-0 items-start gap-3">
        <AppIcon app={app} />
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="truncate text-base font-semibold"><Button type="button" variant="ghost" className="h-auto max-w-full justify-start whitespace-normal p-0 text-left text-base font-semibold hover:bg-transparent hover:underline" aria-pressed={selected} onClick={onDetails} disabled={detailsBusy}>{app.name}</Button></h2>
          <p className="truncate text-xs text-muted-foreground">{app.publisher?.name || app.id}</p>
        </div>
      </div>
      <p className="mt-3 line-clamp-2 min-h-10 text-sm text-muted-foreground">
        {app.summary || "No catalog summary provided."}
      </p>
      <div className="mt-3 flex min-h-6 flex-wrap items-center gap-1.5">
        {app.category ? <Badge variant="secondary" className="max-w-full truncate">{app.category}</Badge> : null}
        {update?.state === "available" && <span className="text-xs font-medium text-info-foreground">Update available{update.availableVersion && ` · ${update.availableVersion}`}</span>}
        {app.tags.slice(0, 2).map(tag => <Badge key={tag} variant="outline" className="max-w-40 truncate">{tag}</Badge>)}
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
        <Button type="button" size="sm" variant="outline" className="flex-1" onClick={onDetails} disabled={detailsBusy}>
          {detailsBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
          Details
        </Button>
        {installed ? (
          <Button type="button" size="sm" variant="secondary" disabled>
            <Check className="h-4 w-4" />
            Installed
          </Button>
        ) : (
          // Cards install the default feed; feed selection lives in the detail pane.
          <Button type="button" size="sm" onClick={onInstall} disabled={installBusy}>
            {installBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Install
          </Button>
        )}
      </div>
    </article>
  );
}

// Split button: the main action installs the default feed; the caret opens a menu to pick another
// feed. Used in the detail pane, where the feed list is already loaded. The caret is hidden when
// there is only one feed to choose from.
function FeedInstallButton({ feeds, label = "Install", disabled = false, onInstallDefault, onInstallFeed, placement = "bottom" }: {
  feeds: CatalogAppFeed[];
  label?: string;
  disabled?: boolean;
  onInstallDefault?: () => void;
  onInstallFeed: (feed: CatalogAppFeed) => void;
  placement?: "bottom" | "top";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const multiple = feeds.length > 1;

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-flex" onKeyDown={event => {
      if (event.key === "Escape" && open) {
        event.stopPropagation(); setOpen(false);
        rootRef.current?.querySelector<HTMLButtonElement>('button[aria-label]')?.focus();
      }
    }}>
      <Button type="button" size="sm" className={cn(multiple && "rounded-r-none")} disabled={disabled} aria-haspopup={onInstallDefault ? undefined : true} aria-expanded={onInstallDefault ? undefined : open}
        onClick={() => { if (onInstallDefault) onInstallDefault(); else setOpen(true); }}>
        <Download className="h-4 w-4" />
        {label}
      </Button>
      {multiple ? (
        <Button
          type="button"
          size="sm"
          className="rounded-l-none border-l border-primary-foreground/25 px-2"
          disabled={disabled}
          aria-haspopup="true"
          aria-expanded={open}
          aria-label={`Choose ${label.toLowerCase()} feed`}
          onClick={() => setOpen(current => !current)}
        >
          <ChevronDown className="h-4 w-4" />
        </Button>
      ) : null}
      {open && multiple ? (
        // A plain disclosure popover, not a WAI-ARIA menu: the choices are focusable buttons reached
        // by Tab and dismissed with Escape, so we don't claim menu roles we don't fully implement.
        <div
          className={cn(
            "absolute left-0 z-50 w-64 max-w-[calc(100vw-5rem)] rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
            placement === "top" ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          {feeds.map(feed => (
            <Button
              key={feed.id}
              disabled={disabled}
              variant="ghost"
              size="sm"
              type="button"
              className="h-auto w-full justify-between gap-3 rounded-sm px-2 py-2 text-left"
              onClick={() => { setOpen(false); onInstallFeed(feed); }}
            >
              <span className="min-w-0 break-all whitespace-normal">{feed.id}</span>
              {feed.default ? <Badge variant="secondary" className="shrink-0">Default</Badge> : null}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AppIcon({ app }: { app: Pick<CatalogAppSummary, "id" | "name" | "icon"> }) {
  return <AppIconAsset key={app.icon ?? ""} src={app.icon} />;
}

// A catalog icon belongs to its URL, including failures; replacement assets must load afresh.
function AppIconAsset({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted text-muted-foreground">
      {src && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- catalog-owned remote asset
        <img src={src} alt="" className="size-7 object-contain" onError={() => setFailed(true)} />
      ) : <Package className="h-5 w-5" />}
    </div>
  );
}

export function CatalogAppDetails({ app, installedApp, refreshing = false, installUnavailable = false, onRefresh, onInstall }: {
  app: CatalogAppDetailResponse;
  installedApp?: InstalledApp;
  refreshing?: boolean;
  installUnavailable?: boolean;
  onRefresh: () => void;
  onInstall: (feed: CatalogAppFeed) => void;
}) {
  const defaultFeed = getDefaultFeed(app.feeds);
  const canInstall = Boolean(app.feeds.length && app.feedsUrl) && !refreshing && !installUnavailable;
  const installed = !!installedApp;
  const [check, setCheck] = useState(0);
  const [updateState, setUpdateState] = useState<"checking" | "available" | "not-reported" | "unavailable">(installed ? "checking" : "not-reported");
  const [prevInstalled, setPrevInstalled] = useState(installed);
  if (prevInstalled !== installed) { setPrevInstalled(installed); setUpdateState(installed ? "checking" : "not-reported"); }
  useEffect(() => {
    if (!installed) return;
    const controller = new AbortController();
    void fetchAppUpdateAvailable(app.id, controller.signal)
      .then(available => { if (!controller.signal.aborted) setUpdateState(available ? "available" : "not-reported"); })
      .catch(() => { if (!controller.signal.aborted) setUpdateState("unavailable"); });
    return () => controller.abort();
  }, [app.id, installed, check]);
  return <div className="space-y-5 p-5">
    <div className="flex items-start gap-3">
      <AppIcon app={app} />
      <div className="min-w-0 flex-1"><h2 className="break-words text-xl font-semibold tracking-tight">{app.name}</h2>
        <p className="mt-1 break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{app.publisher?.name || "Publisher not declared"}</p>
        {app.signerIdentity && <p className="mt-1 break-all text-xs text-muted-foreground">Declared signer · {app.signerIdentity}</p>}
      </div>
      <Button variant="ghost" size="icon-sm" aria-label="Refresh app details" disabled={refreshing} onClick={onRefresh}><RefreshCw className={cn("size-4", refreshing && "animate-spin")} /></Button>
    </div>
    {installUnavailable && <p className="text-xs text-muted-foreground">Showing the last loaded details. Retry before installing.</p>}
    {app.summary && <p className="break-words text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{app.summary}</p>}
    <div className="flex flex-wrap gap-1.5">{app.category && <Badge variant="secondary" className="max-w-full whitespace-normal break-all">{app.category}</Badge>}{app.tags.map(tag => <Badge key={tag} variant="outline" className="max-w-full whitespace-normal break-all">{tag}</Badge>)}</div>
    <div className="flex flex-wrap gap-2">
      {!installed || updateState === "available" ? <FeedInstallButton feeds={app.feeds} label={installed ? "Update" : "Install"} disabled={!canInstall}
        onInstallDefault={defaultFeed ? () => onInstall(defaultFeed) : undefined} onInstallFeed={onInstall} />
        : <Button variant="secondary" size="sm" disabled>{updateState === "checking" ? <HostyLoader label={null} className="size-4" /> : <Check className="size-4" />}Installed</Button>}
      {installedApp?.openUrl && (installedApp.state === "running" ? <Button asChild variant="outline" size="sm"><a href={installedApp.openUrl} target="_blank" rel="noopener noreferrer">Open</a></Button> : <Button variant="outline" size="sm" disabled title="Start the app from Manage to open it">Open</Button>)}
      {installedApp?.manageUrl && <Button asChild variant="outline" size="sm"><a href={installedApp.manageUrl} target="_blank" rel="noopener noreferrer">Manage</a></Button>}
    </div>
    {installed && <div className="space-y-2 text-xs text-muted-foreground" role="status">
      <p>{updateState === "checking" ? "Checking for updates…" : updateState === "available" ? "An update is available through Core." : updateState === "unavailable" ? "Update check incomplete." : "No newer version was reported. Manage shows the installed app's update details."}</p>
      {updateState === "unavailable" && <Button size="sm" variant="outline" onClick={() => { setUpdateState("checking"); setCheck(value => value + 1); }}>Retry update check</Button>}
    </div>}
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-y py-4">
      {installedApp?.version && <Fact label="Installed version" value={installedApp.version} />}
      <Fact label="Source" value={app.sourceName} />
      <div className="col-span-2"><Fact label="App id" value={app.id} /></div>
    </dl>
    {app.screenshots.length > 0 && <section aria-label="Screenshots" className="marketplace-screenshots flex snap-x gap-3 overflow-x-auto pb-1">
      {app.screenshots.map((source, index) => (
        // eslint-disable-next-line @next/next/no-img-element -- catalog-owned remote asset
        <img key={source} src={source} loading="lazy" alt={`${app.name} screenshot ${index + 1}`} className="aspect-[16/10] w-[85%] shrink-0 snap-start rounded-lg border object-contain bg-muted" />
      ))}
    </section>}
    {app.description && app.descriptionUrl ? <MarkdownDescription content={app.description} sourceUrl={app.descriptionUrl} />
      : app.descriptionUrl ? <DiagnosticBanner diagnostic={app.descriptionDiagnostic} compact /> : null}
    <section className="space-y-3 border-t pt-4" aria-label="Install source">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Release feeds</h3><DiagnosticBadge diagnostic={app.feedDiagnostic} /></div>
      {app.feeds.length > 0 ? <div className="divide-y rounded-lg border">{app.feeds.map(feed => <div key={feed.id} className="space-y-1 px-3 py-2.5">
        <div className="flex items-center gap-2"><span className="min-w-0 break-all font-mono text-xs font-medium">{feed.id}</span>{feed.default && <Badge variant="secondary">Default</Badge>}</div>
        <code className="block break-all text-xs text-muted-foreground">{feed.manifestRef}</code>
      </div>)}</div> : <DiagnosticBanner diagnostic={app.feedDiagnostic} compact />}
      <p className="text-xs leading-relaxed text-muted-foreground">Core confirms the runtime, startup and permissions on its own page before installation.</p>
    </section>
  </div>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm font-medium break-words">{value}</dd>
    </div>
  );
}

function DiagnosticBadge({ diagnostic }: { diagnostic: CatalogDiagnostic }) {
  const ready = diagnostic.status === "ready";
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 border-transparent",
        ready ? "bg-success-soft text-success-foreground" : "bg-warning-soft text-warning-foreground",
      )}
    >
      <span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-full", ready ? "bg-success" : "bg-warning")} />
      {diagnostic.status.replace("-", " ")}
    </Badge>
  );
}

function DiagnosticBanner({ diagnostic, compact = false }: { diagnostic: CatalogDiagnostic; compact?: boolean }) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-start gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning-foreground",
        compact && "text-xs",
      )}
      role="status"
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 break-words [overflow-wrap:anywhere]">
        <span className="font-medium">{humanizeCode(diagnostic.code)}</span>
        <span className="text-warning-foreground"> — {diagnostic.message}</span>
      </div>
    </div>
  );
}

function NoticeBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="min-w-0 break-words rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2 text-sm text-destructive-foreground [overflow-wrap:anywhere]"
    >
      {message}
    </div>
  );
}

function LoadingState({ label, compact = false }: { label: string; compact?: boolean }) {
  return <div role="status" className={cn("flex flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground", compact ? "min-h-32" : "min-h-60")}>
    <HostyLoader label={null} className="size-8" /><span>{label}</span>
  </div>;
}

function EmptyState({ title, description, onAction, actionHref, actionLabel }: {
  title: string;
  description?: string;
  onAction?: () => void;
  actionHref?: string;
  actionLabel?: string;
}) {
  return <div className="flex min-h-60 flex-col items-center justify-center gap-3 rounded-lg border bg-card p-6 text-center">
    <HostyMark appId="hosty.marketplace" className="size-14" />
    <div><div className="font-medium">{title}</div>{description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}</div>
    {actionHref ? <Button asChild variant="outline" size="sm"><a href={actionHref}>{actionLabel}</a></Button> : onAction && <Button type="button" variant="outline" size="sm" onClick={onAction}>{actionLabel}</Button>}
  </div>;
}

function humanizeCode(code: string): string {
  return code
    .split("_")
    .filter(Boolean)
    .map(word => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join(" ");
}
