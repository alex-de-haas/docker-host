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

export interface InstallDialogProps {
  client: InstallationClient;
  source?: InstallationSource;
  onClose: () => void;
  onInstalled?: (request: InstallationRequest) => void;
}

/** Mount when opened; unmount on close. Styling is self-contained and has no Next/Tailwind dependency. */
export function InstallDialog({ client, source, onClose, onInstalled }: InstallDialogProps) {
  const { request, busy, error, flow } = useInstallation(client);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [manifestPath, setManifestPath] = useState(source?.manifestPath ?? "");
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [autostart, setAutostart] = useState(true);
  const [draftPlanId, setDraftPlanId] = useState<string | null>(null);
  const notified = useRef<string | null>(null);
  const plan = request?.plan ?? null;
  if (plan && request?.id !== draftPlanId) {
    setDraftPlanId(request!.id);
    setSettings(Object.fromEntries(plan.settings.map(setting => [setting.key, setting.secret ? "" : setting.defaultValue ?? ""])));
    setAutostart(plan.defaultAutostart ?? true);
  }
  const initialManifest = source?.manifestPath;
  const initialFeed = source?.feedsUrl;
  const initialFeedId = source?.feedId;
  useEffect(() => {
    if (initialManifest || initialFeed) void flow.review({ manifestPath: initialManifest, feedsUrl: initialFeed, feedId: initialFeedId });
  }, [flow, initialManifest, initialFeed, initialFeedId]);
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

  const frozen = request !== null && request.status !== "draft";
  const review = (runtime?: string) => flow.review({
    ...(source?.feedsUrl ? { feedsUrl: source.feedsUrl, feedId: source.feedId } : { manifestPath: manifestPath.trim() }),
    selectedRuntime: runtime,
  });
  const submit = async () => {
    const popup = openInstallationConfirmation();
    const values = Object.fromEntries((plan?.settings ?? []).filter(setting => !setting.secret || settings[setting.key])
      .map(setting => [setting.key, settings[setting.key] ?? ""]));
    const submitted = await flow.submit(values, autostart);
    if (submitted) showInstallationConfirmation(popup, submitted);
    else popup?.close();
  };

  return <dialog ref={dialog} className="hosty-install" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <style>{styles}</style>
    <header><h2 id={titleId}>Install app</h2><button type="button" onClick={onClose} aria-label="Close installation">×</button></header>
    <p>Prepare the installation here, then confirm it securely in Hosty Core.</p>
    {!source?.feedsUrl && !source?.manifestPath && <form onSubmit={event => { event.preventDefault(); void review(); }}>
      <label>Manifest, app directory, or URL<input value={manifestPath} onChange={event => { setManifestPath(event.target.value); flow.clearReview(); }} required disabled={busy || frozen} /></label>
      <button disabled={busy || frozen || !manifestPath.trim()}>Review</button>
    </form>}
    {busy && <p role="status">Preparing installation…</p>}
    {error && <div role="alert"><p>{error}</p>{!frozen && <button type="button" disabled={busy} onClick={() => void review()}>Retry review</button>}</div>}
    {plan && <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <h3>{plan.displayName} <small>{plan.targetVersion}</small></h3>
      {plan.description && <p>{plan.description}</p>}
      <label>Runtime<select value={plan.targetRuntime} disabled={busy || frozen} onChange={event => void review(event.target.value)}>
        {(plan.runtimeProfiles ?? [{ key: plan.targetRuntime, type: plan.targetRuntimeType }]).map(runtime =>
          <option key={runtime.key} value={runtime.key}>{runtime.key} ({runtime.type})</option>)}
      </select></label>
      {plan.targetRuntimeType === "localCommand" && <p className="warning">This runtime runs commands directly on your host, outside a container. Only install code you trust.</p>}
      {plan.system && <p className="warning">This is a system app. Only host administrators can open it.</p>}
      {!!plan.corePermissions?.length && <section><h3>Requested Core permissions</h3><ul>{plan.corePermissions.map(permission => <li key={permission}>{permission}</li>)}</ul></section>}
      {plan.settings.map(setting => <label key={setting.key}>
        {setting.label || setting.key}{setting.required ? " (required)" : ""}
        {setting.type === "boolean" && !setting.secret
          ? <input type="checkbox" checked={["true", "1", "yes", "on", "enabled"].includes((settings[setting.key] ?? "").toLowerCase())}
            disabled={busy || frozen} onChange={event => setSettings(current => ({ ...current, [setting.key]: String(event.target.checked) }))} />
          : setting.type === "select" && setting.options?.length && !setting.secret
            ? <select value={settings[setting.key] ?? ""} disabled={busy || frozen} onChange={event => setSettings(current => ({ ...current, [setting.key]: event.target.value }))}>
              <option value="">Select a value</option>{setting.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            : <input type={setting.secret ? "password" : setting.type === "number" ? "number" : setting.type === "url" ? "url" : "text"}
              step={setting.type === "number" ? "any" : undefined} autoComplete={setting.secret ? "new-password" : "off"}
              required={setting.required && !setting.secret} disabled={busy || frozen} value={settings[setting.key] ?? ""}
              onChange={event => setSettings(current => ({ ...current, [setting.key]: event.target.value }))} />}
        {setting.description && <small>{setting.description}</small>}
      </label>)}
      <label className="check"><input type="checkbox" checked={autostart} disabled={busy || frozen} onChange={event => setAutostart(event.target.checked)} /> Start automatically (now and on Core startup)</label>
      {!frozen && <footer><button className="primary" disabled={busy}>Continue to Core confirmation</button></footer>}
    </form>}
    {frozen && <section role="status">
      <p>{request.status === "pending" ? "Waiting for your confirmation in Hosty Core." : request.status === "executing" ? "Core is applying your confirmed request…" : request.status === "succeeded" ? "App installed." : request.status === "denied" ? "Installation cancelled." : "Installation failed. Close this dialog and review a new plan to retry."}</p>
      {request.status === "pending" && <a href={request.approvalUrl} target="_blank" rel="noopener noreferrer">Open Core confirmation</a>}
      <p><small>Closing this dialog does not cancel an operation already confirmed in Core.</small></p>
    </section>}
  </dialog>;
}

const styles = `
.hosty-install{box-sizing:border-box;width:min(640px,calc(100vw - 32px));max-height:calc(100dvh - 32px);padding:24px;border:1px solid var(--border,#aaa);border-radius:12px;background:var(--background,Canvas);color:var(--foreground,CanvasText);font:inherit;overflow:auto;margin:auto}
.hosty-install::backdrop{background:#0008}.hosty-install header{display:flex;align-items:center;justify-content:space-between;gap:16px}.hosty-install h2{font-size:1.25rem;margin:0}.hosty-install h3{font-size:1rem;margin:20px 0 8px}.hosty-install p{margin:12px 0;font-size:.9rem}.hosty-install small{font-size:.8rem;opacity:.75}.hosty-install label{display:flex;flex-direction:column;gap:6px;margin:16px 0;font-size:.9rem}.hosty-install input:not([type=checkbox]),.hosty-install select{box-sizing:border-box;width:100%;border:1px solid var(--border,#aaa);border-radius:6px;padding:8px 10px;background:transparent;color:inherit;font:inherit}.hosty-install .check{flex-direction:row;align-items:center;gap:10px}.hosty-install input[type=checkbox]{width:16px;height:16px;accent-color:#2563eb}.hosty-install button{border:1px solid var(--border,#aaa);border-radius:6px;padding:8px 12px;font:inherit;background:transparent;color:inherit;cursor:pointer}.hosty-install button:disabled{opacity:.5;cursor:default}.hosty-install .primary{background:#2563eb;color:white;border-color:#2563eb}.hosty-install footer{display:flex;justify-content:flex-end;margin-top:24px}.hosty-install .warning{padding:12px;border:1px solid #b7791f;border-radius:6px}.hosty-install [role=alert]{color:#d33}.hosty-install a{color:#2563eb;text-decoration:underline}.hosty-install :focus-visible{outline:2px solid #60a5fa;outline-offset:3px}
`;
