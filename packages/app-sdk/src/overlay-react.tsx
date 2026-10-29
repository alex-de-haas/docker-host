"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAppIdentity } from "./react";
import { useAppActivity } from "./activity-react";
import { APP_SESSION_ENDED, APP_SESSION_RESTORED, APP_ACTIVITY_RENEWED, acceptAppAuthProtocol } from "./browser-auth";
import { buildCoreOpenUrl, readRecoveryParams } from "./index";
import { permissionReviewUrl, requestPermissionReview, type PermissionNoticeState } from "./permissions";
import type { UiChromeOverrides, UiRouterAdapter } from "./ui-types";
import { SdkBrand, SdkChromeStyles, SdkIcon, SdkLoader } from "./sdk-chrome";
import { HostyUiRoot } from "./ui-react";

type Setup = "ready" | "missing" | "unsupported" | "unavailable" | "incompatible";
type Snapshot = {
  userId: string; setup: Setup; notice?: PermissionNoticeState; permissionWarning: boolean;
  activityRequired: boolean; activeUntil: string | null; recoveryReady: boolean;
};
function snapshot(body: unknown): Snapshot | null {
  const value = body as { status?: unknown; userId?: unknown; activityRequired?: unknown; activeUntil?: unknown; hosty?: { version?: unknown; setup?: unknown; permissionWarning?: unknown; notice?: PermissionNoticeState } } | null;
  if (value?.status !== "active" || typeof value.userId !== "string" || !value.userId) return null;
  const setup = value.hosty?.version === 1 && ["ready", "missing", "unsupported", "unavailable", "incompatible"].includes(String(value.hosty.setup))
    ? value.hosty.setup as Setup : "incompatible";
  const recovery = readRecoveryParams(body);
  const openUrl = recovery.appId ? buildCoreOpenUrl(recovery.corePublicOrigin, recovery.appId, window.location) : null;
  // The activity policy remains authoritative even when renewal discovery fails.
  return { userId: value.userId, setup, notice: value.hosty?.notice,
    permissionWarning: value.hosty?.permissionWarning === "unsupported",
    activityRequired: value.activityRequired === true,
    activeUntil: typeof value.activeUntil === "string" ? value.activeUntil : null,
    recoveryReady: !!openUrl && !!acceptAppAuthProtocol(new URL(openUrl).origin, recovery.appAuthProtocol) };
}
function activityExpired(session: Snapshot | null): boolean {
  const deadline = Date.parse(session?.activeUntil ?? "");
  return !!session?.activityRequired && (!Number.isFinite(deadline) || deadline <= Date.now());
}
function sessionReady(session: Snapshot | null): boolean {
  return session?.setup === "ready" && (!session.activityRequired || session.recoveryReady) && !activityExpired(session);
}

/** Mount once around protected content. Presentation and recovery belong to Hosty. */
export function HostyOverlay({ children, probePath = "/api/hosty/session", appCodePath = "/api/auth/app-code", uiPath, panelLayout = "auto", localContent, chrome, navigation }: {
  /** Explicitly public/local content available during an outage; never put protected actor data here. */
  localContent?: ReactNode; chrome?: UiChromeOverrides; navigation?: { renderer: "standard" | "custom"; router?: UiRouterAdapter };
  children: ReactNode; probePath?: string; appCodePath?: string; uiPath?: string; panelLayout?: "auto" | "slot" | "none";
}) {
  const actor = useRef<string | null>(null);
  const changingActor = useRef(false);
  const restoration = useRef({ established: false, ready: false, announced: false });
  const announceRestoration = useRef(() => {
    const state = restoration.current;
    if (!state.established || state.ready || state.announced || changingActor.current) return;
    state.announced = true;
    window.dispatchEvent(new CustomEvent(APP_SESSION_RESTORED, { detail: { userId: actor.current } }));
  }).current;
  const [session, setSession] = useState<Snapshot | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const renewedAwaitingReadiness = useRef(false);
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
    if (renewedAwaitingReadiness.current && next && sessionReady(next) && next.userId === actor.current && !changingActor.current) {
      renewedAwaitingReadiness.current = false;
      announceRestoration();
      window.dispatchEvent(new Event(APP_ACTIVITY_RENEWED));
    }
    return body;
  };
  const validate = useRef(async () => {
    const next = snapshot(await refreshRef.current());
    if (!next || changingActor.current || next.userId !== actor.current) return false;
    renewedAwaitingReadiness.current = !sessionReady(next);
    if (renewedAwaitingReadiness.current) return false;
    announceRestoration();
    return true;
  }).current;
  const activity = useAppActivity(identity.activity ? { ...identity.activity, probePath, appCodePath, validateSession: validate } : null);
  const expired = activityExpired(session);
  const recoveryUnavailable = session?.activityRequired && !session.recoveryReady;
  const ready = identity.ui.kind === "active" && sessionReady(session) && !activity.needed && !activity.pending && !changingActor.current;
  const mounted = useRef(false);
  if (ready) mounted.current = true;
  useLayoutEffect(() => {
    const state = restoration.current;
    if (!ready) {
      if (state.ready) state.announced = false;
      state.ready = false;
      return;
    }
    announceRestoration();
    state.established = true; state.ready = true;
  }, [ready, announceRestoration]);

  useEffect(() => {
    if (session?.setup === "ready") setReviewing(false);
  }, [session?.setup]);
  useEffect(() => {
    // Continuous sessions own their maintenance; this also observes pending permission reviews.
    let loading = false;
    const refresh = () => {
      if (loading || !actor.current || activity.pending || (activity.needed && !renewedAwaitingReadiness.current)) return;
      loading = true;
      void refreshRef.current().finally(() => { loading = false; });
    };
    window.addEventListener("focus", refresh);
    const timer = reviewing ? window.setInterval(refresh, 2000) : undefined;
    return () => { window.removeEventListener("focus", refresh); window.clearInterval(timer); };
  }, [reviewing, activity.pending, activity.needed]);
  useEffect(() => {
    const metadata = session;
    if (!metadata?.activityRequired || !metadata.activeUntil) return;
    const remaining = Date.parse(metadata.activeUntil) - Date.now();
    if (!Number.isFinite(remaining)) return;
    // Real activity windows are short. Do not expire a malformed far-future value early.
    if (remaining > 2147483647) return;
    const timer = window.setTimeout(() => window.dispatchEvent(new Event(APP_SESSION_ENDED)), Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [session?.activeUntil, session?.activityRequired]);

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
  } else if (identity.ui.kind === "active" && recoveryUnavailable) {
    title = "Cannot verify access renewal";
    message = "Hosty could not verify how to renew this app’s access. Try again.";
    action = () => { void refreshRef.current(); };
  } else if (expired || activity.needed || activity.pending) {
    title = activity.pending ? "Connecting to Hosty" : "Renew access to continue";
    message = activity.error || (activity.pending ? "Complete the confirmation in Core." : "Confirm your access through Hosty Core.");
    action = activity.renew; actionLabel = "Renew access";
  }

  const localOffline = (identity.ui.kind === "unavailable" || (identity.ui.kind === "active" && session?.setup === "unavailable"))
    && localContent !== undefined;
  return <>
    {ready && session?.permissionWarning && <div data-hosty-sdk role="status" className="hosty-overlay-offline">
      <SdkChromeStyles /><style>{styles}</style><SdkIcon name="warning" /><span>This Core does not support some permissions requested by this app. Update the app or Core. These permissions are not granted; some app features may not work.{session.notice?.permissions?.unsupportedRequired?.length ? ` (${session.notice.permissions.unsupportedRequired.join(", ")})` : ""}</span>
    </div>}
    {localOffline && <div data-hosty-local-content><div data-hosty-sdk className="hosty-overlay-offline" role="status"><SdkChromeStyles /><style>{styles}</style><SdkBrand /><span>Hosty is unavailable. Local content remains available.</span><button type="button" className="hosty-sdk-button" onClick={() => { void refreshRef.current(); }}>Retry</button></div>{localContent}</div>}
    <div data-hosty-content hidden={!ready} inert={!ready} style={ready ? { display: "contents" } : { display: "none" }}>
      <HostyUiRoot chrome={chrome} navigation={navigation} uiPath={uiPath} panelLayout={panelLayout} active={ready}>{mounted.current ? children : null}</HostyUiRoot>
    </div>
    {!ready && !localOffline && <OverlaySurface pending={pending} title={title} message={message} action={action} actionLabel={actionLabel} reviewUrl={reviewUrl} />}
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
    <SdkChromeStyles /><style>{styles}</style>
    <dialog ref={dialog} data-hosty-sdk className="hosty-overlay-dialog" aria-label="Hosty access" tabIndex={-1}
      onCancel={event => event.preventDefault()} data-hosty-activity-control>
      <section className="hosty-overlay-card" aria-live="polite" aria-busy={pending}>
        {pending ? <div className="hosty-overlay-loading" role="status" aria-label={title}>
          {showProgress && <><SdkBrand /><SdkLoader /><h1>{title}</h1><p>{message}</p></>}
        </div> : <>
          <SdkBrand />
          <h1>{title}</h1><p>{message}</p>
          {action && <button type="button" className="hosty-sdk-button hosty-sdk-primary" onClick={action}>{actionLabel}</button>}
          {reviewUrl && <a className="hosty-overlay-review" href={reviewUrl} target="_blank" rel="noopener noreferrer">Open Core permissions</a>}
        </>}
      </section>
    </dialog>
  </>;
  return portal ? createPortal(content, portal) : <div data-hosty-sdk className="hosty-overlay-boot" role="status" aria-label="Connecting to Hosty"><SdkChromeStyles /><style>{styles}</style></div>;
}

const styles = `
.hosty-overlay-boot{position:fixed;inset:0;background:var(--hs-bg);z-index:2147483647}
html[data-hosty-overlay-blocked] body>:not([data-hosty-overlay-portal]){visibility:hidden!important}
html[data-hosty-overlay-blocked],html[data-hosty-overlay-blocked] body{background:#F6F8FB!important}
html.dark[data-hosty-overlay-blocked],html.dark[data-hosty-overlay-blocked] body,html[data-hosty-theme=dark][data-hosty-overlay-blocked],html[data-hosty-theme=dark][data-hosty-overlay-blocked] body{background:#0F1B2D!important}
html[data-hosty-launch=embedded][data-hosty-overlay-blocked],html[data-hosty-launch=embedded][data-hosty-overlay-blocked] body{background:transparent!important}
.hosty-overlay-dialog{position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;padding:24px;border:0;background:var(--hs-bg);outline:0}
.hosty-overlay-dialog[open]{display:grid;place-items:center}
.hosty-overlay-dialog::backdrop{background:transparent}
html[data-hosty-launch=embedded] .hosty-overlay-dialog,html[data-hosty-launch=embedded] .hosty-overlay-boot{background:transparent}
.hosty-overlay-card{box-sizing:border-box;width:min(100%,360px);padding:24px;border:1px solid var(--hs-border);border-radius:14px;background:var(--hs-card);box-shadow:0 14px 34px -8px #0F1B2D3D;text-align:left;overflow-wrap:anywhere;animation:hosty-overlay-enter 160ms ease-out}
.hosty-overlay-card .hosty-sdk-brand{margin-bottom:16px}
.hosty-overlay-card h1{font:600 20px/26px var(--hs-font);letter-spacing:-.02em;margin:0 0 10px;color:var(--hs-fg)}
.hosty-overlay-card p{font:400 14px/22px var(--hs-font);margin:0 0 20px;color:var(--hs-muted)}
.hosty-overlay-card .hosty-sdk-button{width:100%}
.hosty-overlay-review{display:inline-block;color:var(--hs-info);font-size:13px;margin-top:16px;text-decoration:underline;text-underline-offset:3px}
.hosty-overlay-loading{min-height:64px}.hosty-overlay-loading .hosty-sdk-loader{margin:0 0 16px}.hosty-overlay-loading p{margin-bottom:0}
.hosty-overlay-offline{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:8px;padding:12px 16px;border:1px solid var(--hs-border);border-radius:10px;background:var(--hs-card);box-shadow:0 4px 14px -4px #0F1B2D29}.hosty-overlay-offline>span:not(.hosty-sdk-brand){flex:1;min-width:180px}
@keyframes hosty-overlay-enter{from{opacity:0}to{opacity:1}}
@media(max-width:480px){.hosty-overlay-dialog{padding:16px}.hosty-overlay-card{padding:20px}.hosty-overlay-card h1{font-size:18px;line-height:24px}}
@media(prefers-reduced-motion:reduce){.hosty-overlay-card{animation:none}}
`;
