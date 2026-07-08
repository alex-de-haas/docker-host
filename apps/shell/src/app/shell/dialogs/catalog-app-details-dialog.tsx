"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, LoaderCircle, Package } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getCatalogApp } from "../catalog-api";
import { MarkdownDescription } from "../markdown-description";
import type { CatalogAppVersion, CatalogDetailState } from "../types";
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

// Marketplace detail for one catalog app. Loads the full entry (display + resolved feed versions). For an
// app that is not installed, a version's Install button hands its manifestRef to the existing reviewed
// install flow (the catalog installs nothing itself). Already-installed apps are managed from Installed
// Apps — installing a version there would just return "already installed", so it is not offered here.
export function CatalogAppDetailsDialog({
  coreOrigin,
  appId,
  onClose,
  onInstall,
}: {
  coreOrigin: string;
  appId: string;
  onClose: () => void;
  onInstall: (manifestRef: string) => void;
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
  const publisherUrl = httpUrl(app?.publisher?.url);
  const installVersion = (version: CatalogAppVersion) => {
    onInstall(version.manifestRef);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{app?.name ?? appId}</DialogTitle>
          <DialogDescription>{app?.summary ?? "Marketplace app details."}</DialogDescription>
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
                <Fact label="Installed" value={app.installed ? app.installedVersion || "yes" : "no"} />
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

              <div className="space-y-2">
                <h3 className="text-sm font-medium">Versions</h3>
                {!app.versions || app.versions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {app.releasesUrl ? "No versions published in the release feed." : "This app declares no release feed; install it from its source directly."}
                  </p>
                ) : (
                  <div className="divide-y rounded-md border">
                    {app.versions.map((version) => (
                      <div key={version.version} className="flex items-center justify-between gap-3 px-3 py-2">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="font-medium">{version.version}</span>
                          {version.version === app.stableVersion && <Badge variant="secondary">Stable</Badge>}
                          {version.version === app.betaVersion && <Badge variant="outline">Beta</Badge>}
                          {version.artifact?.kind && <Badge variant="outline">{version.artifact.kind}</Badge>}
                          {version.version === app.installedVersion && <Badge variant="outline">Installed</Badge>}
                        </div>
                        {!app.installed && (
                          <Button type="button" size="sm" variant="outline" onClick={() => installVersion(version)}>
                            <Download className="h-4 w-4" />
                            Install
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {app.installed && (
                  <p className="text-sm text-muted-foreground">
                    {app.updateAvailable && app.installedVersion && app.stableVersion
                      ? `Update available: ${app.installedVersion} → ${app.stableVersion}. Manage updates from Installed Apps.`
                      : `Installed${app.installedVersion ? ` (${app.installedVersion})` : ""}. Manage updates from Installed Apps.`}
                  </p>
                )}
              </div>

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

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
