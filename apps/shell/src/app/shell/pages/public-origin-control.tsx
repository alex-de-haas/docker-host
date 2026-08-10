"use client";

import { useState } from "react";
import { Globe, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { coreErrorCode, isAuthRequiredRedirectError } from "../core-api";
import { derivesPublicOrigins, publishesThroughCloudflareApi } from "../ingress";
import { buildPublicOriginSettingKey, sanitizeSubdomainLabel } from "../public-origin";
import { useShellActions, useShellState } from "../shell-context";
import type { CloudflareAppPublications, CloudflareConnectionStatus, CloudflarePublicationResult, CloudflarePublicationState, CloudflarePublicationSummary, CoreApp, CoreEndpoint } from "../types";
import { IconButton, InlineError } from "../ui";

// What each publication state means for the operator. Core produces every one of these except
// "not_configured", which is the absence of a publication and never reaches this branch.
const PUBLICATION_STATE_TEXT: Record<CloudflarePublicationState, string> = {
  not_configured: "",
  active: "Live: the app is running and serving this address.",
  app_stopped: "The app is stopped. It serves this address again when it next starts.",
  restart_required: "The app is still serving its previous address. Restart it to apply this one.",
  origin_drifted: "This address still routes to the app's previous local port. Reapply to repair it.",
  error: "Cloudflare cannot be reached with the stored token, so this cannot be verified or changed right now.",
};

// The app-scoped subdomain the local-config provider derives every hostname from.
const SUBDOMAIN_SETTING_KEY = "HOSTY_INGRESS_SUBDOMAIN";

// One control for an endpoint's public origin, under every ingress provider.
//
// It replaces two surfaces that answered the same question in different places: a gear that opened the
// app's settings dialog to type a URL, and a cloud that opened a separate publish dialog. Which one an
// operator needed depended on the active provider, so they had to know the provider before they could
// find the field. Here the question is always "what is this endpoint's public address" and the provider
// only decides what the answer is made of, and what applying it does.
//
// The three shapes are genuinely different in reversibility, and the dialog keeps that visible rather
// than flattening it: `none` is a local string, `cloudflared` is a local string Core renders into a
// config file, and `cloudflare-remote` mutates DNS and a remotely managed tunnel — where clearing the
// field deletes a DNS record and adopting a pre-existing one is never implied.
export function PublicOriginControl({ app, endpoint }: { app: CoreApp; endpoint: CoreEndpoint }) {
  const { canManageApps, state } = useShellState();
  const { coreOrigin, sendCsrfJson, refresh, runAppAction } = useShellActions();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<CloudflareConnectionStatus | null>(null);
  const [publication, setPublication] = useState<CloudflarePublicationSummary | null>(null);
  const [value, setValue] = useState("");
  // Set when Core refuses because a DNS record for this hostname already exists. Adoption is offered,
  // never implied: an unasked-for takeover would let a typo point someone else's hostname at a local app.
  const [conflict, setConflict] = useState(false);

  const provider = state.status?.ingressProvider;
  const publishes = publishesThroughCloudflareApi(provider);
  const derives = derivesPublicOrigins(provider);

  if (!canManageApps || !endpoint.public) {
    return null;
  }

  const appBase = `${coreOrigin}/api/apps/${encodeURIComponent(app.id)}`;
  const originSettingKey = buildPublicOriginSettingKey(endpoint.key);
  const currentOrigin = app.settings?.find((setting) => setting.key === originSettingKey)?.value ?? "";
  const currentSubdomain = app.settings?.find((setting) => setting.key === SUBDOMAIN_SETTING_KEY)?.value ?? "";

  const openDialog = async () => {
    setOpen(true);
    setError(null);
    setConflict(false);
    setConnection(null);
    setPublication(null);
    setValue(publishes ? "" : derives ? currentSubdomain : currentOrigin);
    if (!publishes) {
      return;
    }

    setLoading(true);
    try {
      const [statusResponse, publicationsResponse] = await Promise.all([
        sendCsrfJson(`${coreOrigin}/api/core/cloudflare/status`, undefined, "GET"),
        sendCsrfJson(`${appBase}/public-origins`, undefined, "GET"),
      ]);
      setConnection((await statusResponse.json()) as CloudflareConnectionStatus);
      const publications = (await publicationsResponse.json()) as CloudflareAppPublications;
      const mine = publications?.publications?.find((entry) => entry.endpointKey === endpoint.key) ?? null;
      setPublication(mine);
      if (mine) {
        setValue(mine.label);
      }
    } catch (loadError) {
      if (!isAuthRequiredRedirectError(loadError)) {
        setError(loadError instanceof Error ? loadError.message : "Could not load the publication status.");
      }
    } finally {
      setLoading(false);
    }
  };

  // The local half: `none` writes the origin itself, `cloudflared` writes the subdomain Core derives it
  // from. Both are plain settings writes, instantly reversible, so neither asks for confirmation.
  const saveSetting = async () => {
    setBusy(true);
    setError(null);
    try {
      const key = derives ? SUBDOMAIN_SETTING_KEY : originSettingKey;
      await sendCsrfJson(`${appBase}/configure`, { settings: { [key]: value.trim() || null } });
      setOpen(false);
      await refresh();
      toast.success(derives ? "Subdomain saved" : value.trim() ? "Public origin saved" : "Public origin cleared");
    } catch (saveError) {
      if (!isAuthRequiredRedirectError(saveError)) {
        setError(saveError instanceof Error ? saveError.message : "Saving the public origin failed.");
      }
    } finally {
      setBusy(false);
    }
  };

  const publish = async (adopt = false) => {
    if (!value.trim()) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await sendCsrfJson(`${appBase}/public-origins/publish`, { endpointKey: endpoint.key, label: value.trim(), adopt });
      const result = (await response.json()) as CloudflarePublicationResult;
      setOpen(false);
      setConflict(false);
      await refresh();
      toast.success(`Published ${result.publicOrigin}`, {
        // A running app keeps serving the old address until it restarts, so the restart is offered right
        // here rather than described and left for the operator to go and find.
        description: result.restartRequired
          ? `${app.displayName} is still serving its previous address.`
          : `The address is live the next time ${app.displayName} starts.`,
        action: result.restartRequired
          ? { label: "Restart now", onClick: () => void runAppAction(app, "restart") }
          : undefined,
      });
      if (result.locality === "not_local") {
        toast.warning("The Cloudflare connector is not on this host", {
          description: "Traffic for this address reaches whichever machine runs the connector, not this one.",
        });
      }
    } catch (publishError) {
      if (!isAuthRequiredRedirectError(publishError)) {
        setConflict(coreErrorCode(publishError) === "cloudflare_hostname_conflict");
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
      const response = await sendCsrfJson(`${appBase}/public-origins/unpublish`, { endpointKey: endpoint.key });
      const result = (await response.json()) as CloudflarePublicationResult;
      setOpen(false);
      await refresh();
      toast.success("Public origin removed", {
        description: result.restartRequired ? `${app.displayName} is still serving the old address.` : undefined,
        action: result.restartRequired
          ? { label: "Restart now", onClick: () => void runAppAction(app, "restart") }
          : undefined,
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
      <IconButton title="Configure public origin" onClick={() => void openDialog()}>
        <Globe className="h-4 w-4" />
      </IconButton>
      <Dialog open={open} onOpenChange={(next) => { if (!busy && !loading) setOpen(next); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Public origin — {endpoint.key}</DialogTitle>
            <DialogDescription>
              {publishes
                ? "Publish this endpoint at an HTTPS origin on your Cloudflare tunnel."
                : derives
                  ? "Core derives this endpoint's address from the ingress base domain and the app's subdomain."
                  : "The external address this endpoint is reachable at. You own it: point your own proxy or tunnel at the local URL."}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : publishes ? (
              !connected ? (
                // A load failure leaves connection null with an error set; distinguish it from a genuine
                // disconnected state so the "connect Cloudflare" hint is not shown misleadingly.
                error ? (
                  <div className="space-y-2">
                    <InlineError message={error} />
                    <Button type="button" size="sm" variant="outline" onClick={() => void openDialog()}>Retry</Button>
                  </div>
                ) : connection?.status === "reconnect_required" ? (
                  <p className="text-sm text-muted-foreground">
                    The stored Cloudflare token stopped working{connection.reconnectReason ? ` — ${connection.reconnectReason}` : "."} Reconnect
                    under Settings → Ingress; nothing published was removed, so it all works again afterwards.
                  </p>
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
                  <p className="text-xs text-muted-foreground">{PUBLICATION_STATE_TEXT[publication.state] ?? ""}</p>
                  {publication.ownershipState === "adopted" && (
                    <p className="text-[11px] text-muted-foreground">
                      Adopted: Hosty manages this DNS record but did not create it, so unpublishing leaves it in place.
                    </p>
                  )}
                </div>
              ) : (
                <LabelField
                  id="public-origin-label"
                  label="Subdomain label"
                  value={value}
                  suffix={suffix}
                  onChange={(next) => { setConflict(false); setValue(next); }}
                />
              )
            ) : derives ? (
              <div className="space-y-1">
                <LabelField
                  id="public-origin-subdomain"
                  label="App subdomain"
                  value={value}
                  suffix=""
                  onChange={setValue}
                />
                <p className="text-[11px] text-muted-foreground">
                  This is the app&apos;s subdomain, so it moves every public endpoint of {app.displayName}, not just
                  this one. Leave it empty to use the app id.
                </p>
                {endpoint.publicOrigin && (
                  <p className="text-[11px] text-muted-foreground">Currently: {endpoint.publicOrigin}</p>
                )}
              </div>
            ) : (
              <div className="space-y-1">
                <label className="text-xs font-medium" htmlFor="public-origin-url">Public origin</label>
                <Input
                  id="public-origin-url"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder="https://app.example.com"
                  className="h-8 text-xs"
                />
                <p className="text-[11px] text-muted-foreground">
                  Nothing on this host serves it — Core only hands it to the app so its own links are right.
                </p>
              </div>
            )}
            {/* Action errors while usable are shown inline; a load error is handled above. */}
            {(!publishes || connected) && error && <InlineError message={error} />}
            {conflict && (
              <p className="text-[11px] text-muted-foreground">
                Adopting means Hosty manages this record from now on. It stays yours: unpublishing removes the
                tunnel route and leaves the DNS record in place.
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Close</Button>
            {publishes ? (
              connected && publication ? (
                <Button type="button" variant="outline" disabled={busy} onClick={() => void unpublish()}>
                  {busy && <LoaderCircle className="mr-1 h-4 w-4 animate-spin" />}
                  Unpublish
                </Button>
              ) : connected ? (
                <>
                  {conflict && (
                    <Button type="button" variant="outline" disabled={busy} onClick={() => void publish(true)}>
                      {busy && <LoaderCircle className="mr-1 h-4 w-4 animate-spin" />}
                      Adopt and publish
                    </Button>
                  )}
                  <Button type="button" disabled={busy || !value.trim()} onClick={() => void publish()}>
                    {busy && <LoaderCircle className="mr-1 h-4 w-4 animate-spin" />}
                    Publish
                  </Button>
                </>
              ) : null
            ) : (
              <Button type="button" disabled={busy} onClick={() => void saveSetting()}>
                {busy && <LoaderCircle className="mr-1 h-4 w-4 animate-spin" />}
                Save
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// A DNS-label input with a live preview of the hostname it produces. Shared by the two providers that
// take a label rather than a URL, which is what makes them feel like one control with one shape.
function LabelField({
  id,
  label,
  value,
  suffix,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  suffix: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium" htmlFor={id}>{label}</label>
      <div className="flex items-center gap-1">
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(sanitizeSubdomainLabel(event.target.value))}
          placeholder="media"
          className="h-8 text-xs"
        />
        {suffix && <span className="whitespace-nowrap text-xs text-muted-foreground">{suffix}</span>}
      </div>
      {value.trim() && suffix && <p className="text-[11px] text-muted-foreground">→ https://{value.trim()}{suffix}</p>}
    </div>
  );
}
