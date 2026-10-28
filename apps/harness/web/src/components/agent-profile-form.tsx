"use client";
import { useEffect, useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { connectionModels, type AgentProfileConfig, type ProfileSkill } from "@/lib/profiles-api";
import type { ModelCatalog } from "@/lib/assistant-api";
import type { AgentConnection } from "./agent-providers";

/** Controlled fields reusable by profiles and future personalized-agent composition. */
export function AgentProfileForm({ value, onChange, connections, defaultConnectionId, skills, skillsError, disabled = false }: {
  value: AgentProfileConfig; onChange(value: AgentProfileConfig): void; connections: AgentConnection[];
  defaultConnectionId: string | null; skills: ProfileSkill[]; skillsError?: string; disabled?: boolean;
}) {
  const uid = useId(), [filter, setFilter] = useState("");
  const connectionId = value.connectionId ?? defaultConnectionId;
  const connection = connections.find(c => c.id === connectionId);
  const binding = `${connectionId}:${connection?.revision}`;
  const [loaded, setLoaded] = useState<{ binding: string; catalog?: ModelCatalog; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    if (connectionId) void connectionModels(connectionId).then(catalog => { if (active) setLoaded({ binding, catalog }); })
      .catch(error => { if (active) setLoaded({ binding, error: error instanceof Error ? error.message : "Could not load models." }); });
    return () => { active = false; };
  }, [connectionId, binding, retry]);
  const catalog = loaded?.binding === binding ? loaded.catalog : undefined;
  const model = catalog?.models.find(m => m.id === (value.model ?? catalog.defaultModel));
  const modelError = loaded?.binding === binding ? loaded.error : undefined;
  const update = (patch: Partial<AgentProfileConfig>) => onChange({ ...value, ...patch });
  const selectClass = "h-9 w-full rounded-md border bg-background px-3 text-sm";
  const visible = skills.filter(s => `${s.name} ${s.description}`.toLowerCase().includes(filter.toLowerCase()));
  return <fieldset disabled={disabled} className="min-w-0 space-y-5">
    <div className="space-y-1"><label htmlFor={`${uid}-name`} className="text-sm font-medium">Name</label>
      <Input id={`${uid}-name`} required maxLength={100} value={value.name} onChange={e => update({ name: e.target.value })} placeholder="Developer, planner, reviewer…" /></div>
    <div className="space-y-1"><label htmlFor={`${uid}-description`} className="text-sm font-medium">Description</label>
      <Textarea id={`${uid}-description`} maxLength={2000} value={value.description} onChange={e => update({ description: e.target.value })} placeholder="When to choose this profile and what it is good at." /></div>
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1 sm:col-span-2"><label htmlFor={`${uid}-connection`} className="text-sm font-medium">Agent connection</label>
        <select id={`${uid}-connection`} className={selectClass} value={value.connectionId ?? ""} onChange={e => update({ connectionId: e.target.value || null, model: null, reasoningEffort: null })}>
          <option value="">Harness default{defaultConnectionId ? ` · ${connections.find(c => c.id === defaultConnectionId)?.name ?? "Unavailable"}` : " · None selected"}</option>
          {value.connectionId && !connections.some(c => c.id === value.connectionId) && <option value={value.connectionId}>Unavailable connection</option>}
          {connections.map(c => <option key={c.id} value={c.id}>{c.name} · {c.kind}{c.available ? "" : " (unavailable)"}</option>)}
        </select></div>
      <div className="space-y-1"><label htmlFor={`${uid}-model`} className="text-sm font-medium">Model</label>
        <select id={`${uid}-model`} className={selectClass} disabled={disabled || !connectionId} value={value.model ?? ""} onChange={e => update({ model: e.target.value || null, reasoningEffort: null })}>
          <option value="">Agent default</option>
          {value.model && !catalog?.models.some(m => m.id === value.model) && <option value={value.model}>{value.model}{catalog ? " (unavailable)" : ""}</option>}
          {catalog?.models.map(m => <option key={m.id} value={m.id} disabled={Boolean(m.unavailableReason)}>{m.label}{m.unavailableReason ? ` — ${m.unavailableReason}` : ""}</option>)}
        </select></div>
      <div className="space-y-1"><label htmlFor={`${uid}-effort`} className="text-sm font-medium">Reasoning effort</label>
        <select id={`${uid}-effort`} className={selectClass} disabled={disabled || !connectionId} value={value.reasoningEffort ?? ""} onChange={e => update({ reasoningEffort: e.target.value || null })}>
          <option value="">Agent default</option>
          {value.reasoningEffort && !model?.efforts.some(e => e.id === value.reasoningEffort) && <option value={value.reasoningEffort}>{value.reasoningEffort}{catalog ? " (unavailable)" : ""}</option>}
          {model?.efforts.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}
        </select></div>
    </div>
    {modelError && <div className="text-sm"><p role="alert">{modelError}</p><Button type="button" variant="outline" size="sm" onClick={() => setRetry(n => n + 1)}>Retry models</Button></div>}
    <div className="space-y-1"><label htmlFor={`${uid}-instructions`} className="text-sm font-medium">Role instructions</label>
      <p id={`${uid}-guidance`} className="text-xs text-muted-foreground">Describe this role&apos;s approach, specialization and expected output. Shared workflow and repository rules belong in Common instructions.</p>
      <Textarea id={`${uid}-instructions`} aria-describedby={`${uid}-guidance`} className="min-h-40" maxLength={8000} value={value.instructions} onChange={e => update({ instructions: e.target.value })} /></div>
    <div className="space-y-3"><label htmlFor={`${uid}-filter`} className="text-sm font-medium">Skills</label>
      <p className="text-xs text-muted-foreground">Platform guidance is included for every agent. Choose additional guidance this agent can use when relevant. Manage available packages in the shared Skills library.</p>
      <Input id={`${uid}-filter`} value={filter} onChange={e => setFilter(e.target.value)} placeholder="Find skills" />
      {skillsError ? <p role="alert" className="text-sm">{skillsError} Existing selections are retained.</p> : <div className="max-h-64 space-y-2 overflow-y-auto">
        {visible.map(skill => <label key={skill.id} className="flex items-start gap-3 rounded-md border p-3 text-sm">
          <Checkbox disabled={skill.sourceKind === "core" && !!skill.introductionPath} checked={skill.sourceKind === "core" && !!skill.introductionPath || value.skillIds.includes(skill.id)} onCheckedChange={checked => update({ skillIds: checked === true ? [...value.skillIds, skill.id] : value.skillIds.filter(id => id !== skill.id) })} />
          <span><span className="font-medium">{skill.name}</span><span className="block text-muted-foreground">{skill.description}</span>
            {skill.sourceKind === "core" && <span className="block text-xs text-muted-foreground">Core · {skill.coreVersion}{skill.introductionPath ? " · Included for every agent" : ""}</span>}</span>
        </label>)}
        {!visible.length && <p className="text-sm text-muted-foreground">{skills.length ? "No matching skills." : "No skills installed yet."}</p>}
      </div>}
    </div>
  </fieldset>;
}
