"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { coreErrorBody, isAuthRequiredRedirectError } from "../core-api";
import { useShellActions } from "../shell-context";
import type {
  CloudflareConnectionStatus,
  CloudflareSelectionError,
  CloudflareSelectionRequired,
  CloudflareTokenTemplate,
} from "../types";
import { BusyButton, InlineError } from "../ui";

// Which connect-request field carries each kind of answer.
const SELECTION_FIELDS: Record<CloudflareSelectionRequired["kind"], string> = {
  account: "accountId",
  zone: "zoneId",
  tunnel: "tunnelId",
};

const SELECTION_PROMPTS: Record<CloudflareSelectionRequired["kind"], string> = {
  account: "This token can reach more than one account. Which one should Hosty use?",
  zone: "This token can reach more than one zone. Which domain should apps be published under?",
  tunnel: "More than one healthy tunnel is available. Which one should Hosty add routes to?",
};

// The Cloudflare connection, on the Ingress tab under the provider that uses it: paste a scoped token to
// connect, answer any account/zone/tunnel ambiguity, see the discovered selection plus connector health,
// and disconnect. Self-contained — it reads sendCsrfJson/coreOrigin from context and fetches its own
// status. The raw token is only ever sent to Core (masked in the status), never shown back.
export function CloudflareConnectionCard() {
  const { coreOrigin, sendCsrfJson } = useShellActions();
  const [status, setStatus] = useState<CloudflareConnectionStatus | null>(null);
  const [template, setTemplate] = useState<CloudflareTokenTemplate | null>(null);
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<CloudflareSelectionRequired | null>(null);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
    }
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
      if (!silent) {
        setLoading(false);
      }
    }
  }, [coreOrigin, sendCsrfJson]);

  useEffect(() => {
    void load();
  }, [load]);

  // The operator's answers to ambiguities so far. An account with two zones is ordinary, so connect can
  // ask more than once — each answer is kept and sent with the next attempt.
  const connect = async (answers: Record<string, string> = selected) => {
    if (!token.trim()) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await sendCsrfJson(`${coreOrigin}/api/core/cloudflare/connect`, { token: token.trim(), ...answers });
      setToken("");
      setSelection(null);
      setSelected({});
      await load(true);
      toast.success("Cloudflare connected");
    } catch (connectError) {
      if (isAuthRequiredRedirectError(connectError)) {
        return;
      }

      const required = coreErrorBody<CloudflareSelectionError>(connectError)?.selection ?? null;
      setSelection(required);
      setError(connectError instanceof Error ? connectError.message : "Connecting to Cloudflare failed.");
    } finally {
      setBusy(false);
    }
  };

  const answer = (kind: CloudflareSelectionRequired["kind"], id: string) => {
    const next = { ...selected, [SELECTION_FIELDS[kind]]: id };
    setSelected(next);
    void connect(next);
  };

  // Keep leaves every published route and DNS record exactly as it is; Remove deletes what Hosty
  // published first, and Core keeps the connection if any of that fails — the token is the only way to
  // finish the job.
  const disconnect = async (removePublished: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await sendCsrfJson(`${coreOrigin}/api/core/cloudflare/disconnect`, { removePublished });
      setConfirmingDisconnect(false);
      await load(true);
      toast.success(removePublished ? "Cloudflare disconnected and published addresses removed" : "Cloudflare disconnected", {
        description: removePublished ? undefined : "Published addresses were left in place.",
      });
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
        <h3 className="text-sm font-medium">Cloudflare connection</h3>
        <p className="text-xs text-muted-foreground">
          A scoped API token lets Hosty add routes to your tunnel and create one DNS record per published
          hostname. Hosty never creates the tunnel and never runs the connector.
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
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setConfirmingDisconnect(true)}>
              Disconnect
            </Button>
          </div>
          {confirmingDisconnect && (
            <div className="space-y-1.5 rounded-md border p-2">
              <p>
                Hosty cannot revoke this token — delete it in the Cloudflare dashboard afterwards. What should happen
                to the addresses Hosty published?
              </p>
              <div className="flex flex-wrap gap-2">
                <BusyButton type="button" size="sm" variant="outline" busy={busy} onClick={() => void disconnect(false)}>
                  Keep them
                </BusyButton>
                <BusyButton type="button" size="sm" variant="destructive" busy={busy} onClick={() => void disconnect(true)}>
                  Remove them
                </BusyButton>
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmingDisconnect(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {/* A definition list needs dt/dd pairs; the div-per-line shape it had was invalid markup that
              read as one undifferentiated run of text to a screen reader. */}
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-muted-foreground sm:grid-cols-[auto_1fr_auto_1fr] sm:gap-x-4">
            <dt>Account:</dt>
            <dd className="text-foreground">{status?.accountName}</dd>
            <dt>Domain:</dt>
            <dd className="text-foreground">{status?.baseDomain}</dd>
            <dt>Tunnel:</dt>
            <dd className="text-foreground">{status?.tunnelName}</dd>
            <dt>Connector:</dt>
            <dd className="text-foreground">{status?.connectorStatus}</dd>
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
              <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
                {template.requiredPermissions.map((permission) => (
                  <li key={permission}>{permission}</li>
                ))}
              </ul>
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
            <BusyButton type="button" size="sm" busy={busy} disabled={!token.trim()} onClick={() => void connect()}>
              Connect
            </BusyButton>
          </div>
          {selection && (
            <div className="space-y-1.5 rounded-md border p-3 text-xs">
              <p className="font-medium">{SELECTION_PROMPTS[selection.kind]}</p>
              <div className="flex flex-col gap-1">
                {selection.options.map((option) => (
                  <Button
                    key={option.id}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="justify-start"
                    disabled={busy}
                    onClick={() => answer(selection.kind, option.id)}
                  >
                    <span className="truncate">{option.name}</span>
                    {option.detail && <span className="ml-2 text-muted-foreground">{option.detail}</span>}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {error && <InlineError message={error} />}
    </div>
  );
}
