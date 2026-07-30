"use client";

import { useState } from "react";
import { Cloud, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { isAuthRequiredRedirectError } from "../core-api";
import { publishesThroughCloudflareApi } from "../ingress";
import { useShellActions, useShellState } from "../shell-context";
import type { CloudflareAppPublications, CloudflareConnectionStatus, CloudflarePublicationResult, CloudflarePublicationSummary, CoreApp, CoreEndpoint } from "../types";
import { IconButton, InlineError } from "../ui";

// Per-endpoint Cloudflare publish control on the installed-apps page. Opening the dialog loads the
// connection (to know the base domain) and this app's publications; the operator enters a subdomain label
// to publish `https://<label>.<domain>` (synchronized to DNS + the tunnel route by Core) or unpublishes an
// existing one. Self-contained via context; host-admin only, and only for `public: true` endpoints.
export function CloudflarePublishControl({ app, endpoint }: { app: CoreApp; endpoint: CoreEndpoint }) {
  const { canManageApps, state } = useShellState();
  const { coreOrigin, sendCsrfJson, refresh } = useShellActions();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<CloudflareConnectionStatus | null>(null);
  const [publication, setPublication] = useState<CloudflarePublicationSummary | null>(null);
  const [label, setLabel] = useState("");

  // Publishing is what the API provider means, so the control belongs to it and to nothing else. Under
  // any other provider Core refuses the publish outright (cloudflare_provider_inactive), and under the
  // local-config provider a published label would be overwritten by the derived hostname on the next
  // start — the defect this split removed. Not connected yet is a different case: the control stays and
  // says so, because that is a step away rather than the wrong provider.
  if (!canManageApps || !endpoint.public || !publishesThroughCloudflareApi(state.status?.ingressProvider)) {
    return null;
  }

  const appBase = `${coreOrigin}/api/apps/${encodeURIComponent(app.id)}/public-origins`;

  const openDialog = async () => {
    setOpen(true);
    setError(null);
    setConnection(null);
    setPublication(null);
    setLabel("");
    setLoading(true);
    try {
      const [statusResponse, publicationsResponse] = await Promise.all([
        sendCsrfJson(`${coreOrigin}/api/core/cloudflare/status`, undefined, "GET"),
        sendCsrfJson(appBase, undefined, "GET"),
      ]);
      setConnection((await statusResponse.json()) as CloudflareConnectionStatus);
      const publications = (await publicationsResponse.json()) as CloudflareAppPublications;
      const mine = publications?.publications?.find((entry) => entry.endpointKey === endpoint.key) ?? null;
      setPublication(mine);
      if (mine) {
        setLabel(mine.label);
      }
    } catch (loadError) {
      if (!isAuthRequiredRedirectError(loadError)) {
        setError(loadError instanceof Error ? loadError.message : "Could not load the publication status.");
      }
    } finally {
      setLoading(false);
    }
  };

  const publish = async () => {
    if (!label.trim()) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await sendCsrfJson(`${appBase}/publish`, { endpointKey: endpoint.key, label: label.trim() });
      const result = (await response.json()) as CloudflarePublicationResult;
      setOpen(false);
      await refresh();
      toast.success(`Published ${result.publicOrigin}`, {
        description: result.restartRequired ? `Restart ${app.displayName} to apply the new origin.` : undefined,
      });
    } catch (publishError) {
      if (!isAuthRequiredRedirectError(publishError)) {
        setError(publishError instanceof Error ? publishError.message : "Publishing the public origin failed.");
      }
    } finally {
      setBusy(false);
    }
  };

  const unpublish = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await sendCsrfJson(`${appBase}/unpublish`, { endpointKey: endpoint.key });
      const result = (await response.json()) as CloudflarePublicationResult;
      setOpen(false);
      await refresh();
      toast.success("Public origin removed", {
        description: result.restartRequired ? `Restart ${app.displayName} to drop the old origin.` : undefined,
      });
    } catch (unpublishError) {
      if (!isAuthRequiredRedirectError(unpublishError)) {
        setError(unpublishError instanceof Error ? unpublishError.message : "Removing the public origin failed.");
      }
    } finally {
      setBusy(false);
    }
  };

  const connected = connection?.status === "connected";
  const suffix = connection?.baseDomain ? `.${connection.baseDomain}` : "";

  return (
    <>
      <IconButton title="Publish public origin (Cloudflare)" onClick={() => void openDialog()}>
        <Cloud className="h-4 w-4" />
      </IconButton>
      <Dialog open={open} onOpenChange={(next) => { if (!busy && !loading) setOpen(next); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Public origin — {endpoint.key}</DialogTitle>
            <DialogDescription>Publish this endpoint at an HTTPS origin on your Cloudflare tunnel.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : !connected ? (
              // A load failure leaves connection null with an error set; distinguish it from a genuine
              // disconnected state so the "connect Cloudflare" hint is not shown misleadingly.
              error ? (
                <div className="space-y-2">
                  <InlineError message={error} />
                  <Button type="button" size="sm" variant="outline" onClick={() => void openDialog()}>Retry</Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Cloudflare is the selected ingress provider, but no API token is connected yet. Connect one under
                  Settings → Ingress, then publish this endpoint.
                </p>
              )
            ) : publication ? (
              <div className="space-y-1 text-sm">
                <div className="text-muted-foreground">Published at</div>
                <div className="font-mono">{publication.publicOrigin ?? `https://${publication.hostname}`}</div>
              </div>
            ) : (
              <div className="space-y-1">
                <label className="text-xs font-medium" htmlFor="cf-label">Subdomain label</label>
                <div className="flex items-center gap-1">
                  <Input
                    id="cf-label"
                    value={label}
                    onChange={(event) => setLabel(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                    placeholder="media"
                    className="h-8 text-xs"
                  />
                  {suffix && <span className="whitespace-nowrap text-xs text-muted-foreground">{suffix}</span>}
                </div>
                {label.trim() && <p className="text-[11px] text-muted-foreground">→ https://{label.trim()}{suffix}</p>}
              </div>
            )}
            {/* Action (publish/unpublish) errors while connected are shown inline; a load error is handled above. */}
            {connected && error && <InlineError message={error} />}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Close</Button>
            {connected && publication ? (
              <Button type="button" variant="outline" disabled={busy} onClick={() => void unpublish()}>
                {busy && <LoaderCircle className="mr-1 h-4 w-4 animate-spin" />}
                Unpublish
              </Button>
            ) : connected ? (
              <Button type="button" disabled={busy || !label.trim()} onClick={() => void publish()}>
                {busy && <LoaderCircle className="mr-1 h-4 w-4 animate-spin" />}
                Publish
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
