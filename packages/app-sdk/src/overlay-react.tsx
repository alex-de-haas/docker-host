"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAppIdentity } from "./react";
import { useAppActivity } from "./activity-react";
import { APP_SESSION_ENDED, APP_SESSION_RESTORED, APP_ACTIVITY_RENEWED } from "./browser-auth";
import { permissionReviewUrl, requestPermissionReview, type PermissionNoticeState } from "./permissions";

type Setup = "ready" | "missing" | "unsupported" | "unavailable" | "incompatible";
type Snapshot = { userId: string; setup: Setup; notice?: PermissionNoticeState };
function snapshot(body: unknown): Snapshot | null {
  const value = body as { status?: unknown; userId?: unknown; hosty?: { version?: unknown; setup?: unknown; notice?: PermissionNoticeState } } | null;
  if (value?.status !== "active" || typeof value.userId !== "string" || !value.userId) return null;
  const setup = value.hosty?.version === 1 && ["ready", "missing", "unsupported", "unavailable", "incompatible"].includes(String(value.hosty.setup))
    ? value.hosty.setup as Setup : "incompatible";
  return { userId: value.userId, setup, notice: value.hosty?.notice };
}

/** Mount once around protected content. Presentation and recovery belong to Hosty. */
export function HostyOverlay({ children, probePath = "/api/hosty/session", appCodePath = "/api/auth/app-code" }: {
  children: ReactNode; probePath?: string; appCodePath?: string;
}) {
  const actor = useRef<string | null>(null);
  const changingActor = useRef(false);
  const [session, setSession] = useState<Snapshot | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const renewedAwaitingSetup = useRef(false);
  const accept = (body: unknown) => {
    const next = snapshot(body);
    if (next && actor.current && actor.current !== next.userId) {
      changingActor.current = true;
      window.location.reload();
    }
    if (next && !actor.current) actor.current = next.userId;
    setSession(next);
  };
  const identity = useAppIdentity({ probePath, appCodePath, onSession: accept });
  const refreshRef = useRef(identity.refresh);
  refreshRef.current = async () => {
    const body = await identity.refresh();
    const next = snapshot(body);
    if (renewedAwaitingSetup.current && next?.setup === "ready" && next.userId === actor.current && !changingActor.current) {
      renewedAwaitingSetup.current = false;
      window.dispatchEvent(new CustomEvent(APP_SESSION_RESTORED, { detail: { userId: next.userId } }));
      window.dispatchEvent(new Event(APP_ACTIVITY_RENEWED));
    }
    return body;
  };
  const validate = useRef(async () => {
    const next = snapshot(await refreshRef.current());
    if (!next || changingActor.current || next.userId !== actor.current) return false;
    renewedAwaitingSetup.current = next.setup !== "ready";
    if (renewedAwaitingSetup.current) return false;
    window.dispatchEvent(new CustomEvent(APP_SESSION_RESTORED, { detail: { userId: next.userId } }));
    return true;
  }).current;
  const activity = useAppActivity(identity.activity ? { ...identity.activity, probePath, appCodePath, validateSession: validate } : null);
  const deadline = Date.parse(identity.activity?.activeUntil ?? "");
  const expired = identity.activity?.activityRequired && (!Number.isFinite(deadline) || deadline <= Date.now());
  const ready = identity.ui.kind === "active" && session?.setup === "ready" && !expired && !activity.needed && !activity.pending && !changingActor.current;
  const mounted = useRef(false);
  if (ready) mounted.current = true;

  useEffect(() => {
    if (session?.setup === "ready") setReviewing(false);
  }, [session?.setup]);
  useEffect(() => {
    // No keepalive polling. Focus and a pending Core review are the only readiness refreshes.
    let loading = false;
    const refresh = () => {
      if (loading || !actor.current || activity.pending || (activity.needed && !renewedAwaitingSetup.current)) return;
      loading = true;
      void refreshRef.current().finally(() => { loading = false; });
    };
    window.addEventListener("focus", refresh);
    const timer = reviewing ? window.setInterval(refresh, 2000) : undefined;
    return () => { window.removeEventListener("focus", refresh); window.clearInterval(timer); };
  }, [reviewing, activity.pending, activity.needed]);
  useEffect(() => {
    const metadata = identity.activity;
    if (!metadata?.activityRequired || !metadata.activeUntil) return;
    const remaining = Date.parse(metadata.activeUntil) - Date.now();
    if (!Number.isFinite(remaining)) return;
    // Real activity windows are short. Do not expire a malformed far-future value early.
    if (remaining > 2147483647) return;
    const timer = window.setTimeout(() => window.dispatchEvent(new Event(APP_SESSION_ENDED)), Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [identity.activity?.activeUntil, identity.activity?.activityRequired]);

  let title = "Connecting to Hosty";
  let message = "Checking your access…";
  let action: (() => void) | undefined;
  let actionLabel = "Retry";
  let reviewUrl: string | undefined;
  const pending = identity.ui.kind === "recovering" || activity.pending || changingActor.current;
  if (identity.ui.kind === "signin") {
    title = "Sign in to continue"; message = identity.ui.error ?? "Use your Hosty account to open this app.";
    action = identity.hasBeenActive && identity.activity ? activity.renew : identity.ui.signIn; actionLabel = "Sign in via Hosty";
    if (!action) message = "Open this app from Hosty, or ask the administrator to check its public address.";
  } else if (identity.ui.kind === "denied") {
    title = "Access unavailable"; message = "Your account does not have access to this app.";
  } else if (identity.ui.kind === "misconfigured") {
    title = "App setup required"; message = "This app needs configuration. Contact your administrator.";
  } else if (identity.ui.kind === "unavailable") {
    title = "Cannot reach Hosty"; message = "Check the connection and try again."; action = () => { void refreshRef.current(); };
  } else if (identity.ui.kind === "active" && session?.setup !== "ready") {
    if (!session || session.setup === "incompatible" || session.setup === "unsupported") {
      title = "Hosty update required"; message = "This app and Core need compatible versions. Contact your administrator.";
    } else if (session.setup === "unavailable") {
      title = "Cannot check app setup"; message = "Hosty could not check required permissions. Try again."; action = () => { void refreshRef.current(); };
    } else {
      title = "App setup required";
      message = "This app needs configuration by an administrator.";
      const notice = session.notice;
      if (notice?.hostRole === "host.admin" && notice.corePublicOrigin && notice.permissions?.reviewAvailable !== false) {
        message = reviewing ? "Review the required permissions in Core, then return here." : "Review this app’s required permissions in Hosty Core.";
        actionLabel = "Review permissions";
        action = () => { requestPermissionReview(notice); setReviewing(true); };
        if (reviewing) reviewUrl = permissionReviewUrl(notice.corePublicOrigin, notice.appId);
      }
    }
  } else if (expired || activity.needed || activity.pending) {
    title = activity.pending ? "Connecting to Hosty" : "Renew access to continue";
    message = activity.error || (activity.pending ? "Complete the confirmation in Core." : "Confirm your access through Hosty Core.");
    action = activity.renew; actionLabel = "Renew access";
  }

  return <>
    <div data-hosty-content hidden={!ready} inert={!ready} style={ready ? { display: "contents" } : { display: "none" }}>
      {mounted.current ? children : null}
    </div>
    {!ready && <OverlaySurface pending={pending} title={title} message={message} action={action} actionLabel={actionLabel} reviewUrl={reviewUrl} />}
  </>;
}

function OverlaySurface({ pending, title, message, action, actionLabel, reviewUrl }: {
  pending: boolean; title: string; message: string; action?: () => void; actionLabel: string; reviewUrl?: string;
}) {
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  const [showProgress, setShowProgress] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!pending) { setShowProgress(false); return; }
    const timer = window.setTimeout(() => setShowProgress(true), 180);
    return () => window.clearTimeout(timer);
  }, [pending]);
  useLayoutEffect(() => {
    const container = document.createElement("div");
    container.dataset.hostyOverlayPortal = "";
    const previousFocus = document.activeElement;
    const original = new Map<HTMLElement, boolean>();
    document.body.append(container);
    document.documentElement.setAttribute("data-hosty-overlay-blocked", "");
    const block = () => {
      for (const element of Array.from(document.body.children)) {
        if (!(element instanceof HTMLElement) || element === container || original.has(element)) continue;
        original.set(element, element.inert); element.inert = true;
      }
    };
    block();
    const observer = new MutationObserver(block);
    observer.observe(document.body, { childList: true });
    setPortal(container);
    return () => {
      observer.disconnect();
      original.forEach((inert, element) => { element.inert = inert; });
      document.documentElement.removeAttribute("data-hosty-overlay-blocked");
      container.remove();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  useLayoutEffect(() => {
    const element = dialog.current;
    // Replayed effects can still reference the dialog in the removed portal until state catches up.
    if (!element?.isConnected) return;
    if (typeof element.showModal === "function") element.showModal(); else element.setAttribute("open", "");
    element.focus();
    return () => { if (element.open && typeof element.close === "function") element.close(); };
  }, [portal]);
  const content = <>
    <style>{styles}</style>
    <dialog ref={dialog} className="hosty-overlay-dialog" aria-label="Hosty access" tabIndex={-1}
      onCancel={event => event.preventDefault()} data-hosty-activity-control>
      <section className="hosty-overlay-card" aria-live="polite" aria-busy={pending}>
        {pending ? <div className="hosty-overlay-loading" role="status" aria-label={title}>
          {showProgress && <><span className="hosty-overlay-spinner" /><p>{message}</p></>}
        </div> : <>
          <span className="hosty-overlay-brand">
            <span className="hosty-overlay-brand-mark">
              <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false" fill="none"
                stroke="currentColor" strokeWidth={6} strokeLinecap="round" strokeLinejoin="round">
                <path d="M25 36 V64 M75 36 V64 M25 50 H39 M61 50 H75" />
                <rect x="17" y="17" width="16" height="16" rx="4.5" />
                <rect x="67" y="17" width="16" height="16" rx="4.5" />
                <rect x="17" y="67" width="16" height="16" rx="4.5" />
                <rect x="67" y="67" width="16" height="16" rx="4.5" />
                <rect x="42" y="42" width="16" height="16" rx="4.5" />
              </svg>
            </span>
            <span>Hosty</span>
          </span>
          <h1>{title}</h1><p>{message}</p>
          {action && <button type="button" onClick={action}>{actionLabel}</button>}
          {reviewUrl && <a href={reviewUrl} target="_blank" rel="noopener noreferrer">Open Core permissions</a>}
        </>}
      </section>
    </dialog>
  </>;
  return portal ? createPortal(content, portal) : <div className="hosty-overlay-boot" role="status" aria-label="Connecting to Hosty"><style>{styles}</style></div>;
}

const styles = `
.hosty-overlay-boot,.hosty-overlay-dialog{--hosty-bg:#f8f9fb;--hosty-fg:#20242c;--hosty-muted:#606875;--hosty-border:#e0e4eb;color-scheme:light}
html.dark .hosty-overlay-dialog,html[data-hosty-theme=dark] .hosty-overlay-dialog,html.dark .hosty-overlay-boot{--hosty-bg:#14171c;--hosty-fg:#f0f2f5;--hosty-muted:#a2aab7;--hosty-border:#323843;color-scheme:dark}
.hosty-overlay-boot{position:fixed;inset:0;background:var(--hosty-bg);z-index:2147483647}
html[data-hosty-overlay-blocked] body>:not([data-hosty-overlay-portal]){visibility:hidden!important}
html[data-hosty-overlay-blocked],html[data-hosty-overlay-blocked] body{background:#f8f9fb!important}
html.dark[data-hosty-overlay-blocked],html.dark[data-hosty-overlay-blocked] body{background:#14171c!important}
html[data-hosty-launch=embedded][data-hosty-overlay-blocked],html[data-hosty-launch=embedded][data-hosty-overlay-blocked] body{background:transparent!important}
.hosty-overlay-dialog{position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;box-sizing:border-box;margin:0;padding:24px;border:0;background:var(--hosty-bg);color:var(--hosty-fg);font:400 14px/1.55 system-ui,sans-serif;outline:0}
.hosty-overlay-dialog[open]{display:grid;place-items:center}
.hosty-overlay-dialog::backdrop{background:transparent}
html[data-hosty-launch=embedded] .hosty-overlay-dialog,html[data-hosty-launch=embedded] .hosty-overlay-boot{background:transparent}
.hosty-overlay-card{width:min(100%,360px);text-align:center;animation:hosty-overlay-enter 160ms ease-out}
.hosty-overlay-brand{display:flex;align-items:center;justify-content:center;gap:8px;color:var(--hosty-fg);font-size:14px;font-weight:600;text-transform:uppercase;margin-bottom:22px}
.hosty-overlay-brand-mark{display:flex;align-items:center;justify-content:center;width:20px;height:20px;flex-shrink:0}
.hosty-overlay-brand-mark svg{width:24px;height:24px;flex-shrink:0}
.hosty-overlay-card h1{font:600 22px/1.3 system-ui,sans-serif;letter-spacing:-.025em;margin:0 0 12px;color:var(--hosty-fg)}
.hosty-overlay-card p{margin:0 0 24px;color:var(--hosty-muted)}
.hosty-overlay-card button{appearance:none;border:1px solid var(--hosty-border);border-radius:9px;background:var(--hosty-fg);color:var(--hosty-bg);padding:10px 18px;font:600 14px/1.4 system-ui,sans-serif;cursor:pointer}
.hosty-overlay-card button:focus-visible,.hosty-overlay-card a:focus-visible{outline:2px solid var(--hosty-muted);outline-offset:4px}
.hosty-overlay-card a{display:block;color:var(--hosty-muted);font-size:13px;margin-top:18px;text-decoration:underline}
.hosty-overlay-loading{min-height:100px;color:var(--hosty-muted)}
.hosty-overlay-spinner{display:inline-block;width:20px;height:20px;margin:0 0 16px;border:2px solid var(--hosty-border);border-top-color:var(--hosty-muted);border-radius:50%;animation:hosty-overlay-spin .8s linear infinite}
@keyframes hosty-overlay-spin{to{transform:rotate(360deg)}}
@keyframes hosty-overlay-enter{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:translateY(0)}}
@media(prefers-reduced-motion:reduce){.hosty-overlay-card,.hosty-overlay-spinner{animation:none}}
`;
