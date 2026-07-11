"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CatalogAppDetailResponse,
  CatalogAppFeed,
  CatalogAppSummary,
  CatalogAppsResponse,
  CatalogDiagnostic,
} from "@/lib/catalog-types";
import { postInstallFeedIntent } from "@/lib/install-intent";
import { fetchCatalogApp, fetchCatalogApps, fetchIdentity } from "@/lib/marketplace-api";
import type { MarketplaceIdentity } from "@/lib/host-auth";
import { MarkdownDescription } from "@/components/markdown-description";

type Notice = { tone: "success" | "error"; message: string };

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
  const [identity, setIdentity] = useState<MarketplaceIdentity | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
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

  useEffect(() => {
    const controller = new AbortController();
    requestRef.current = controller;
    void loadCatalog(false, controller.signal);
    void fetchIdentity(controller.signal).then(setIdentity).catch(() => undefined);
    return () => requestRef.current?.abort();
  }, [loadCatalog]);

  const refresh = () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setNotice(null);
    void loadCatalog(true, controller.signal);
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

  const loadDetail = async (appId: string, forInstall = false) => {
    setDetailLoading(appId);
    setNotice(null);
    try {
      const detail = await fetchCatalogApp(appId, false);
      if (forInstall) {
        const feed = detail.feeds.find(candidate => candidate.default) ?? null;
        if (!feed || !detail.feedsUrl) {
          setSelected(detail);
          if (!feed) {
            setNotice({
              tone: "error",
              message: detail.feeds.length > 1
                ? "Choose a feed in app details before opening install review."
                : detail.feedDiagnostic.message,
            });
          }
        } else {
          requestInstall(detail.feedsUrl, feed);
        }
      } else {
        setSelected(detail);
      }
    } catch (detailError) {
      setNotice({
        tone: "error",
        message: detailError instanceof Error ? detailError.message : "App details could not be loaded.",
      });
    } finally {
      setDetailLoading(null);
    }
  };

  const requestInstall = (feedsUrl: string, feed: CatalogAppFeed) => {
    const result = postInstallFeedIntent(feedsUrl, feed.id);
    setNotice(result.ok
      ? { tone: "success", message: `Install review for the '${feed.id}' feed was sent to Hosty Shell.` }
      : { tone: "error", message: result.message });
    if (result.ok) {
      setSelected(null);
    }
  };

  return (
    <main className="marketplace-shell">
      <header className="hero">
        <div>
          <span className="eyebrow">Hosty system app</span>
          <h1>Marketplace</h1>
          <p className="hero-copy">Discover runtime apps from your configured catalog. Hosty Core validates every feed again before installation.</p>
        </div>
        <div className="hero-actions">
          <IdentityBadge identity={identity} />
          <button className="button button-secondary" type="button" onClick={refresh} disabled={loading}>
            <RefreshIcon spinning={loading} />
            Refresh
          </button>
        </div>
      </header>

      <section className="source-strip" aria-label="Catalog source">
        <div className="source-mark" aria-hidden="true">◎</div>
        <div className="source-copy">
          <strong>{catalog.source.name}</strong>
          <span>{catalog.source.description || catalog.source.url || "No source configured"}</span>
        </div>
        <DiagnosticPill diagnostic={catalog.diagnostic} />
      </section>

      {catalog.diagnostic.status !== "ready" ? <DiagnosticBanner diagnostic={catalog.diagnostic} /> : null}
      {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
      {notice ? <div className={`notice notice-${notice.tone}`} role="status">{notice.message}</div> : null}

      <section className="toolbar" aria-label="Catalog filters">
        <label className="search-field">
          <SearchIcon />
          <span className="sr-only">Search apps</span>
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search apps, tags, or publishers" />
        </label>
        <label className="select-field">
          <span>Category</span>
          <select value={category} onChange={event => setCategory(event.target.value)}>
            <option value="all">All categories</option>
            {categories.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <span className="result-count">{filtered.length} {filtered.length === 1 ? "app" : "apps"}</span>
      </section>

      {loading && catalog.apps.length === 0 ? (
        <LoadingState />
      ) : filtered.length === 0 ? (
        <EmptyState configured={catalog.diagnostic.status === "ready"} />
      ) : (
        <section className="app-grid" aria-label="Catalog apps">
          {filtered.map(app => (
            <AppCard
              key={app.id}
              app={app}
              busy={detailLoading === app.id}
              onDetails={() => void loadDetail(app.id)}
              onInstall={() => void loadDetail(app.id, true)}
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

function AppCard({ app, busy, onDetails, onInstall }: {
  app: CatalogAppSummary;
  busy: boolean;
  onDetails: () => void;
  onInstall: () => void;
}) {
  return (
    <article className="app-card">
      <div className="card-heading">
        <AppIcon app={app} />
        <div className="card-title">
          <h2>{app.name}</h2>
          <span>{app.publisher?.name || app.id}</span>
        </div>
      </div>
      <p className="card-summary">{app.summary || "No catalog summary provided."}</p>
      <div className="tag-row">
        {app.category ? <span className="tag tag-category">{app.category}</span> : null}
        {app.tags.slice(0, 3).map(tag => <span className="tag" key={tag}>{tag}</span>)}
      </div>
      <div className="card-actions">
        <button className="button button-primary" type="button" onClick={onDetails}>Details</button>
        <button className="button button-secondary" type="button" onClick={onInstall} disabled={busy}>
          {busy ? <RefreshIcon spinning /> : <DownloadIcon />}
          Install
        </button>
      </div>
    </article>
  );
}

function AppIcon({ app }: { app: CatalogAppSummary }) {
  return (
    <div className="app-icon">
      {app.icon ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={app.icon} alt="" />
      ) : <span aria-hidden="true">⬡</span>}
    </div>
  );
}

function AppDetailDialog({ app, onClose, onInstall }: {
  app: CatalogAppDetailResponse;
  onClose: () => void;
  onInstall: (feed: CatalogAppFeed) => void;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    }}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="app-detail-title">
        <header className="dialog-header">
          <AppIcon app={app} />
          <div>
            <span className="eyebrow">{app.category || "Runtime app"}</span>
            <h2 id="app-detail-title">{app.name}</h2>
            <p>{app.summary || app.id}</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close app details">×</button>
        </header>

        <div className="dialog-body">
          <dl className="facts">
            <Fact label="App id" value={app.id} />
            <Fact label="Publisher" value={app.publisher?.name || "Unknown"} />
            <Fact label="Source" value={app.sourceName} />
            <Fact label="Signer" value={app.signerIdentity || "Not declared"} />
          </dl>

          {app.tags.length ? <div className="tag-row">{app.tags.map(tag => <span className="tag" key={tag}>{tag}</span>)}</div> : null}

          {app.screenshots.length ? (
            <div className="screenshots">
              {app.screenshots.map(source => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={source} src={source} alt={`${app.name} screenshot`} />
              ))}
            </div>
          ) : null}

          {app.description && app.descriptionUrl ? (
            <MarkdownDescription content={app.description} sourceUrl={app.descriptionUrl} />
          ) : app.descriptionUrl ? (
            <DiagnosticBanner diagnostic={app.descriptionDiagnostic} compact />
          ) : null}

          <section className="feed-section">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Install source</span>
                <h3>Available feeds</h3>
              </div>
              <DiagnosticPill diagnostic={app.feedDiagnostic} />
            </div>
            {app.feeds.length ? (
              <div className="feed-list">
                {app.feeds.map(feed => (
                  <div className="feed-row" key={feed.id}>
                    <div>
                      <strong>{feed.id}</strong>
                      {feed.default ? <span className="tag tag-category">Default</span> : null}
                      <small>{feed.manifestRef}</small>
                    </div>
                    <button className="button button-primary" type="button" onClick={() => onInstall(feed)}>
                      <DownloadIcon />
                      Install
                    </button>
                  </div>
                ))}
              </div>
            ) : <DiagnosticBanner diagnostic={app.feedDiagnostic} compact />}
            <p className="safety-note">Feed data shown here is informational. Core fetches and validates it independently during review.</p>
          </section>
        </div>
      </section>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function IdentityBadge({ identity }: { identity: MarketplaceIdentity | null }) {
  if (!identity) return <span className="identity-badge">Checking session…</span>;
  if (identity.status === "active") {
    return <span className="identity-badge identity-active">{identity.displayName || identity.email || identity.userId || "Host admin"}</span>;
  }
  return <span className="identity-badge">Host session {identity.status}</span>;
}

function DiagnosticPill({ diagnostic }: { diagnostic: CatalogDiagnostic }) {
  return <span className={`status-pill status-${diagnostic.status}`}>{diagnostic.status.replace("-", " ")}</span>;
}

function DiagnosticBanner({ diagnostic, compact = false }: { diagnostic: CatalogDiagnostic; compact?: boolean }) {
  return (
    <div className={`diagnostic diagnostic-${diagnostic.status}${compact ? " diagnostic-compact" : ""}`} role="status">
      <strong>{humanizeCode(diagnostic.code)}</strong>
      <span>{diagnostic.message}</span>
    </div>
  );
}

function LoadingState() {
  return <div className="empty-state"><RefreshIcon spinning /><h2>Loading catalog</h2><p>Reading the configured Marketplace source.</p></div>;
}

function EmptyState({ configured }: { configured: boolean }) {
  return (
    <div className="empty-state">
      <span className="empty-symbol" aria-hidden="true">◇</span>
      <h2>{configured ? "No matching apps" : "Marketplace is not ready"}</h2>
      <p>{configured ? "Try another search or category." : "Check the source diagnostic above or update the app setting in Hosty Shell."}</p>
    </div>
  );
}

function humanizeCode(code: string): string {
  return code.split("_").map(word => word[0]?.toUpperCase() + word.slice(1)).join(" ");
}

function SearchIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>;
}

function DownloadIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" /></svg>;
}

function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return <svg className={spinning ? "spin" : undefined} viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 9a7 7 0 0 1 11.6-2L20 9M4 15l2.3 2A7 7 0 0 0 18 15" /></svg>;
}
