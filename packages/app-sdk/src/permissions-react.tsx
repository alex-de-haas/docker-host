"use client";

import { useEffect, useState } from "react";
import { appFetch } from "./browser-auth";
import { permissionNotice, requestPermissionReview, type PermissionNoticeState } from "./permissions";

/** App-owned GET endpoint authenticates the viewer and calls readOwnPermissionNotice. */
export function MissingPermissionsNotice({ endpoint = "/api/hosty/permissions" }: { endpoint?: string }) {
  const [state, setState] = useState<PermissionNoticeState | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const response = await appFetch(endpoint, { cache: "no-store", signal: controller.signal });
        if (!response.ok) { setState(null); return; }
        const next = await response.json() as PermissionNoticeState;
        if (!controller.signal.aborted) {
          setState(next);
          if (!permissionNotice(next)) setPending(false);
        }
      } catch { /* A transient failure must not erase a known setup warning. */ }
      finally { loading = false; }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    const timer = pending ? window.setInterval(refresh, 2000) : undefined;
    return () => { controller.abort(); window.removeEventListener("focus", refresh); window.clearInterval(timer); };
  }, [endpoint, pending]);
  const kind = state && permissionNotice(state);
  if (dismissed || !kind || !state) return null;
  return <section data-hosty-activity-control role="alert" aria-label="Required permissions" style={{ border: "1px solid currentColor", padding: 12, margin: 8, borderRadius: 8, color: "#c2410c" }}>
    {kind === "unsupported"
      ? <p>Core does not support required permissions: {state.permissions!.unsupportedRequired!.join(", ")}. Update the app or Core.</p>
      : <p>This app needs required permissions. Operations using them are unavailable until approval.</p>}
    {kind === "missing" && state.permissions?.reviewAvailable !== false && state.corePublicOrigin &&
      <button type="button" onClick={() => { requestPermissionReview(state); setPending(true); }}>Request permissions</button>}
    {pending && <p>Review permissions in Core, then return here. You can leave this app installed without approving.</p>}
    <button type="button" onClick={() => { setDismissed(true); setPending(false); }} style={{ marginLeft: 12 }}>Dismiss</button>
  </section>;
}
