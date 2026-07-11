"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Download, LoaderCircle, Package, PackageSearch, RefreshCw, Search, Store, TriangleAlert } from "lucide-react";
import type {
  CatalogAppDetailResponse,
  CatalogAppFeed,
  CatalogAppSummary,
  CatalogAppsResponse,
  CatalogDiagnostic,
} from "@/lib/catalog-types";
import { postInstallFeedIntent } from "@/lib/install-intent";
import { fetchCatalogApp, fetchCatalogApps, fetchIdentity, fetchInstalledAppIds } from "@/lib/marketplace-api";
import type { MarketplaceIdentity } from "@/lib/host-auth";
import { MarkdownDescription } from "@/components/markdown-description";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const initialCatalog: CatalogAppsResponse = {
  apps: [],
  source: { url: null, name: "Marketplace", description: null },
  diagnostic: { status: "not-configured", code: "catalog_loading", message: "Loading catalog…" },
};

export function Storefront() {
  const [catalog, setCatalog] = useState(initialCatalog);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [selected, setSelected] = useState<CatalogAppDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const [installLoading, setInstallLoading] = useState<string | null>(null);
  const [identity, setIdentity] = useState<MarketplaceIdentity | null>(null);
  const [installedAppIds, setInstalledAppIds] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  const loadCatalog = useCallback(async (refresh: boolean, signal?: AbortSignal) => {
    try {
      const response = await fetchCatalogApps(refresh, signal);
      setCatalog(response);
      setError(null);
    } catch (loadError) {
      if (loadError instanceof Error && loadError.name === "AbortError") {
        return;
      }
      setError(loadError instanceof Error ? loadError.message : "The catalog could not be loaded.");
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, []);

  const loadInstalledAppIds = useCallback((signal?: AbortSignal) => {
    // Asks Core (via a Marketplace server route + app service token) which apps are already
    // installed, so cards can show an "Installed" state independently of any particular UI.
    void fetchInstalledAppIds(signal)
      .then(ids => setInstalledAppIds(new Set(ids)))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    requestRef.current = controller;
    void loadCatalog(false, controller.signal);
    void fetchIdentity(controller.signal).then(setIdentity).catch(() => undefined);
    loadInstalledAppIds(controller.signal);
    return () => requestRef.current?.abort();
  }, [loadCatalog, loadInstalledAppIds]);

  const refresh = () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setNotice(null);
    void loadCatalog(true, controller.signal);
    loadInstalledAppIds(controller.signal);
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
      return !needle || [app.name, app.id, app.summary ?? "", ...(app.tags ?? [])]
        .some(value => value.toLowerCase().includes(needle));
    });
  }, [catalog.apps, category, query]);

  const loadDetail = async (appId: string) => {
    setDetailLoading(appId);
    setNotice(null);
    try {
      setSelected(await fetchCatalogApp(appId, false));
    } catch (detailError) {
      setNotice(detailError instanceof Error ? detailError.message : "App details could not be loaded.");
    } finally {
      setDetailLoading(null);
    }
  };

  // Card install always uses the default feed. Summaries carry no feeds, so resolve them on click;
  // feed selection lives in the details dialog, where the feed list is loaded.
  const installDefault = async (appId: string) => {
    setInstallLoading(appId);
    setNotice(null);
    try {
      const detail = await fetchCatalogApp(appId, false);
      const feed = detail.feeds.find(candidate => candidate.default) ?? detail.feeds[0] ?? null;
      if (feed && detail.feedsUrl) {
        requestInstall(detail.feedsUrl, feed);
      } else {
        // Nothing installable — open details so the user sees the feed diagnostic.
        setSelected(detail);
        if (!feed) {
          setNotice(detail.feedDiagnostic?.message ?? "No installable feed found.");
        }
      }
    } catch (installError) {
      setNotice(installError instanceof Error ? installError.message : "App details could not be loaded.");
    } finally {
      setInstallLoading(null);
    }
  };

  const requestInstall = (feedsUrl: string, feed: CatalogAppFeed) => {
    const result = postInstallFeedIntent(feedsUrl, feed.id);
    if (result.ok) {
      // No success banner — the Shell's install-review dialog opening is confirmation enough.
      setNotice(null);
      setSelected(null);
    } else {
      setNotice(result.message);
    }
  };

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="truncate text-xl font-semibold leading-7">Marketplace</h1>
          <p className="text-sm text-muted-foreground">
            Discover runtime apps from your configured catalog. Hosty Core validates every feed again before installation.
          </p>
        </div>
        <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          <IdentityBadge identity={identity} />
          <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </header>

      <section className="flex items-center gap-3 rounded-lg border bg-card p-4" aria-label="Catalog source">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground" aria-hidden="true">
          <Store className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{catalog.source.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {catalog.source.description || catalog.source.url || "No source configured"}
          </div>
        </div>
        <DiagnosticBadge diagnostic={catalog.diagnostic} />
      </section>

      {catalog.diagnostic.status !== "ready" ? <DiagnosticBanner diagnostic={catalog.diagnostic} /> : null}
      {error ? <NoticeBanner message={error} /> : null}
      {notice ? <NoticeBanner message={notice} /> : null}

      <section className="flex flex-col gap-3 sm:flex-row sm:items-center" aria-label="Catalog filters">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <label className="sr-only" htmlFor="catalog-search">Search apps</label>
          <Input
            id="catalog-search"
            className="pl-9"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search apps, tags, or publishers"
          />
        </div>
        <label className="sr-only" htmlFor="catalog-category">Category</label>
        <select
          id="catalog-category"
          className="h-9 rounded-md border bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:w-52"
          value={category}
          onChange={event => setCategory(event.target.value)}
        >
          <option value="all">All categories</option>
          {categories.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
        <span className="shrink-0 text-xs text-muted-foreground">
          {filtered.length} {filtered.length === 1 ? "app" : "apps"}
        </span>
      </section>

      {loading && catalog.apps.length === 0 ? (
        <EmptyState icon={LoaderCircle} title="Loading catalog" description="Reading the configured Marketplace source." iconClassName="animate-spin" />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={PackageSearch}
          title={catalog.diagnostic.status === "ready" ? "No matching apps" : "Marketplace is not ready"}
          description={catalog.diagnostic.status === "ready"
            ? "Try another search or category."
            : "Check the source diagnostic above or update the app setting in Hosty Shell."}
        />
      ) : (
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Catalog apps">
          {filtered.map(app => (
            <AppCard
              key={app.id}
              app={app}
              detailsBusy={detailLoading === app.id}
              installBusy={installLoading === app.id}
              installed={installedAppIds.has(app.id)}
              onDetails={() => void loadDetail(app.id)}
              onInstall={() => void installDefault(app.id)}
            />
          ))}
        </section>
      )}

      {selected ? (
        <AppDetailDialog
          app={selected}
          onClose={() => setSelected(null)}
          onInstall={feed => selected.feedsUrl && requestInstall(selected.feedsUrl, feed)}
        />
      ) : null}
    </main>
  );
}

function AppCard({ app, detailsBusy, installBusy, installed, onDetails, onInstall }: {
  app: CatalogAppSummary;
  detailsBusy: boolean;
  installBusy: boolean;
  installed: boolean;
  onDetails: () => void;
  onInstall: () => void;
}) {
  return (
    <div className="flex flex-col rounded-lg border bg-card p-4">
      <div className="flex min-w-0 items-start gap-3">
        <AppIcon app={app} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-base font-semibold">{app.name}</h2>
            {installed ? <Badge variant="secondary" className="shrink-0 gap-1"><Check className="h-3 w-3" />Installed</Badge> : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">{app.publisher?.name || app.id}</p>
        </div>
      </div>
      <p className="mt-3 line-clamp-2 min-h-10 text-sm text-muted-foreground">
        {app.summary || "No catalog summary provided."}
      </p>
      <div className="mt-3 flex min-h-6 flex-wrap items-center gap-1.5">
        {app.category ? <Badge variant="secondary">{app.category}</Badge> : null}
        {app.tags.slice(0, 3).map(tag => <Badge key={tag} variant="outline" className="max-w-40 truncate">{tag}</Badge>)}
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
          // Cards install the default feed; feed selection lives in the details dialog.
          <Button type="button" size="sm" onClick={onInstall} disabled={installBusy}>
            {installBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Install
          </Button>
        )}
      </div>
    </div>
  );
}

// Split button: the main action installs the default feed; the caret opens a menu to pick another
// feed. Used in the details dialog, where the feed list is already loaded. The caret is hidden when
// there is only one feed to choose from.
function FeedInstallButton({ feeds, disabled = false, onInstallDefault, onInstallFeed, placement = "bottom" }: {
  feeds: CatalogAppFeed[];
  disabled?: boolean;
  onInstallDefault: () => void;
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
    <div ref={rootRef} className="relative inline-flex">
      <Button type="button" size="sm" className={cn(multiple && "rounded-r-none")} disabled={disabled} onClick={onInstallDefault}>
        <Download className="h-4 w-4" />
        Install
      </Button>
      {multiple ? (
        <Button
          type="button"
          size="sm"
          className="rounded-l-none border-l border-primary-foreground/25 px-2"
          disabled={disabled}
          aria-haspopup="true"
          aria-expanded={open}
          aria-label="Choose install feed"
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
            "absolute right-0 z-50 min-w-52 rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
            placement === "top" ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          {feeds.map(feed => (
            <button
              key={feed.id}
              type="button"
              className="flex w-full items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              onClick={() => { setOpen(false); onInstallFeed(feed); }}
            >
              <span className="truncate">{feed.id}</span>
              {feed.default ? <Badge variant="secondary" className="shrink-0">Default</Badge> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AppIcon({ app }: { app: CatalogAppSummary | CatalogAppDetailResponse }) {
  return (
    <div className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted text-muted-foreground">
      {app.icon ? (
        // eslint-disable-next-line @next/next/no-img-element -- catalog-owned remote asset
        <img src={app.icon} alt="" className="size-7 object-contain" />
      ) : <Package className="h-5 w-5" />}
    </div>
  );
}

function AppDetailDialog({ app, onClose, onInstall }: {
  app: CatalogAppDetailResponse;
  onClose: () => void;
  onInstall: (feed: CatalogAppFeed) => void;
}) {
  const defaultFeed = app.feeds.find(feed => feed.default) ?? app.feeds[0] ?? null;
  const canInstall = Boolean(defaultFeed && app.feedsUrl);
  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <div className="flex items-center gap-3 pr-6 text-left">
            <AppIcon app={app} />
            <div className="min-w-0">
              <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{app.category || "Runtime app"}</div>
              <DialogTitle className="truncate">{app.name}</DialogTitle>
              <DialogDescription className="truncate">{app.summary || app.id}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <DialogBody className="space-y-5">
          <dl className="grid gap-3 sm:grid-cols-2">
            <Fact label="App id" value={app.id} />
            <Fact label="Publisher" value={app.publisher?.name || "Unknown"} />
            <Fact label="Source" value={app.sourceName} />
            <Fact label="Signer" value={app.signerIdentity || "Not declared"} />
          </dl>

          {app.tags.length ? (
            <div className="flex flex-wrap gap-1.5">
              {app.tags.map(tag => <Badge key={tag} variant="outline">{tag}</Badge>)}
            </div>
          ) : null}

          {app.screenshots.length ? (
            <div className="flex gap-3 overflow-x-auto">
              {app.screenshots.map(source => (
                // eslint-disable-next-line @next/next/no-img-element -- catalog-owned remote asset
                <img key={source} src={source} alt={`${app.name} screenshot`} className="h-52 rounded-md border object-cover" />
              ))}
            </div>
          ) : null}

          {app.description && app.descriptionUrl ? (
            <MarkdownDescription content={app.description} sourceUrl={app.descriptionUrl} />
          ) : app.descriptionUrl ? (
            <DiagnosticBanner diagnostic={app.descriptionDiagnostic} compact />
          ) : null}

          <section className="space-y-3 border-t pt-5">
            <div className="flex items-center justify-between gap-2">
              <div className="space-y-0.5">
                <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Install source</div>
                <h3 className="text-sm font-medium">Available feeds</h3>
              </div>
              <DiagnosticBadge diagnostic={app.feedDiagnostic} />
            </div>
            {app.feeds.length ? (
              <div className="space-y-2">
                {app.feeds.map(feed => (
                  <div key={feed.id} className="flex flex-col gap-1 rounded-md border p-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{feed.id}</span>
                      {feed.default ? <Badge variant="secondary">Default</Badge> : null}
                    </div>
                    <code className="block truncate font-mono text-xs text-muted-foreground">{feed.manifestRef}</code>
                  </div>
                ))}
              </div>
            ) : <DiagnosticBanner diagnostic={app.feedDiagnostic} compact />}
            <p className="text-xs text-muted-foreground">
              Feed data shown here is informational. Core fetches and validates it independently during review.
            </p>
          </section>
        </DialogBody>

        <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>Close</Button>
          <FeedInstallButton
            feeds={app.feeds}
            disabled={!canInstall}
            placement="top"
            onInstallDefault={() => defaultFeed && onInstall(defaultFeed)}
            onInstallFeed={onInstall}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm font-medium break-words">{value}</dd>
    </div>
  );
}

function IdentityBadge({ identity }: { identity: MarketplaceIdentity | null }) {
  // Surface the host session only when there's a problem. The signed-in user's
  // name is already shown by the Shell, so we don't duplicate it here.
  if (!identity || identity.status === "active") return null;
  return <Badge variant="outline">Host session {identity.status}</Badge>;
}

function DiagnosticBadge({ diagnostic }: { diagnostic: CatalogDiagnostic }) {
  const ready = diagnostic.status === "ready";
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 border-transparent",
        ready ? "bg-emerald-500/10 text-emerald-700" : "bg-amber-500/10 text-amber-700",
      )}
    >
      <span className={cn("h-2 w-2 rounded-full", ready ? "bg-emerald-500" : "bg-amber-500")} />
      {diagnostic.status.replace("-", " ")}
    </Badge>
  );
}

function DiagnosticBanner({ diagnostic, compact = false }: { diagnostic: CatalogDiagnostic; compact?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200",
        compact && "text-xs",
      )}
      role="status"
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">
        <span className="font-medium">{humanizeCode(diagnostic.code)}</span>
        <span className="text-amber-900/80 dark:text-amber-200/80"> — {diagnostic.message}</span>
      </div>
    </div>
  );
}

function NoticeBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {message}
    </div>
  );
}

function EmptyState({ icon: Icon, title, description, iconClassName }: {
  icon: typeof Package;
  title: string;
  description?: string;
  iconClassName?: string;
}) {
  return (
    <div className="flex min-h-60 flex-col items-center justify-center rounded-lg border bg-card p-6 text-center">
      <Icon className={cn("mb-3 h-6 w-6 text-muted-foreground", iconClassName)} />
      <div className="font-medium">{title}</div>
      {description && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
    </div>
  );
}

function humanizeCode(code: string): string {
  return code
    .split("_")
    .filter(Boolean)
    .map(word => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join(" ");
}
