"use client";

import { useEffect, useState } from "react";
import { listAgentConnections, type ModelCatalog } from "@/lib/assistant-api";
import { connectionModels, listProfiles, type ProfileDirectory } from "@/lib/profiles-api";
import type { AgentConnection } from "./agent-providers";
import { Button } from "./ui/button";
import { loadBrowserAgentDefaults, type BrowserAgentDefaults } from "@/lib/browser-agent-preferences";

export type FeedbackAgentConfig = {
  profileId?: string | null;
  profileRevision?: number;
  connectionId?: string;
  executionSelection?: { model: string | null; reasoningEffort: string | null };
  autonomy?: "normal" | "autonomous";
  browserDefaults?: BrowserAgentDefaults;
};

const selectClass = "w-full min-w-0 max-w-full rounded-md border bg-background px-2 py-2 text-sm";

/** Draft-only choices: creating or cancelling a review never changes a chat or saved defaults. */
export function FeedbackAgentSettings({ value, onChange, disabled, onReadyChange, onDefaultsChange }: {
  value: FeedbackAgentConfig; onChange(value: FeedbackAgentConfig): void; disabled: boolean;
  onReadyChange(ready: boolean): void;
  onDefaultsChange(defaults: BrowserAgentDefaults | undefined): void;
}) {
  const [directory, setDirectory] = useState<{ profiles: ProfileDirectory; connections: AgentConnection[]; defaultId: string | null } | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [catalogResult, setCatalogResult] = useState<{ connectionId: string; catalog?: ModelCatalog; error?: string } | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([listProfiles(), listAgentConnections(), loadBrowserAgentDefaults()]).then(([profiles, connections, defaults]) => {
      if (active) { setDirectory({ profiles, ...connections }); onDefaultsChange(defaults); setError(""); }
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "Agent choices unavailable."); });
    return () => { active = false; };
  }, [retry, onDefaultsChange]);
  const profileId = value.profileId === undefined ? directory?.profiles.defaultId : value.profileId;
  const profile = directory?.profiles.profiles.find(p => p.id === profileId);
  const profileChanged = !!profile && value.profileId != null && value.profileRevision !== profile.revision;
  const connectionId = profile?.connectionId ?? value.connectionId ?? directory?.defaultId ?? "";
  const connection = directory?.connections.find(c => c.id === connectionId);
  const catalog = catalogResult?.connectionId === connectionId ? catalogResult.catalog : undefined;
  const catalogError = catalogResult?.connectionId === connectionId ? catalogResult.error : undefined;
  useEffect(() => {
    let active = true;
    if (connectionId) void connectionModels(connectionId).then(catalog => {
      if (active) setCatalogResult({ connectionId, catalog });
    }).catch(cause => { if (active) setCatalogResult({ connectionId, error: cause instanceof Error ? cause.message : "Model choices unavailable." }); });
    return () => { active = false; };
  }, [connectionId, retry]);
  const remembered = value.browserDefaults?.models?.[connectionId];
  const rememberedModel = catalog?.models.find(model => model.id === (remembered?.model ?? catalog.defaultModel));
  const compatible = remembered && rememberedModel && !rememberedModel.unavailableReason
    && (!remembered.reasoningEffort || rememberedModel.efforts.some(effort => effort.id === remembered.reasoningEffort));
  const selection = profile ? { model: profile.model, reasoningEffort: profile.reasoningEffort }
    : value.executionSelection ?? (compatible ? remembered : { model: null, reasoningEffort: null });
  const model = catalog?.models.find(m => m.id === (selection.model ?? catalog.defaultModel));
  const unavailable = !!profileId && !profile || !connection?.available || !!model?.unavailableReason
    || !!selection.model && !!catalog && !model
    || !!selection.reasoningEffort && !!catalog && !model?.efforts.some(e => e.id === selection.reasoningEffort);
  const ready = !!directory && !error && !!catalog && !unavailable && !profileChanged;
  useEffect(() => { onReadyChange(ready); }, [ready, onReadyChange]);
  const manual = (executionSelection: NonNullable<FeedbackAgentConfig["executionSelection"]>) => onChange({
    profileId: null, connectionId, executionSelection, autonomy: value.autonomy, browserDefaults: value.browserDefaults,
  });
  return <fieldset className="min-w-0 space-y-3" disabled={disabled}>
    <legend className="mb-2 text-sm font-medium">New chat settings</legend>
    <label className="grid min-w-0 gap-1 text-sm">Agent profile<select aria-label="Agent profile" className={selectClass}
      value={value.profileId === undefined ? "__default__" : value.profileId ?? "__none__"} disabled={!directory}
      onChange={event => {
        const id = event.target.value;
        const chosen = directory?.profiles.profiles.find(p => p.id === id);
        onChange({ autonomy: value.autonomy, browserDefaults: value.browserDefaults, ...(id === "__default__" ? {} : { profileId: chosen?.id ?? null, ...(chosen ? { profileRevision: chosen.revision } : {}) }) });
      }}>
      <option value="__default__">Default profile{directory?.profiles.defaultId ? ` · ${directory.profiles.profiles.find(p => p.id === directory.profiles.defaultId)?.name ?? "Unavailable"}` : " · No profile"}</option>
      <option value="__none__">No profile · custom settings</option>
      {directory?.profiles.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
    </select></label>
    <label className="grid min-w-0 gap-1 text-sm">Agent / provider<select aria-label="Agent / provider" className={selectClass}
      value={connectionId} disabled={!directory || !!profile} onChange={event => onChange({ profileId: null, connectionId: event.target.value,
        autonomy: value.autonomy, browserDefaults: value.browserDefaults })}>
      {!connectionId && <option value="">Choose an agent connection</option>}
      {directory?.connections.map(connection => <option key={connection.id} value={connection.id} disabled={!connection.available}>{connection.name} · {connection.kind}{connection.available ? "" : " · unavailable"}</option>)}
    </select></label>
    <label className="grid min-w-0 gap-1 text-sm">Model<select aria-label="Model" className={selectClass} value={selection.model ?? ""}
      disabled={!!profile || !catalog} onChange={event => {
        const next = event.target.value || null;
        const choice = catalog?.models.find(m => m.id === (next ?? catalog.defaultModel));
        manual({ model: next, reasoningEffort: choice?.efforts.some(e => e.id === selection.reasoningEffort) ? selection.reasoningEffort : null });
      }}>
      <option value="">Agent default</option>
      {selection.model && catalog && !model && <option value={selection.model}>{selection.model} · unavailable</option>}
      {catalog?.models.map(model => <option key={model.id} value={model.id} disabled={!!model.unavailableReason}>{model.label}{model.unavailableReason ? ` · ${model.unavailableReason}` : ""}</option>)}
    </select></label>
    <label className="grid min-w-0 gap-1 text-sm">Reasoning effort<select aria-label="Reasoning effort" className={selectClass} value={selection.reasoningEffort ?? ""}
      disabled={!!profile || !model?.efforts.length || !!model.unavailableReason} onChange={event => manual({ ...selection, reasoningEffort: event.target.value || null })}>
      <option value="">Default effort</option>
      {selection.reasoningEffort && !model?.efforts.some(e => e.id === selection.reasoningEffort) && <option value={selection.reasoningEffort}>{selection.reasoningEffort} · unavailable</option>}
      {model?.efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.label}</option>)}
    </select></label>
    {profile && <p className="text-xs text-muted-foreground">Provider, model and reasoning come from this profile. Choose custom settings to change them.</p>}
    {profileChanged && <div className="space-y-2"><p role="alert" className="text-xs">This profile changed. Review its current settings before sending.</p><Button type="button" variant="outline" size="sm"
      onClick={() => onChange({ ...value, profileRevision: profile.revision })}>Use updated profile</Button></div>}
    {model && !model.efforts.length && <p className="text-xs text-muted-foreground">This model does not offer reasoning levels.</p>}
    <label className="grid min-w-0 gap-1 text-sm">Autonomy<select aria-label="Autonomy" className={selectClass} value={value.autonomy ?? value.browserDefaults?.autonomy ?? "normal"}
      onChange={event => onChange({ ...value, autonomy: event.target.value as "normal" | "autonomous" })}>
      <option value="normal">Normal</option><option value="autonomous">Autonomous</option>
    </select></label>
    <p className="text-xs text-muted-foreground">{(value.autonomy ?? value.browserDefaults?.autonomy) === "autonomous" ? "Commands, file changes and enabled tools can run without approval. Disabled tools stay disabled." : "Use tool rules; ask for other actions."}</p>
    {!directory && !error && <p role="status" className="text-xs">Loading agent choices…</p>}
    {directory && !catalog && !catalogError && connectionId && <p role="status" className="text-xs">Loading models…</p>}
    {directory && unavailable && <p role="alert" className="text-xs wrap-anywhere">The selected agent configuration is unavailable. Choose an available profile, connection and model.</p>}
    {(error || catalogError) && <div className="space-y-2"><p role="alert" className="text-xs wrap-anywhere">{error || catalogError}</p><Button type="button" variant="outline" size="sm" onClick={() => setRetry(n => n + 1)}>Refresh agent choices</Button></div>}
  </fieldset>;
}
