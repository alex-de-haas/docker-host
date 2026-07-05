"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowUpCircle, Download, LoaderCircle, Package } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getCatalogApp } from "../catalog-api";
import type { CatalogAppVersion, CatalogDetailState } from "../types";
import { EmptyState, Fact, InlineError } from "../ui";

// Marketplace detail for one catalog app. Loads the full entry (display + resolved feed versions) and
// lets the operator kick off an install/update for a chosen version — which hands its manifestRef to the
// existing reviewed install flow (the catalog installs nothing itself).
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

  // Load after the fetch resolves only (initial `loading: true` comes from the initial state), so the
  // mount effect does not setState synchronously. The dialog is remounted per app via a `key`.
  const load = useCallback(async () => {
    try {
      const app = await getCatalogApp(coreOrigin, appId);
      setState({ loading: false, error: null, app });
    } catch (error) {
      setState({ loading: false, error: error instanceof Error ? error.message : "Failed to load catalog app.", app: null });
    }
  }, [coreOrigin, appId]);

  // Defer to a macrotask so the setState lands outside the effect's synchronous body (matches the
  // observability pages' load pattern).
  useEffect(() => {
    const handle = setTimeout(() => void load(), 0);
    return () => clearTimeout(handle);
  }, [load]);

  const app = state.app;
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
              {app.updateAvailable && app.installedVersion && app.stableVersion && (
                <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
                  <ArrowUpCircle className="h-4 w-4 shrink-0" />
                  Update available: {app.installedVersion} → {app.stableVersion}
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <Fact label="Publisher" value={app.publisher?.name || "Unknown"} />
                <Fact label="Category" value={app.category || "Uncategorized"} />
                <Fact label="Source" value={app.sourceName} />
                <Fact label="Installed" value={app.installed ? app.installedVersion || "yes" : "no"} />
              </div>

              {app.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {app.tags.map((tag) => (
                    <Badge key={tag} variant="outline">
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}

              {app.screenshots.length > 0 && (
                <div className="flex gap-2 overflow-x-auto">
                  {app.screenshots.map((src) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={src} src={src} alt="" className="h-40 rounded-md border object-cover" />
                  ))}
                </div>
              )}

              <div className="space-y-2">
                <h3 className="text-sm font-medium">Versions</h3>
                {app.versions.length === 0 ? (
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
                        <Button type="button" size="sm" variant="outline" onClick={() => installVersion(version)}>
                          {app.installed ? <ArrowUpCircle className="h-4 w-4" /> : <Download className="h-4 w-4" />}
                          {app.installed ? "Install version" : "Install"}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {app.publisher?.url && (
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Package className="h-4 w-4" />
                  <a href={app.publisher.url} target="_blank" rel="noreferrer" className="underline">
                    {app.publisher.url}
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
