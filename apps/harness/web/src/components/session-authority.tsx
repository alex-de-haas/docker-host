"use client";
import { useEffect, useRef, useState } from "react";
import { appFetch, APP_ACTIVITY_RENEWED } from "@hosty-sdk/app/browser-auth";

type Authority = { active: boolean; activeUntil: string | null; reviewUrl: string; duration?: "hour" | "session" };
/** Core, not this component, decides and persists the session's authority. */
export function SessionAuthority({ sessionId }: { sessionId: string }) {
  const reviewedUntil = useRef<string | null>(null);
  const [state, setState] = useState<Authority | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const response = await appFetch(`/api/sessions/${encodeURIComponent(sessionId)}/authority`, {
          method: pending ? "POST" : "GET", signal: abort.signal, cache: "no-store",
          ...(pending ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {}),
        });
        const next = await response.json();
        if (!response.ok) throw new Error(next.message ?? "Session authority is unavailable.");
        if (!abort.signal.aborted) { setState(next); setError(""); if (pending && next.activeUntil !== reviewedUntil.current) setPending(false); }
      } catch (e) { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e)); }
      finally { loading = false; }
    };
    void refresh();
    window.addEventListener("focus", refresh); window.addEventListener(APP_ACTIVITY_RENEWED, refresh);
    const timer = window.setInterval(refresh, pending ? 2000 : 30_000);
    return () => { abort.abort(); clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener(APP_ACTIVITY_RENEWED, refresh); };
  }, [sessionId, pending]);
  const review = () => {
    if (!state) return;
    if (window.parent !== window) window.parent.postMessage({ type: "hosty:request-assistant-authority", sessionId }, "*");
    else window.open(state.reviewUrl, "_blank", "noopener,noreferrer");
    reviewedUntil.current = state.activeUntil;
    setPending(true);
  };
  return <aside data-hosty-activity-control role="status" className="mx-4 my-2 rounded border p-3 text-sm">
    {error || (state?.active ? state.duration === "session" ? "Tool access until your Core sign-in session ends or access is revoked." : `Tool access until ${new Date(state.activeUntil!).toLocaleTimeString()}.` : "This conversation needs your approval in Core to use Hosty tools. Messages and drafts stay available.")}{" "}
    {state && <button type="button" className="underline" onClick={review}>{state.active ? state.duration === "session" ? "Manage tool access in Core" : "Renew or revoke in Core" : "Allow tools in Core"}</button>}
    {pending && <p>Review in Core, then return here. <button type="button" className="underline" onClick={() => setPending(false)}>Done</button></p>}
  </aside>;
}
