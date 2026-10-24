"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { SdkBrand, SdkChromeStyles, SdkIcon, SdkProgress, SdkSpinner } from "./sdk-chrome";
import {
  InstallationFlow, openInstallationConfirmation, showInstallationConfirmation,
  type InstallationClient, type InstallationRequest, type InstallationSource,
} from "./install";

/** Custom dialogs can use this hook without adopting the default presentation. */
export function useInstallation(client: InstallationClient) {
  const flow = useMemo(() => new InstallationFlow(client), [client]);
  const state = useSyncExternalStore(flow.subscribe, flow.snapshot, flow.snapshot);
  useEffect(() => () => flow.cancelPending(), [flow]);
  useEffect(() => {
    if (!state.request || !["pending", "executing"].includes(state.request.status)) return;
    const timer = setInterval(() => void flow.refresh(), 1500);
    return () => clearInterval(timer);
  }, [flow, state.request?.id, state.request?.status]);
  return { ...state, flow };
}

const popupOwners = new WeakMap<Window, object>();

export interface InstallDialogProps {
  client: InstallationClient;
  /** Choose the source/channel before opening. Core freezes that selection during preparation. */
  source?: InstallationSource;
  /** Open synchronously in the Install click handler, before mounting or fetching a source. */
  confirmationWindow?: Window | null;
  onClose: () => void;
  /** Return to the caller's source/connection picker after a known pre-confirmation error. */
  onChooseSource?: () => void;
  onInstalled?: (request: InstallationRequest) => void;
}

/** One Core confirmation, with app-local preparation/progress only. No installation questionnaire. */
export function InstallDialog(props: InstallDialogProps) {
  // A changed source is a new review. Never apply an earlier channel's confirmation to it.
  return <InstallationSession key={JSON.stringify(props.source ?? null)} {...props} />;
}

function InstallationSession({ client, source, confirmationWindow, onClose, onChooseSource, onInstalled }: InstallDialogProps) {
  const { request, busy, error, uncertainSubmit, flow } = useInstallation(client);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [manifestPath, setManifestPath] = useState("");
  const [presentationError, setPresentationError] = useState<string | null>(null);
  const notified = useRef<string | null>(null);
  const [initialSource] = useState(source);
  const activePopup = useRef(confirmationWindow ?? null);
  const popupOwner = useRef({});
  const popupShown = useRef(false);
  const mountLease = useRef(0);
  const hasSource = Boolean(initialSource?.manifestPath || initialSource?.feedsUrl);
  const frozen = uncertainSubmit || (request !== null && request.status !== "draft");

  const claimPopup = (popup: Window | null) => {
    activePopup.current = popup;
    popupShown.current = false;
    if (popup) popupOwners.set(popup, popupOwner.current);
  };
  const closeUnusedPopup = (popup = activePopup.current) => {
    if (!popup || popupShown.current || popupOwners.get(popup) !== popupOwner.current) return;
    popupOwners.delete(popup);
    popup.close();
  };
  const showConfirmation = (popup: Window | null, submitted: InstallationRequest | null) => {
    // A newer source session may now own the caller's preopened window.
    if (popup && popupOwners.get(popup) !== popupOwner.current) return;
    if (!submitted || submitted.status !== "pending") { closeUnusedPopup(popup); return; }
    try {
      showInstallationConfirmation(popup, submitted);
      popupShown.current = Boolean(popup && !popup.closed);
    } catch (cause) {
      closeUnusedPopup(popup);
      setPresentationError(cause instanceof Error ? cause.message : "Core confirmation could not be opened.");
    }
  };

  useEffect(() => {
    const lease = ++mountLease.current;
    claimPopup(activePopup.current);
    return () => {
      // StrictMode immediately replays setup. Defer cleanup so that replay, or a new source
      // session adopting the same window, can retain the reservation.
      queueMicrotask(() => { if (mountLease.current === lease) closeUnusedPopup(); });
    };
  }, [flow]);
  useEffect(() => {
    if (!initialSource?.manifestPath && !initialSource?.feedsUrl) return;
    let cancelled = false;
    void (async () => {
      await flow.review(initialSource);
      if (cancelled) return;
      if (flow.snapshot().request?.status !== "draft") { closeUnusedPopup(); return; }
      const submitted = await flow.submit();
      if (!cancelled) showConfirmation(activePopup.current, submitted);
    })();
    return () => { cancelled = true; };
  }, [flow, initialSource]);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => {
    if (request?.status === "succeeded" && notified.current !== request.id) {
      notified.current = request.id;
      onInstalled?.(request);
    }
  }, [request, onInstalled]);

  const install = async () => {
    if (busy || frozen) return;
    // The browser gesture is still active here, before any async preparation.
    const popup = openInstallationConfirmation();
    claimPopup(popup);
    setPresentationError(null);
    await flow.review({ manifestPath: manifestPath.trim() });
    if (flow.snapshot().request?.status !== "draft") { closeUnusedPopup(popup); return; }
    showConfirmation(popup, await flow.submit());
  };
  const retry = async () => {
    setPresentationError(null);
    if (uncertainSubmit) { await flow.refresh(); return; }
    const popup = openInstallationConfirmation();
    claimPopup(popup);
    // A known draft submit failure retries its existing identity, without resolving the feed again.
    if (!request) await flow.review(initialSource ?? { manifestPath: manifestPath.trim() });
    if (flow.snapshot().request?.status !== "draft") { closeUnusedPopup(popup); return; }
    showConfirmation(popup, await flow.submit());
  };
  const close = () => {
    closeUnusedPopup();
    onClose();
  };
  const confirmationUrl = (() => {
    if (request?.status !== "pending") return null;
    try {
      const url = new URL(request.approvalUrl);
      return ["http:", "https:"].includes(url.protocol) ? url.href : null;
    } catch { return null; }
  })();

  const preparing = busy && (!request || request.status === "draft");
  return <dialog ref={dialog} data-hosty-sdk className="hosty-install" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); close(); }}>
    <SdkChromeStyles /><style>{styles}</style>
    <header><div><SdkBrand /><h2 id={titleId}>Install app</h2></div><button type="button" className="hosty-sdk-button hosty-sdk-ghost hosty-sdk-icon-button" onClick={close} aria-label="Close installation"><SdkIcon name="close" /></button></header>
    {!hasSource && !request && <form onSubmit={event => { event.preventDefault(); void install(); }}>
      <p className="hosty-install-description">Hosty reads the manifest and prepares a request. Review runtime, startup and permissions in Core.</p>
      <label>Manifest, app directory, or URL<input className="hosty-sdk-input" value={manifestPath} onChange={event => setManifestPath(event.target.value)} required disabled={busy} /></label>
      <button className="hosty-sdk-button hosty-sdk-primary" disabled={busy || !manifestPath.trim()}>Install</button>
    </form>}
    {preparing && <section className="hosty-install-state" role="status" aria-busy="true"><p className="hosty-sdk-status"><SdkSpinner />Preparing Core confirmation…</p><SdkProgress label="Preparing Core confirmation" /></section>}
    {(error || presentationError) && <div className="hosty-install-error" role="alert"><p><SdkIcon name="error" /><span>{error || presentationError}</span></p>
      <div className="hosty-install-actions">{(!frozen || uncertainSubmit) && <button type="button" className="hosty-sdk-button" disabled={busy} onClick={() => void retry()}>
        {uncertainSubmit ? "Check request status" : "Retry"}
      </button>}
      {!frozen && onChooseSource && <button type="button" className="hosty-sdk-button hosty-sdk-ghost" disabled={busy} onClick={() => { closeUnusedPopup(); onChooseSource(); }}>Change source</button>}</div>
    </div>}
    {uncertainSubmit && <p className="hosty-install-description" role="status">Core may have received this request. Check its status before continuing.</p>}
    {request && request.status !== "draft" && <section className="hosty-install-state" data-state={request.status} role="status" aria-busy={request.status === "executing"}>
      {request.status === "executing" ? <SdkSpinner /> : <span className="hosty-install-state-icon"><SdkIcon name={request.status === "pending" ? "external" : request.status === "succeeded" ? "check" : request.status === "denied" ? "close" : "error"} /></span>}
      <h3>{request.status === "pending" ? "Confirm in Hosty Core" : request.status === "executing" ? "Installing app" : request.status === "succeeded" ? "App installed" : request.status === "denied" ? "Installation cancelled" : "Installation failed"}</h3>
      <p>{request.status === "pending" ? "Confirm runtime, automatic startup and permissions in Hosty Core." : request.status === "executing" ? "Core is installing your app…" : request.status === "succeeded" ? "App installed." : request.status === "denied" ? "Installation cancelled." : "Installation failed. Close this dialog to begin a new request."}</p>
      {request.status === "executing" && <SdkProgress label="Installing app" />}
      {confirmationUrl && <a className="hosty-sdk-button" href={confirmationUrl} target="_blank" rel="noopener noreferrer"><SdkIcon name="external" />Open Core confirmation</a>}
      {request.status === "succeeded" && <p className="hosty-install-description">Open Apps to check configuration and runtime status.</p>}
      <p><small>Closing this dialog does not cancel an operation already confirmed in Core.</small></p>
      {["succeeded", "denied", "failed"].includes(request.status) && <button type="button" className="hosty-sdk-button hosty-sdk-primary" onClick={close}>Done</button>}
    </section>}
  </dialog>;
}

const styles = `
.hosty-install{box-sizing:border-box;width:min(440px,calc(100vw - 32px));max-height:calc(100dvh - 32px);padding:24px;border:1px solid var(--hs-border);border-radius:14px;background:var(--hs-card);color:var(--hs-fg);overflow:auto;margin:auto;box-shadow:0 14px 34px -8px #0F1B2D3D}
.hosty-install::backdrop{background:#0F1B2D57}.hosty-install>header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px}.hosty-install header .hosty-sdk-brand{margin-bottom:8px}.hosty-install h2{font:600 20px/26px var(--hs-font);letter-spacing:-.02em;margin:0}.hosty-install h3{font:600 16px/22px var(--hs-font);margin:0}.hosty-install p{margin:0;font-size:14px;line-height:22px;color:var(--hs-muted)}.hosty-install small{font-size:12px;line-height:18px}.hosty-install form{display:flex;flex-direction:column;gap:16px}.hosty-install label{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:500}.hosty-install input.hosty-sdk-input{font-family:var(--hs-mono);font-size:13px}
.hosty-install-state{display:flex;flex-direction:column;align-items:flex-start;gap:12px}.hosty-install-state>.hosty-sdk-button{align-self:stretch}.hosty-install-state-icon{display:grid;place-items:center;width:36px;height:36px;border-radius:50%;background:var(--hs-danger-soft);color:var(--hs-danger)}.hosty-install-state[data-state=pending]>.hosty-install-state-icon{background:var(--hs-warning-soft);color:var(--hs-warning)}.hosty-install-state[data-state=succeeded]>.hosty-install-state-icon{background:var(--hs-success-soft);color:var(--hs-success)}.hosty-install-state[data-state=denied]>.hosty-install-state-icon{background:var(--hs-soft);color:var(--hs-muted)}.hosty-install-state[data-state=executing]>.hosty-sdk-spinner{width:24px;height:24px}.hosty-install .hosty-install-error{margin:16px 0;padding:12px;border-radius:10px;background:var(--hs-danger-soft)}.hosty-install-error>p{display:flex;align-items:flex-start;gap:8px;overflow-wrap:anywhere;color:var(--hs-danger)}.hosty-install-error svg{margin-top:3px}.hosty-install-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.hosty-install>.hosty-install-description{margin:12px 0}
@media(max-width:480px){.hosty-install{padding:20px}.hosty-install input.hosty-sdk-input{font-size:16px}}
`;
