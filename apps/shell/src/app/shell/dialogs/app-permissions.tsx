"use client";

import { useEffect, useMemo, useState } from "react";
import { createInstallationClient, openInstallationConfirmation, showInstallationConfirmation } from "@hosty-sdk/app/install";
import { Button } from "@/components/ui/button";
import { useShellActions } from "../shell-context";
import type { CoreApp } from "../types";

export function AppPermissions({ app }: { app: CoreApp }) {
  const { coreOrigin, sendCsrfJson, refresh } = useShellActions();
  const client = useMemo(() => createInstallationClient({ baseUrl: `${coreOrigin}/api/installations`, request: sendCsrfJson }), [coreOrigin, sendCsrfJson]);
  const [pending, setPending] = useState<{ id: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!pending) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await client.status(pending!.id);
        if (disposed) return;
        if (["succeeded", "denied", "failed"].includes(result.status)) {
          setPending(null); setBusy(false);
          setMessage(result.status === "succeeded" ? "Permissions updated." : result.error ?? "Permission review cancelled.");
          if (result.status === "succeeded") void refresh();
        } else timer = setTimeout(() => void poll(), 1500);
      } catch (error) { if (!disposed) { setMessage(String(error)); setPending(null); setBusy(false); } }
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [client, pending, refresh]);
  if (!app.optionalCorePermissions?.length && !app.requiredCorePermissions?.length) return null;
  async function review() {
    const popup = openInstallationConfirmation();
    setBusy(true); setMessage("");
    try {
      const draft = await client.prepare({ permissionsAppId: app.id });
      const result = await client.submit(draft.id, {}, true);
      showInstallationConfirmation(popup, result);
      setPending({ id: result.id, url: result.approvalUrl });
    } catch (error) { popup?.close(); setBusy(false); setMessage(String(error)); }
  }
  return <section className="space-y-2 rounded-md border p-3 text-sm" aria-label="App permissions">
    <h3 className="font-medium">Permissions</h3>
    {[...(app.requiredCorePermissions ?? []), ...(app.optionalCorePermissions ?? [])].map(permission => <p key={permission}>
      <code>{permission}</code> · {app.requiredCorePermissions?.includes(permission) ? "Required" : app.grantedCorePermissions?.includes(permission) ? "Allowed" : "Not allowed"}
    </p>)}
    {!!app.optionalCorePermissions?.length && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void review()}>Review optional permissions</Button>}
    {pending && <p><a href={pending.url} target="_blank" rel="noopener noreferrer" className="underline">Confirm permissions in Core</a></p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
