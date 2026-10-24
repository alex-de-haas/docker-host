"use client";

import { useEffect, useState } from "react";
import { SdkBrand, SdkChromeStyles, SdkIcon, SdkSpinner } from "./sdk-chrome";
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
  return <section data-hosty-sdk data-hosty-activity-control role="alert" aria-label="Required permissions" className="hosty-permissions-notice">
    <SdkChromeStyles /><style>{styles}</style><header><SdkBrand /><SdkIcon name="warning" /><strong>Permissions needed</strong></header>
    {kind === "unsupported"
      ? <p>Core does not support required permissions: {state.permissions!.unsupportedRequired!.join(", ")}. Update the app or Core.</p>
      : <p>This app needs required permissions. Operations using them are unavailable until approval.</p>}
    {kind === "missing" && state.permissions?.reviewAvailable !== false && state.corePublicOrigin &&
      <button type="button" className="hosty-sdk-button" onClick={() => { requestPermissionReview(state); setPending(true); }}>Request permissions</button>}
    {pending && <p className="hosty-sdk-status"><SdkSpinner />Review permissions in Core, then return here. You can leave this app installed without approving.</p>}
    <button type="button" onClick={() => { setDismissed(true); setPending(false); }} className="hosty-sdk-button hosty-sdk-ghost">Dismiss</button>
  </section>;
}

const styles = `
.hosty-permissions-notice{margin:8px;padding:12px 16px;border:1px solid var(--hs-warning-border);border-radius:10px;background:var(--hs-warning-soft);color:var(--hs-fg)}
.hosty-permissions-notice header{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.hosty-permissions-notice header>.hosty-sdk-icon{color:var(--hs-warning)}
.hosty-permissions-notice p{margin:8px 0 12px;font-size:13px;line-height:20px}.hosty-permissions-notice>button{margin:0 8px 0 0}
`;
