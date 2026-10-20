"use client";

import { useEffect, useState } from "react";
import type { CoreEnvironmentSavedConsent } from "@hosty-sdk/app/sandbox/server";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { fetchCore } from "../core-transport.js";
import { readCoreError } from "../core-api";
import type { CoreApp } from "../types";

export function SandboxLaunchPermissions({ coreOrigin, apps, sendCsrfJson }: {
  coreOrigin: string; apps: CoreApp[]; sendCsrfJson: (url: string, body: unknown) => Promise<Response>;
}) {
  const [grants, setGrants] = useState<CoreEnvironmentSavedConsent[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetchCore(`${coreOrigin}/api/core-environments`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(await readCoreError(response));
        const result = await response.json() as { consents?: CoreEnvironmentSavedConsent[] };
        if (!controller.signal.aborted) { setGrants(result.consents ?? []); setError(""); }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load sandbox launch permissions.");
      }
    }
    void load();
    return () => controller.abort();
  }, [coreOrigin, refresh]);
  if (!grants.length && !error) return null;
  return <section aria-labelledby="sandbox-launch-permissions" className="flex flex-col gap-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="sandbox-launch-permissions" className="text-lg font-medium">Sandbox launch permissions</h2>
        <p className="text-sm text-muted-foreground">Revoking permission blocks delegated launches and access. Existing sandboxes keep running until stopped or deleted.</p>
      </div>
      <Button variant="outline" onClick={() => setRefresh(value => value + 1)} disabled={busy !== null}>Refresh permissions</Button>
    </div>
    {error && <Alert variant="destructive"><AlertTitle>Sandbox permission request failed</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
    <ul className="divide-y">{grants.map(grant => <li key={grant.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div className="flex min-w-0 flex-col gap-1 text-sm">
        <span className="font-medium">{grant.label || apps.find(app => app.id === grant.appId)?.displayName || grant.appId}</span>
        <span className="text-muted-foreground">{grant.mode} · {grant.state}</span>
        <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Launch target</summary><p className="mt-1 break-all">{grant.target}</p></details>
      </div>
      <Button variant="outline" disabled={busy !== null} onClick={async () => {
        setBusy(grant.id); setError("");
        try {
          await sendCsrfJson(`${coreOrigin}/api/core-environments/consents/${encodeURIComponent(grant.id)}/revoke`, {});
          setRefresh(value => value + 1);
        } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not revoke launch permission."); }
        finally { setBusy(null); }
      }}>{busy === grant.id ? "Revoking…" : "Revoke permission"}</Button>
    </li>)}</ul>
  </section>;
}
