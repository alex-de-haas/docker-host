"use client";
import { useEffect, useState } from "react";
import { AppActivityBridge } from "@hosty-sdk/app/react";
import { APP_ACTIVITY_RENEWED } from "@hosty-sdk/app/browser-auth";
export function ShellActivityBridge({ coreOrigin, appId }: { coreOrigin: string; appId: string }) {
  const [state, setState] = useState<{ activeUntil?: string | null; activityRequired?: boolean }>({});
  useEffect(() => {
    const abort = new AbortController();
    const refresh = () => { void fetch("/api/hosty/permissions", { cache: "no-store", signal: abort.signal })
      .then(async response => { if (response.ok && !abort.signal.aborted) setState(await response.json()); }).catch(() => {}); };
    refresh(); window.addEventListener(APP_ACTIVITY_RENEWED, refresh);
    return () => { abort.abort(); window.removeEventListener(APP_ACTIVITY_RENEWED, refresh); };
  }, []);
  return <AppActivityBridge openUrl={`${coreOrigin}/api/apps/${encodeURIComponent(appId)}/open?redirectUri=${encodeURIComponent(typeof window === "undefined" ? "" : window.location.origin + "/auth/callback")}`} appCodePath="/api/auth/renew" {...state} />;
}
