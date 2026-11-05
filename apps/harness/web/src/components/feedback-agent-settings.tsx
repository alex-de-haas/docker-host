"use client";

import { useEffect, useState } from "react";
import { listAgentConnections, type ModelCatalog } from "@/lib/assistant-api";
import { connectionModels, listProfiles, type ProfileDirectory } from "@/lib/profiles-api";
import type { AgentConnection } from "./agent-providers";
import { Button } from "./ui/button";
import { FeedbackSelect } from "./feedback-select";
import { loadBrowserAgentDefaults, type BrowserAgentDefaults } from "@/lib/browser-agent-preferences";

export type FeedbackAgentConfig = {
  profileId?: string | null;
  profileRevision?: number;
  connectionId?: string;
  executionSelection?: { model: string | null; reasoningEffort: string | null };
  autonomy?: "normal" | "autonomous";
  browserDefaults?: BrowserAgentDefaults;
};

const selectClass = "w-full min-w-0 max-w-full";
const profileOption = (id: string) => `profile:${id}`;

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
    <div className="grid min-w-0 gap-1 text-sm"><span>Agent profile</span><FeedbackSelect label="Agent profile" className={selectClass}
      value={value.profileId === undefined ? "default" : value.profileId === null ? "custom" : profileOption(value.profileId)} disabled={disabled || !directory}
      onValueChange={choice => {
        const chosen = directory?.profiles.profiles.find(p => profileOption(p.id) === choice);
        onChange({ autonomy: value.autonomy, browserDefaults: value.browserDefaults, ...(choice === "default" ? {} : { profileId: chosen?.id ?? null, ...(chosen ? { profileRevision: chosen.revision } : {}) }) });
      }} options={[
        { value: "default", label: `Default profile${directory?.profiles.defaultId ? ` · ${directory.profiles.profiles.find(p => p.id === directory.profiles.defaultId)?.name ?? "Unavailable"}` : " · No profile"}` },
        { value: "custom", label: "No profile · custom settings" },
        ...(value.profileId != null && directory && !profile ? [{ value: profileOption(value.profileId), label: `${value.profileId} · unavailable`, disabled: true }] : []),
        ...(directory?.profiles.profiles.map(profile => ({ value: profileOption(profile.id), label: profile.name })) ?? []),
      ]} /></div>
    <div className="grid min-w-0 gap-1 text-sm"><span>Agent / provider</span><FeedbackSelect label="Agent / provider" className={selectClass}
      value={connectionId} disabled={disabled || !directory || !!profile} onValueChange={connectionId => onChange({ profileId: null, connectionId,
        autonomy: value.autonomy, browserDefaults: value.browserDefaults })} options={[
        ...(!connectionId ? [{ value: "", label: "Choose an agent connection" }] : []),
        ...(connectionId && directory && !connection ? [{ value: connectionId, label: `${connectionId} · unavailable`, disabled: true }] : []),
        ...(directory?.connections.map(connection => ({ value: connection.id, label: `${connection.name} · ${connection.kind}${connection.available ? "" : " · unavailable"}`, disabled: !connection.available })) ?? []),
      ]} /></div>
    <div className="grid min-w-0 gap-1 text-sm"><span>Model</span><FeedbackSelect label="Model" className={selectClass} value={selection.model ?? ""}
      disabled={disabled || !!profile || !catalog} onValueChange={selected => {
        const next = selected || null;
        const choice = catalog?.models.find(m => m.id === (next ?? catalog.defaultModel));
        manual({ model: next, reasoningEffort: choice?.efforts.some(e => e.id === selection.reasoningEffort) ? selection.reasoningEffort : null });
      }} options={[
        { value: "", label: "Agent default" },
        ...(selection.model && catalog && !model ? [{ value: selection.model, label: `${selection.model} · unavailable` }] : []),
        ...(catalog?.models.map(model => ({ value: model.id, label: `${model.label}${model.unavailableReason ? ` · ${model.unavailableReason}` : ""}`, disabled: !!model.unavailableReason })) ?? []),
      ]} /></div>
    <div className="grid min-w-0 gap-1 text-sm"><span>Reasoning effort</span><FeedbackSelect label="Reasoning effort" className={selectClass} value={selection.reasoningEffort ?? ""}
      disabled={disabled || !!profile || !model?.efforts.length || !!model.unavailableReason} onValueChange={reasoningEffort => manual({ ...selection, reasoningEffort: reasoningEffort || null })}
      options={[
        { value: "", label: "Default effort" },
        ...(selection.reasoningEffort && !model?.efforts.some(e => e.id === selection.reasoningEffort) ? [{ value: selection.reasoningEffort, label: `${selection.reasoningEffort} · unavailable` }] : []),
        ...(model?.efforts.map(effort => ({ value: effort.id, label: effort.label })) ?? []),
      ]} /></div>
    {profile && <p className="text-xs text-muted-foreground">Provider, model and reasoning come from this profile. Choose custom settings to change them.</p>}
    {profileChanged && <div className="space-y-2"><p role="alert" className="text-xs">This profile changed. Review its current settings before sending.</p><Button type="button" variant="outline" size="sm"
      onClick={() => onChange({ ...value, profileRevision: profile.revision })}>Use updated profile</Button></div>}
    {model && !model.efforts.length && <p className="text-xs text-muted-foreground">This model does not offer reasoning levels.</p>}
    <div className="grid min-w-0 gap-1 text-sm"><span>Autonomy</span><FeedbackSelect label="Autonomy" className={selectClass} value={value.autonomy ?? value.browserDefaults?.autonomy ?? "normal"}
      disabled={disabled} onValueChange={autonomy => onChange({ ...value, autonomy: autonomy as "normal" | "autonomous" })}
      options={[{ value: "normal", label: "Normal" }, { value: "autonomous", label: "Autonomous" }]} /></div>
    <p className="text-xs text-muted-foreground">{(value.autonomy ?? value.browserDefaults?.autonomy) === "autonomous" ? "Commands, file changes and enabled tools can run without approval. Disabled tools stay disabled." : "Use tool rules; ask for other actions."}</p>
    {!directory && !error && <p role="status" className="text-xs">Loading agent choices…</p>}
    {directory && !catalog && !catalogError && connectionId && <p role="status" className="text-xs">Loading models…</p>}
    {directory && unavailable && <p role="alert" className="text-xs wrap-anywhere">The selected agent configuration is unavailable. Choose an available profile, connection and model.</p>}
    {(error || catalogError) && <div className="space-y-2"><p role="alert" className="text-xs wrap-anywhere">{error || catalogError}</p><Button type="button" variant="outline" size="sm" onClick={() => setRetry(n => n + 1)}>Refresh agent choices</Button></div>}
  </fieldset>;
}
