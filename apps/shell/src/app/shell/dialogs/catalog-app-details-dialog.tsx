"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, Download, LoaderCircle, Package } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { getCatalogApp } from "../catalog-api";
import { MarkdownDescription } from "../markdown-description";
import type { CatalogAppFeed, CatalogDetailState } from "../types";
import { EmptyState, Fact, InlineError } from "../ui";

// Only follow http(s) links from catalog metadata (authored by external sources), never javascript:/data:.
function httpUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

// Marketplace detail for one catalog app. Loads the full entry (display + declared feeds). For an app
// that is not installed, the footer Install button hands the chosen feed's manifestRef (and the feed
// id, recorded as the followed feed) to the existing reviewed install flow (the catalog installs
// nothing itself); with several feeds it is a split button whose menu lists them, defaulting to the
// feed marked default. The footer stays visible while the body scrolls, so a long description never
// hides the install action. Already-installed apps are managed from Installed Apps — installing there
// would just return "already installed", so it is not offered here.
export function CatalogAppDetailsDialog({
  coreOrigin,
  appId,
  onClose,
  onInstall,
}: {
  coreOrigin: string;
  appId: string;
  onClose: () => void;
  onInstall: (manifestRef: string, catalogFeedId?: string) => void;
}) {
  const [state, setState] = useState<CatalogDetailState>({ loading: true, error: null, app: null });
  const abortRef = useRef<AbortController | null>(null);

  // Load after the fetch resolves only (initial `loading: true` comes from the initial state), so the
  // mount effect does not setState synchronously. The dialog is remounted per app via a `key`; an
  // AbortSignal cancels the fetch on unmount so a stale response can't setState the wrong app.
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const app = await getCatalogApp(coreOrigin, appId, signal);
      setState({ loading: false, error: null, app });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      setState({ loading: false, error: error instanceof Error ? error.message : "Failed to load catalog app.", app: null });
    }
  }, [coreOrigin, appId]);

  // Defer to a macrotask so the setState lands outside the effect's synchronous body (matches the
  // observability pages' load pattern); abort on unmount.
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    const handle = setTimeout(() => void load(controller.signal), 0);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [load]);

  const app = state.app;
  const feeds = app?.feeds ?? [];
  // Core normalizes a sole feed to default: true; several feeds without one means no unambiguous
  // choice, so the footer offers only the feed menu (A4: feed order carries no meaning).
  const defaultFeed = feeds.find((feed) => feed.default) ?? null;
  const publisherUrl = httpUrl(app?.publisher?.url);
  const installFeed = (feed: CatalogAppFeed) => {
    onInstall(feed.manifestRef, feed.id);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            {app?.icon && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={app.icon} alt="" className="size-14 shrink-0 rounded-md object-contain" />
            )}
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex min-w-0 items-center gap-2">
                <DialogTitle className="truncate">{app?.name ?? appId}</DialogTitle>
                {app?.installed && (
                  <Badge variant="outline" className="shrink-0 gap-1 border-transparent bg-emerald-500/10 text-emerald-700">
                    <CheckCircle2 className="h-3 w-3" />
                    Installed
                  </Badge>
                )}
              </div>
              <DialogDescription>{app?.summary ?? "Marketplace app details."}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {state.error && <InlineError message={state.error} />}
          {state.loading && <EmptyState icon={LoaderCircle} title="Loading app" iconClassName="animate-spin" />}

          {app && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Fact label="Publisher" value={app.publisher?.name || "Unknown"} />
                <Fact label="Category" value={app.category || "Uncategorized"} />
                <Fact label="Source" value={app.sourceName} />
              </div>

              {app.tags && app.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {app.tags.map((tag) => (
                    <Badge key={tag} variant="outline">
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}

              {app.screenshots && app.screenshots.length > 0 && (
                <div className="flex gap-2 overflow-x-auto">
                  {app.screenshots.map((src) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={src} src={src} alt="" className="h-40 rounded-md border object-cover" />
                  ))}
                </div>
              )}

              {app.descriptionUrl && <MarkdownDescription src={app.descriptionUrl} />}

              {!app.installed && feeds.length === 0 && (
                <p className="text-sm text-muted-foreground">This app declares no feeds; install it from its source directly.</p>
              )}
              {app.installed && (
                <p className="text-sm text-muted-foreground">
                  {app.updateAvailable
                    ? `Update available from the '${app.followedFeedId}' feed. Manage updates from Installed Apps.`
                    : app.followedFeedId
                      ? `Installed${app.installedVersion ? ` (${app.installedVersion})` : ""}, following '${app.followedFeedId}'. Manage updates from Installed Apps.`
                      : `Installed${app.installedVersion ? ` (${app.installedVersion})` : ""}. No feed set — choose one in the app's settings to receive updates.`}
                </p>
              )}

              {publisherUrl && (
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Package className="h-4 w-4" />
                  <a href={publisherUrl} target="_blank" rel="noreferrer" className="underline">
                    {publisherUrl}
                  </a>
                </p>
              )}
            </>
          )}
        </DialogBody>

        <DialogFooter className="sm:justify-between">
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
          {app && !app.installed && feeds.length > 0 && (
            feeds.length === 1 ? (
              <Button type="button" onClick={() => installFeed(feeds[0])}>
                <Download className="h-4 w-4" />
                Install
              </Button>
            ) : (
              <div className="flex">
                {defaultFeed && (
                  <Button type="button" className="relative flex-1 rounded-r-none focus-visible:z-10" onClick={() => installFeed(defaultFeed)}>
                    <Download className="h-4 w-4" />
                    {`Install '${defaultFeed.id}'`}
                  </Button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    {defaultFeed ? (
                      <Button type="button" size="icon" className="relative rounded-l-none border-l border-primary-foreground/20 focus-visible:z-10">
                        <ChevronDown className="h-4 w-4" />
                        <span className="sr-only">Install from another feed</span>
                      </Button>
                    ) : (
                      <Button type="button" className="flex-1">
                        <Download className="h-4 w-4" />
                        Install
                        <ChevronDown className="h-4 w-4" />
                      </Button>
                    )}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {feeds.map((feed) => (
                      <DropdownMenuItem key={feed.id} onSelect={() => installFeed(feed)}>
                        {feed.id}
                        {feed.default && (
                          <Badge variant="secondary" className="ml-auto">
                            Default
                          </Badge>
                        )}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
