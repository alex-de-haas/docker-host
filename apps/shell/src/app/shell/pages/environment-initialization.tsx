"use client";

import { useEffect, useState } from "react";
import type { CoreEnvironment } from "@hosty-sdk/app/sandbox/server";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { fetchCore } from "../core-transport.js";
import { readCoreErrorDetail } from "../core-api";

type Status = { phase: string; hasAdministrator: boolean; recoveryRequired: boolean; shellUrl?: string; error?: string;
  apps: { id: string; title: string; state: string; error?: string }[] };
type SetupLink = { token: string; setupUrl: string; expiresAt: string };
type Request = <T>(path: string, body: unknown) => Promise<T>;
function safeUrl(value?: string) {
  try { const url = new URL(value ?? ""); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}
export function EnvironmentInitialization({ item, origin, pollVersion, request }: {
  item: CoreEnvironment; origin: string; pollVersion: number; request: Request;
}) {
  const [checkedAt, setCheckedAt] = useState(() => Date.now());
  const [status, setStatus] = useState<Status | null>(null), [error, setError] = useState("");
  const [link, setLink] = useState<SetupLink | null>(null), [busy, setBusy] = useState(false), [copied, setCopied] = useState<"link" | "token" | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const response = await fetchCore(`${origin}/api/core-environments/${item.id}/initialization`, { signal: abort.signal, cache: "no-store" });
        if (!response.ok) throw new Error((await readCoreErrorDetail(response)).message);
        const value = await response.json() as Status;
        if (!abort.signal.aborted) { setStatus(value); setCheckedAt(Date.now()); setError(""); if (value.hasAdministrator) setLink(null); }
      } catch (cause) { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "Initialization status is unavailable."); }
    })();
    return () => abort.abort();
  }, [item.id, origin, pollVersion]);
  const perform = async (resume: boolean) => {
    setBusy(true); setError("");
    try {
      if (resume) setStatus(await request<Status>(`/${item.id}/initialization/resume`, {}));
      else {
        const next = await request<SetupLink>(`/${item.id}/setup-link`, {});
        setLink(next); setCheckedAt(Date.now()); setCopied(null);
        const url = safeUrl(next.setupUrl);
        if (url) window.open(url, "_blank", "noopener,noreferrer");
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The request failed."); }
    finally { setBusy(false); }
  };
  const copy = async (value: string, kind: "link" | "token") => {
    try { await navigator.clipboard.writeText(value); setCopied(kind); setError(""); }
    catch { setError(kind === "link" ? "Clipboard unavailable. Copy the registration link from its Open registration action." : "Clipboard unavailable. Select and copy the token below."); }
  };
  const setup = link && Date.parse(link.expiresAt) > checkedAt ? safeUrl(link.setupUrl) : undefined;
  const shell = status?.hasAdministrator ? safeUrl(status.shellUrl) : undefined;
  return <section aria-label="Environment initialization" className="flex flex-col gap-3">
    <p role="status" className="text-sm">{!status ? "Reading initialization progress…" : status.hasAdministrator ? "Administrator registered" : status.phase === "ready" ? "Apps are ready. Register the first administrator." : `Initialization: ${status.phase}`}</p>
    {!!status?.apps.length && <ul className="flex flex-col gap-1 text-sm">{status.apps.map(app => <li key={app.id}>{app.title}: {app.state}{app.error && ` — ${app.error}`}</li>)}</ul>}
    {status?.error && <Alert variant="destructive"><AlertDescription>{status.error}</AlertDescription></Alert>}
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    <div className="flex flex-wrap gap-2">
      {status && ["failed", "selection"].includes(status.phase) && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void perform(true)}>Resume initialization</Button>}
      {status?.phase === "ready" && !status.hasAdministrator && !status.recoveryRequired && <Button type="button" size="sm" disabled={busy} onClick={() => void perform(false)}>{link ? "New registration link" : "Set up administrator"}</Button>}
      {shell && <Button asChild size="sm" variant="outline"><a href={shell} target="_blank" rel="noreferrer">Open Shell</a></Button>}
      {setup && <>
        <Button asChild size="sm" variant="outline"><a href={setup} target="_blank" rel="noreferrer">Open registration</a></Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void copy(setup, "link")}>{copied === "link" ? "Link copied" : "Copy setup link"}</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void copy(link!.token, "token")}>{copied === "token" ? "Token copied" : "Copy setup token"}</Button>
      </>}
    </div>
    {setup && <p className="break-all text-sm text-muted-foreground">Setup token: <code>{link!.token}</code></p>}
    {link && !setup && !status?.hasAdministrator && <p className="text-sm">This link expired. Request a new registration link.</p>}
    {status?.recoveryRequired && <p className="text-sm">This environment already has accounts. Use its normal administrator recovery flow.</p>}
    {status?.hasAdministrator && !status.shellUrl && <p className="text-sm text-muted-foreground">Core is ready for CLI/API use. Install Shell later with hosty setup.</p>}
  </section>;
}
