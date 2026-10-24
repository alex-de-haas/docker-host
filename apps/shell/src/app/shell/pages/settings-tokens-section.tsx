"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { HostyLoader } from "../../../../../../shared/web/hosty-states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { fetchCore } from "../core-transport.js";
import { CredentialGrid, type Credential } from "./settings-credential-grid";

type Props = { coreOrigin: string; userId?: string; actorId?: string | null; canRevokeAll?: boolean;
  sendCsrfJson: (url: string, body: unknown, method?: string, signal?: AbortSignal) => Promise<Response> };

export function SettingsTokensSection(props: Props) {
  // A different authority gets fresh rows, selection and drafts before its first request resolves.
  return <CredentialSection key={JSON.stringify([props.coreOrigin, props.actorId ?? null, props.userId ?? null, props.canRevokeAll ?? false])} {...props} />;
}

function CredentialSection({ coreOrigin, sendCsrfJson, userId, canRevokeAll = false }: Props) {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState(""), [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false), [progress, setProgress] = useState("");
  const lifetime = useRef<AbortController | null>(null), read = useRef<AbortController | null>(null);
  const mutation = useRef(false);
  const reload = useCallback(async () => {
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    try {
      const response = await fetchCore(`${coreOrigin}/api/auth/credentials${userId ? `?userId=${encodeURIComponent(userId)}` : ""}`, { signal: controller.signal });
      const result = await response.json() as { credentials?: Credential[]; message?: string };
      controller.signal.throwIfAborted();
      if (!response.ok) throw new Error(result.message ?? "Could not load tokens and devices.");
      setCredentials(result.credentials ?? []);
      setLoadError("");
    } catch (cause) {
      if (!controller.signal.aborted) setLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [coreOrigin, userId]);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    // Remote metadata settles asynchronously; the entry load does not overwrite local drafts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
    return () => { controller.abort(); read.current?.abort(); };
  }, [reload]);

  const revoke = async (ids: string[]) => {
    if (mutation.current || !ids.length) return;
    mutation.current = true; setPending(true); setActionError(""); setNotice("");
    const signal = lifetime.current!.signal;
    let completed = 0;
    try {
      // Each selected fingerprint keeps Core's existing confirmation and authority checks.
      // Never dispatch the next credential after cancellation, an unknown result or scope change.
      for (const id of ids) {
        signal.throwIfAborted();
        setProgress(`Reviewing revocation ${completed + 1} of ${ids.length} in Core…`);
        const response = await sendCsrfJson(`${coreOrigin}/api/auth/credentials/${encodeURIComponent(id)}`, undefined, "DELETE", signal);
        signal.throwIfAborted();
        if (!response.ok) throw new Error("Core did not confirm this revocation.");
        completed++;
        setCredentials(current => current.filter(credential => credential.id !== id));
      }
    } catch (cause) {
      if (!signal.aborted) setActionError(`${completed} of ${ids.length} revoked. ${cause instanceof Error ? cause.message : String(cause)} Further revocations stopped. Refresh the list to check remaining access.`);
    } finally {
      if (!signal.aborted) {
        setNotice(`${completed} of ${ids.length} revocations confirmed.`);
        setProgress("Refreshing credentials…");
        await reload();
        if (!signal.aborted) { setProgress(""); setPending(false); }
      }
      mutation.current = false;
    }
  };
  const rename = async (id: string, label: string) => {
    if (mutation.current) return false;
    mutation.current = true; setPending(true); setActionError(""); setNotice(""); setProgress("Saving credential name…");
    const signal = lifetime.current!.signal;
    try {
      const response = await sendCsrfJson(`${coreOrigin}/api/auth/credentials/${encodeURIComponent(id)}/label`, { label: label.trim() }, "PATCH", signal);
      signal.throwIfAborted();
      if (!response.ok) throw new Error("Core did not save the credential name.");
      setCredentials(current => current.map(credential => credential.id === id ? { ...credential, label: label.trim() } : credential));
      setNotice("Credential name saved.");
      await reload();
      return true;
    } catch (cause) {
      if (!signal.aborted) setActionError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      mutation.current = false;
      if (!signal.aborted) { setPending(false); setProgress(""); }
    }
  };
  const revokeAll = async () => {
    if (mutation.current || userId || !canRevokeAll) return;
    mutation.current = true; setPending(true); setActionError(""); setNotice(""); setProgress("Reviewing revocation of all your access in Core…");
    const signal = lifetime.current!.signal;
    try {
      const response = await sendCsrfJson(`${coreOrigin}/api/auth/background-grants/revoke-all-authorizations`, {}, "POST", signal);
      signal.throwIfAborted();
      if (!response.ok) throw new Error("Core did not confirm revocation of all your access.");
      window.location.assign(`${coreOrigin}/login`);
    } catch (cause) {
      if (!signal.aborted) setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally { mutation.current = false; if (!signal.aborted) { setPending(false); setProgress(""); } }
  };
  const busy = loading || pending;
  return <section className="flex min-w-0 flex-col gap-4" aria-label="Tokens and devices">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex flex-col gap-1"><h2 className="text-lg font-medium">Tokens & devices</h2><p className="text-sm text-muted-foreground">Active access to this host. Token values are never displayed here.</p></div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={() => { setLoading(true); void reload(); }}><RefreshCw data-icon="inline-start" />Refresh</Button>
        {!userId && <><Button variant="outline" asChild><a href={`${coreOrigin}/account/device`} target="_blank" rel="noopener noreferrer">Connect device</a></Button><Button asChild><a href={`${coreOrigin}/account/tokens`} target="_blank" rel="noopener noreferrer">Create token</a></Button></>}
      </div>
    </header>
    {!userId && canRevokeAll && <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="min-w-0 flex-1 basis-64 text-xs text-muted-foreground">Revoke all ends your browser sessions, tokens, OAuth authorizations and background app access. Core asks you to confirm.</p>
      <Button variant="destructive" disabled={busy} onClick={() => void revokeAll()}>Revoke all my authorizations</Button>
    </div>}
    {loadError && <Alert variant="destructive"><AlertDescription>{loadError}{credentials.length > 0 && " Previously loaded credentials are shown."}</AlertDescription></Alert>}
    {actionError && <Alert variant="destructive"><AlertDescription>{actionError}</AlertDescription></Alert>}
    {(loading || pending) && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><HostyLoader className="size-5" label={null} />{pending ? progress : "Loading tokens and devices…"}</p>}
    {!pending && notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    <CredentialGrid credentials={credentials} busy={busy} loading={loading} failed={Boolean(loadError)} onRename={rename} onRevoke={revoke} />
  </section>;
}
