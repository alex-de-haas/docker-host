"use client";

import { useCallback, useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { coreErrorCode, isAuthRequiredRedirectError } from "../core-api";
import { sanitizeSubdomainLabel } from "../public-origin";
import { useShellActions } from "../shell-context";
import type { CloudflareConnectionStatus, CloudflareCorePublication, CloudflareCorePublicationResult } from "../types";
import { InlineError } from "../ui";

// Publishing Core's own address, beside the app publications that use the same tunnel.
//
// It sits on the Ingress tab rather than in the per-app publish dialog because Core is not an app: it has
// no endpoint row to hang a control on, and the value it writes is a Core setting rather than an app's.
// What it does is otherwise the app flow exactly — a label, one proxied CNAME, one tunnel rule — which is
// why the copy here explains only what differs: the address is live immediately, and unpublishing puts
// back whatever the origin was before Hosty took it over.
export function CorePublicOriginCard() {
  const { coreOrigin, sendCsrfJson, refresh } = useShellActions();
  const [connection, setConnection] = useState<CloudflareConnectionStatus | null>(null);
  const [state, setState] = useState<CloudflareCorePublication | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  // Set when Core refuses because a DNS record for this hostname already exists. Adoption is offered,
  // never implied — the same rule the app publish dialog follows.
  const [conflict, setConflict] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Both in one pass: the connection decides whether this control can do anything at all, and a
      // second render that flips from "connect a token" to a form would read as a glitch.
      const [publicationResponse, statusResponse] = await Promise.all([
        sendCsrfJson(`${coreOrigin}/api/core/public-origin`, undefined, "GET"),
        sendCsrfJson(`${coreOrigin}/api/core/cloudflare/status`, undefined, "GET"),
      ]);
      const next = (await publicationResponse.json()) as CloudflareCorePublication;
      setState(next);
      setConnection((await statusResponse.json()) as CloudflareConnectionStatus);
      setLabel(next.publication?.label ?? "");
      setError(null);
    } catch (loadError) {
      if (!isAuthRequiredRedirectError(loadError)) {
        setError(loadError instanceof Error ? loadError.message : "Could not load Core's published address.");
      }
    } finally {
      setLoading(false);
    }
  }, [coreOrigin, sendCsrfJson]);

  useEffect(() => {
    void load();
  }, [load]);

  const publish = async (adopt = false) => {
    if (!label.trim()) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await sendCsrfJson(`${coreOrigin}/api/core/public-origin/publish`, { label: label.trim(), adopt });
      const result = (await response.json()) as CloudflareCorePublicationResult;
      setConflict(false);
      await load();
      await refresh();
      toast.success(`Core published at ${result.origin}`, {
        description: "Sign-in and invitation links use it now. Installed apps pick it up when they next start.",
      });
      if (result.locality === "not_local") {
        toast.warning("The Cloudflare connector is not on this host", {
          description: "Traffic for this address reaches whichever machine runs the connector, not this one.",
        });
      }
    } catch (publishError) {
      if (!isAuthRequiredRedirectError(publishError)) {
        setConflict(coreErrorCode(publishError) === "cloudflare_hostname_conflict");
        setError(publishError instanceof Error ? publishError.message : "Publishing Core's address failed.");
      }
    } finally {
      setBusy(false);
    }
  };

  const unpublish = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await sendCsrfJson(`${coreOrigin}/api/core/public-origin/unpublish`, {});
      const result = (await response.json()) as CloudflareCorePublicationResult;
      await load();
      await refresh();
      toast.success("Core's published address removed", { description: `Core now advertises ${result.origin}.` });
    } catch (unpublishError) {
      if (!isAuthRequiredRedirectError(unpublishError)) {
        setError(unpublishError instanceof Error ? unpublishError.message : "Removing Core's address failed.");
      }
    } finally {
      setBusy(false);
    }
  };

  const connected = connection?.status === "connected";
  const suffix = connection?.baseDomain ? `.${connection.baseDomain}` : "";
  const publication = state?.publication ?? null;
  // Re-publishing under the same label repairs a drifted route; a changed label renames in place. With
  // neither there is nothing to press.
  const renaming = publication !== null && label.trim() !== publication.label;
  const repairable = publication?.state === "origin_drifted" || publication?.state === "error";

  return (
    <div className="space-y-2">
      <div>
        <h3 className="text-sm font-medium">Core&apos;s own address</h3>
        <p className="text-xs text-muted-foreground">
          The address Core tells the world it lives at — the one in invitation links, in the native client&apos;s
          sign-in, and in the metadata agent clients read. Publishing it adds a route and a DNS record the same
          way publishing an app endpoint does. Core keeps answering on its local address either way.
        </p>
      </div>

      {error && <InlineError message={error} />}

      {loading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> Loading…
        </p>
      ) : !connected ? (
        <p className="text-xs text-muted-foreground">
          Connect a Cloudflare API token above to publish Core&apos;s address. You can always set it by hand under
          Settings → Core.
        </p>
      ) : (
        <div className="space-y-2 rounded-md border p-3">
          <div className="space-y-1 text-xs">
            <div className="text-muted-foreground">Currently advertising</div>
            <div className="font-mono text-foreground">{state?.origin}</div>
            {publication === null && state?.configured && (
              <p className="text-muted-foreground">
                Set by hand rather than published here. Publishing replaces it, and unpublishing later puts it back.
              </p>
            )}
            {publication?.ownershipState === "adopted" && (
              <p className="text-muted-foreground">
                Adopted: Hosty manages this DNS record but did not create it, so unpublishing leaves it in place.
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium" htmlFor="core-public-origin-label">
              Subdomain label
            </label>
            <div className="flex items-center gap-1">
              <Input
                id="core-public-origin-label"
                value={label}
                onChange={(event) => {
                  setConflict(false);
                  setLabel(sanitizeSubdomainLabel(event.target.value));
                }}
                placeholder="core"
                className="h-8 text-xs"
                disabled={busy}
              />
              {suffix && <span className="whitespace-nowrap text-xs text-muted-foreground">{suffix}</span>}
            </div>
            {label.trim() && suffix && (
              <p className="text-[11px] text-muted-foreground">
                → https://{label.trim()}
                {suffix}
              </p>
            )}
          </div>

          {conflict && (
            <p className="text-[11px] text-muted-foreground">
              A DNS record for that hostname already exists and Hosty did not create it. Adopting means Hosty manages
              it from now on; it stays yours, so unpublishing removes the route and leaves the record.
            </p>
          )}

          <div className="flex items-center gap-2">
            {conflict && (
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void publish(true)}>
                {busy && <LoaderCircle className="mr-1 size-3.5 animate-spin" aria-hidden />}
                Adopt and publish
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              disabled={busy || !label.trim() || (publication !== null && !renaming && !repairable)}
              onClick={() => void publish()}
            >
              {busy && <LoaderCircle className="mr-1 size-3.5 animate-spin" aria-hidden />}
              {publication === null ? "Publish" : renaming ? "Rename" : "Reapply"}
            </Button>
            {publication !== null && (
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void unpublish()}>
                {busy && <LoaderCircle className="mr-1 size-3.5 animate-spin" aria-hidden />}
                Unpublish
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
