"use client";
import { useEffect, useState } from "react";
import { AuthNotice, AuthNoticeButton } from "./auth-notice";
import { APP_SESSION_ENDED, APP_ACTIVITY_RENEWED, appActivityNeedsRenewal, configureAppActivity, updateAppActivity, renewAppActivity, cancelActivityRenewal } from "./browser-auth";

/** Keep mounted beside app content so expiry never discards drafts or component state. */
export function AppActivityBridge({ openUrl, appCodePath, activeUntil, activityRequired = false }: {
  openUrl: string; appCodePath: string; activeUntil?: string | null; activityRequired?: boolean;
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
    const cleanup = configureAppActivity({ openUrl, exchangeCode: async code => {
      const response = await fetch(appCodePath, { method: "POST", credentials: "same-origin", redirect: "error",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "Could not renew app activity.");
      return body;
    } });
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
    return () => { cleanup(); window.removeEventListener(APP_SESSION_ENDED, expired); window.removeEventListener(APP_ACTIVITY_RENEWED, renewed); document.removeEventListener("click", click, true); };
  }, [openUrl, appCodePath]);
  useEffect(() => { updateAppActivity(activeUntil, activityRequired); }, [activeUntil, activityRequired, openUrl, appCodePath]);
  if (!needed) return null;
  return <AuthNotice>
    <span>{error || "Renew access through Core to continue. Your work stays on this page."}</span>
    <AuthNoticeButton disabled={pending} onClick={renew}>{pending ? "Waiting for Core…" : "Renew access"}</AuthNoticeButton>
    <AuthNoticeButton secondary onClick={() => { cancelActivityRenewal(); setNeeded(false); }}>Later</AuthNoticeButton>
  </AuthNotice>;
}
