"use client";
import { useEffect, useState } from "react";
import { AuthNotice, AuthNoticeButton } from "./auth-notice";
import { APP_SESSION_ENDED, APP_ACTIVITY_RENEWED, appActivityNeedsRenewal, configureAppActivity, updateAppActivity, renewAppActivity, cancelActivityRenewal } from "./browser-auth";
import { resolveLaunchMode, detectLaunchMode, normalizeLaunchMode, LAUNCH_MODE_ATTRIBUTE, LAUNCH_MODE_PARAM, LAUNCH_MODE_STORAGE_KEY } from "./index";
import { acceptAppAuthProtocol, refreshAppAuthProtocol } from "./browser-auth";
import type { AppAuthProtocol } from "./app-code";

/** Keep mounted beside app content so expiry never discards drafts or component state. */
export function AppActivityBridge({ openUrl, appCodePath, activeUntil, activityRequired = false, appAuthProtocol, probePath = "/api/auth/identity", native }: {
  openUrl: string; appCodePath: string; activeUntil?: string | null; activityRequired?: boolean;
  appAuthProtocol?: AppAuthProtocol | null; probePath?: string; native?: boolean;
}) {
  const [needed, setNeeded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const renew = () => {
    const operation = renewAppActivity();
    setPending(true); setError("");
    void operation.catch(e => { setNeeded(true); setError(String(e.message ?? e)); }).finally(() => setPending(false));
  };
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    const controller = new AbortController();
    const configure = (protocol: AppAuthProtocol | null) => {
      if (cancelled || !protocol || acceptAppAuthProtocol(new URL(openUrl).origin, protocol) !== protocol) return;
      let stored: string | null = null;
      try { stored = window.sessionStorage.getItem(LAUNCH_MODE_STORAGE_KEY); } catch { /* The applied document mode remains available. */ }
      const mode = normalizeLaunchMode(document.documentElement.getAttribute(LAUNCH_MODE_ATTRIBUTE)) ?? resolveLaunchMode({
        param: new URL(window.location.href).searchParams.get(LAUNCH_MODE_PARAM), stored, heuristic: detectLaunchMode(window),
      }).mode;
      cleanup = configureAppActivity({ openUrl, appAuthProtocol: protocol, probePath, native: native ?? mode === "native", activeUntil, activityRequired, exchangeCode: async proof => {
      const response = await fetch(appCodePath, { method: "POST", credentials: "same-origin", redirect: "error",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(proof) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "Could not renew app activity.");
      return body;
      } });
    };
    if (appAuthProtocol !== undefined && !(appAuthProtocol === 1 && acceptAppAuthProtocol(new URL(openUrl).origin, 1) === null))
      configure(appAuthProtocol);
    else void refreshAppAuthProtocol(openUrl, probePath, controller.signal).then(configure);
    // A stale protocol-1 prop cannot overwrite a protocol-2 minimum already verified
    // by this app. Unknown discovery leaves renewal disabled instead of downgrading.
    const expired = () => setNeeded(true);
    const renewed = () => { setNeeded(false); setError(""); };
    const click = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-hosty-activity-control]")) return;
      if (event.isTrusted && appActivityNeedsRenewal()) {
        void renewAppActivity().catch(e => { setNeeded(true); setError(String(e.message ?? e)); });
      }
    };
    window.addEventListener(APP_SESSION_ENDED, expired);
    window.addEventListener(APP_ACTIVITY_RENEWED, renewed);
    document.addEventListener("click", click, true);
    return () => { cancelled = true; controller.abort(); cleanup?.(); window.removeEventListener(APP_SESSION_ENDED, expired); window.removeEventListener(APP_ACTIVITY_RENEWED, renewed); document.removeEventListener("click", click, true); };
  }, [openUrl, appCodePath, appAuthProtocol, probePath, native]);
  useEffect(() => { updateAppActivity(activeUntil, activityRequired); }, [activeUntil, activityRequired, openUrl, appCodePath]);
  if (!needed) return null;
  return <AuthNotice>
    <span>{error || "Renew access through Core to continue. Your work stays on this page."}</span>
    <AuthNoticeButton disabled={pending} onClick={renew}>{pending ? "Waiting for Core…" : "Renew access"}</AuthNoticeButton>
    <AuthNoticeButton secondary onClick={() => { cancelActivityRenewal(); setNeeded(false); }}>Later</AuthNoticeButton>
  </AuthNotice>;
}
