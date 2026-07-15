"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isAuthRequiredRedirectError } from "../core-api";
import { useShellActions } from "../shell-context";
import type { CloudflareConnectionStatus, CloudflareTokenTemplate } from "../types";
import { InlineError } from "../ui";

// The Cloudflare ingress connection card in the Platform dialog: paste a scoped token to connect, see the
// discovered account/zone/tunnel + connector health once connected, and disconnect. Self-contained — it
// reads sendCsrfJson/coreOrigin from context and fetches its own status. The raw token is only ever sent to
// Core (masked in the status), never shown back.
export function CloudflareConnectionCard() {
  const { coreOrigin, sendCsrfJson } = useShellActions();
  const [status, setStatus] = useState<CloudflareConnectionStatus | null>(null);
  const [template, setTemplate] = useState<CloudflareTokenTemplate | null>(null);
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [statusResponse, templateResponse] = await Promise.all([
        sendCsrfJson(`${coreOrigin}/api/core/cloudflare/status`, undefined, "GET"),
        sendCsrfJson(`${coreOrigin}/api/core/cloudflare/token-template`, undefined, "GET"),
      ]);
      setStatus((await statusResponse.json()) as CloudflareConnectionStatus);
      setTemplate((await templateResponse.json()) as CloudflareTokenTemplate);
      setError(null);
    } catch (loadError) {
      if (!isAuthRequiredRedirectError(loadError)) {
        setError(loadError instanceof Error ? loadError.message : "Could not load the Cloudflare status.");
      }
    } finally {
      setLoading(false);
    }
  }, [coreOrigin, sendCsrfJson]);

  useEffect(() => {
    void load();
  }, [load]);

  const connect = async () => {
    if (!token.trim()) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await sendCsrfJson(`${coreOrigin}/api/core/cloudflare/connect`, { token: token.trim() });
      setToken("");
      await load();
      toast.success("Cloudflare connected");
    } catch (connectError) {
      if (!isAuthRequiredRedirectError(connectError)) {
        setError(connectError instanceof Error ? connectError.message : "Connecting to Cloudflare failed.");
      }
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await sendCsrfJson(`${coreOrigin}/api/core/cloudflare/disconnect`, {});
      await load();
      toast.success("Cloudflare disconnected");
    } catch (disconnectError) {
      if (!isAuthRequiredRedirectError(disconnectError)) {
        setError(disconnectError instanceof Error ? disconnectError.message : "Disconnecting from Cloudflare failed.");
      }
    } finally {
      setBusy(false);
    }
  };

  const connected = status?.status === "connected";

  return (
    <div className="space-y-2">
      <div>
        <h3 className="text-sm font-medium">Cloudflare ingress</h3>
        <p className="text-xs text-muted-foreground">
          Connect a scoped Cloudflare API token to publish app endpoints at public HTTPS origins on your tunnel.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircle className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : connected ? (
        <div className="space-y-1.5 rounded-md border p-3 text-xs">
          <div className="flex items-center justify-between">
            <span className="font-medium text-emerald-600 dark:text-emerald-400">Connected</span>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void disconnect()}>
              {busy && <LoaderCircle className="mr-1 h-4 w-4 animate-spin" />}
              Disconnect
            </Button>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted-foreground">
            <div>Account: <span className="text-foreground">{status?.accountName}</span></div>
            <div>Domain: <span className="text-foreground">{status?.baseDomain}</span></div>
            <div>Tunnel: <span className="text-foreground">{status?.tunnelName}</span></div>
            <div>Connector: <span className="text-foreground">{status?.connectorStatus}</span></div>
          </dl>
          {status?.locality === "not_local" && (
            <p className="text-amber-600 dark:text-amber-400">
              The connector appears to run on a different host; public routes would target the wrong machine.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {status?.status === "reconnect_required" && status.reconnectReason && (
            <p className="text-xs text-amber-600 dark:text-amber-400">Reconnect required: {status.reconnectReason}</p>
          )}
          {template && (
            <div className="text-xs">
              <a className="inline-flex items-center gap-1 text-primary hover:underline" href={template.url} target="_blank" rel="noreferrer">
                Create a Cloudflare API token <ExternalLink className="h-3 w-3" />
              </a>
              <p className="mt-0.5 text-[11px] text-muted-foreground">Grant: {template.requiredPermissions.join(" · ")}</p>
            </div>
          )}
          <div className="flex gap-2">
            <Input
              type="password"
              autoComplete="off"
              placeholder="Paste Cloudflare API token"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              className="h-8 text-xs"
            />
            <Button type="button" size="sm" disabled={busy || !token.trim()} onClick={() => void connect()}>
              {busy && <LoaderCircle className="mr-1 h-4 w-4 animate-spin" />}
              Connect
            </Button>
          </div>
        </div>
      )}

      {error && <InlineError message={error} />}
    </div>
  );
}
