"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
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

  return <dialog ref={dialog} className="hosty-install" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); close(); }}>
    <style>{styles}</style>
    <header><h2 id={titleId}>Install app</h2><button type="button" onClick={close} aria-label="Close installation">×</button></header>
    {!hasSource && !request && <form onSubmit={event => { event.preventDefault(); void install(); }}>
      <label>Manifest, app directory, or URL<input value={manifestPath} onChange={event => setManifestPath(event.target.value)} required disabled={busy} /></label>
      <button className="primary" disabled={busy || !manifestPath.trim()}>Install</button>
    </form>}
    {busy && <p role="status">Preparing Core confirmation…</p>}
    {(error || presentationError) && <div role="alert"><p>{error || presentationError}</p>
      {(!frozen || uncertainSubmit) && <button type="button" disabled={busy} onClick={() => void retry()}>
        {uncertainSubmit ? "Check request status" : "Retry"}
      </button>}
      {!frozen && onChooseSource && <button type="button" disabled={busy} onClick={() => { closeUnusedPopup(); onChooseSource(); }}>Change source</button>}
    </div>}
    {uncertainSubmit && <p role="status">Core may have received this request. Check its status before continuing.</p>}
    {request && request.status !== "draft" && <section role="status">
      <p>{request.status === "pending" ? "Confirm runtime, automatic startup and permissions in Hosty Core." : request.status === "executing" ? "Core is installing your app…" : request.status === "succeeded" ? "App installed." : request.status === "denied" ? "Installation cancelled." : "Installation failed. Close this dialog to begin a new request."}</p>
      {confirmationUrl && <a href={confirmationUrl} target="_blank" rel="noopener noreferrer">Open Core confirmation</a>}
      <p><small>Closing this dialog does not cancel an operation already confirmed in Core.</small></p>
    </section>}
  </dialog>;
}

const styles = `
.hosty-install{box-sizing:border-box;width:min(480px,calc(100vw - 32px));max-height:calc(100dvh - 32px);padding:24px;border:1px solid var(--border,#aaa);border-radius:12px;background:var(--background,Canvas);color:var(--foreground,CanvasText);font:inherit;overflow:auto;margin:auto}
.hosty-install::backdrop{background:#0008}.hosty-install header{display:flex;align-items:center;justify-content:space-between;gap:16px}.hosty-install h2{font-size:1.25rem;margin:0}.hosty-install p{margin:12px 0;font-size:.9rem}.hosty-install small{font-size:.8rem;opacity:.75}.hosty-install label{display:flex;flex-direction:column;gap:6px;margin:16px 0;font-size:.9rem}.hosty-install input{box-sizing:border-box;width:100%;border:1px solid var(--border,#aaa);border-radius:6px;padding:8px 10px;background:transparent;color:inherit;font:inherit}.hosty-install button{border:1px solid var(--border,#aaa);border-radius:6px;padding:8px 12px;font:inherit;background:transparent;color:inherit;cursor:pointer}.hosty-install button:disabled{opacity:.5;cursor:default}.hosty-install .primary{background:#2563eb;color:white;border-color:#2563eb}.hosty-install [role=alert]{color:#d33}.hosty-install a{color:#2563eb;text-decoration:underline}.hosty-install :focus-visible{outline:2px solid #60a5fa;outline-offset:3px}
`;
