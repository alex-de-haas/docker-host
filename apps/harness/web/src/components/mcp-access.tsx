"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Info, RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError, call, loadSettings, type Settings, type SettingsResponse, type ToolCatalog, type ToolRule } from "@/lib/api";

type Mode = "ask" | "run";
type Access = { enabled: boolean; denied: string[] };
type Draft = { access: Record<string, Access>; defaults: NonNullable<Settings["mcpDefaults"]>; rules: Record<string, ToolRule>;
  skills: NonNullable<Settings["mcpSkillApprovals"]>; resetProviders: string[] };
type Review = { id: string; status: string; approvalUrl: string; error?: string };
const keyOf = (provider: string, tool: string) => JSON.stringify([provider, tool]);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function initial(data: SettingsResponse): Draft {
  const access = Object.fromEntries(data.providers.map(p => [p.appId, { enabled: p.offered === true, denied: [...p.deniedTools ?? []] }]));
  // Old local Disabled choices stay effective until their explicit Core migration is reviewed.
  for (const [key, rule] of Object.entries(data.settings.mcpToolRules ?? {})) {
    if (rule.mode !== "disabled") continue;
    const [provider, tool] = JSON.parse(key) as string[];
    if (access[provider!] && !access[provider!]!.denied.includes(tool!)) access[provider!]!.denied.push(tool!);
  }
  return { access, defaults: { ...data.settings.mcpDefaults }, rules: { ...data.settings.mcpToolRules },
    skills: { ...data.settings.mcpSkillApprovals }, resetProviders: [] };
}
// Refresh adopts concurrent changes only for fields the operator has not edited.
function rebaseDraft(previous: Draft, draft: Draft, next: Draft): Draft {
  function merge<T>(before: Record<string, T>, edited: Record<string, T>, fresh: Record<string, T>) {
    const result = { ...fresh };
    for (const key of new Set([...Object.keys(before), ...Object.keys(edited)])) {
      if (equal(before[key], edited[key])) continue;
      if (Object.hasOwn(edited, key)) result[key] = edited[key]!; else delete result[key];
    }
    return result;
  }
  return { access: merge(previous.access, draft.access, next.access), defaults: merge(previous.defaults, draft.defaults, next.defaults),
    rules: merge(previous.rules, draft.rules, next.rules), skills: merge(previous.skills, draft.skills, next.skills), resetProviders: draft.resetProviders };
}
// Never attach a fresh concurrency token to an edit of the same field in another client.
function hasDraftConflict(previous: Draft, draft: Draft, next: Draft): boolean {
  function overlap<T>(before: Record<string, T>, edited: Record<string, T>, fresh: Record<string, T>) {
    return [...new Set([...Object.keys(before), ...Object.keys(edited)])].some(key =>
      !equal(before[key], edited[key]) && !equal(before[key], fresh[key]));
  }
  if (overlap(previous.access, draft.access, next.access) || overlap(previous.defaults, draft.defaults, next.defaults) ||
    overlap(previous.rules, draft.rules, next.rules) || overlap(previous.skills, draft.skills, next.skills)) return true;
  // A bulk preference change also removes tool exceptions that were added concurrently.
  return draft.resetProviders.some(provider => !equal(previous.defaults[provider], next.defaults[provider]) ||
    [...new Set([...Object.keys(previous.rules), ...Object.keys(next.rules)])].some(key =>
      JSON.parse(key)[0] === provider && !equal(previous.rules[key], next.rules[key])));
}
function ModeSelect({ value, label, disabled, change }: { value: Mode | "mixed"; label: string; disabled?: boolean; change: (value: Mode) => void }) {
  return <Select value={value} disabled={disabled} onValueChange={v => change(v as Mode)}><SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
    <SelectContent><SelectGroup>{value === "mixed" && <SelectItem value="mixed" disabled>Mixed</SelectItem>}<SelectItem value="ask">Ask</SelectItem><SelectItem value="run">Do not ask</SelectItem></SelectGroup></SelectContent></Select>;
}

export function McpAccess({ data, onRefresh }: { data: SettingsResponse; busy: boolean; error: string | null; status: string | null;
  feedbackAppId: string | null; onRefresh: () => Promise<void>; onSave: (patch: Partial<Settings>, appId: string) => Promise<void> }) {
  const [base, setBase] = useState(data);
  const [latest, setLatest] = useState(data);
  const [draft, setDraft] = useState(() => initial(data));
  const [catalogs, setCatalogs] = useState<ToolCatalog[]>(data.toolCatalogs ?? []);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false);
  const [error, setError] = useState(""), [status, setStatus] = useState(""), [review, setReview] = useState<Review | null>(null);
  const pending = useRef<{ input: unknown; review?: Review } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    // Catalogs are loaded on entry, not polled. Discovery never replaces the access draft.
    void call("/settings/tools").then(response => response.json()).then((result: { catalogs: ToolCatalog[]; unavailable?: string[] }) => {
      if (!active) return;
      setCatalogs(result.catalogs);
      if (result.unavailable?.length) setError(`Could not load tools for ${result.unavailable.join(", ")}. Existing choices are preserved.`);
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; mounted.current = false; };
  }, []);
  const [previousData, setPreviousData] = useState(data);
  if (previousData !== data) {
    setPreviousData(data); setLatest(data);
    if (!dirty && !busy) { setBase(data); setDraft(initial(data)); setCatalogs(data.toolCatalogs ?? []); }
  }
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", prevent); return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  const change = (next: Draft) => { setDraft(next); setDirty(true); setStatus(""); pending.current = null; };
  const refresh = async () => {
    setLoading(true); setError("");
    try {
      const result = await (await call("/settings/tools")).json() as { catalogs: ToolCatalog[]; unavailable?: string[] };
      setCatalogs(result.catalogs);
      if (result.unavailable?.length) setError(`Could not load tools for ${result.unavailable.join(", ")}. Existing choices are preserved.`);
      const loaded = await loadSettings(); setLatest(loaded);
      if (!pending.current) {
        if (dirty && hasDraftConflict(initial(base), draft, initial(loaded))) {
          setError("These settings changed in another client. Your draft is preserved. Discard it to load current values before editing again.");
        } else {
          setBase(loaded); setDraft(dirty ? rebaseDraft(initial(base), draft, initial(loaded)) : initial(loaded));
        }
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  const mode = (catalog: ToolCatalog, tool: string): Mode => {
    const rule = draft.rules[keyOf(catalog.provider, tool)], fallback = draft.defaults[catalog.provider];
    return rule?.identity === catalog.identity && rule.mode !== "disabled" ? rule.mode : fallback?.identity === catalog.identity ? fallback.mode : "ask";
  };
  const locallyDisabled = (catalog: ToolCatalog, tool: string) => catalog.provider === "hosty:development" &&
    draft.rules[keyOf(catalog.provider, tool)]?.mode === "disabled";
  const bulk = (providers: string[], value: Mode) => {
    const defaults = { ...draft.defaults }, rules = { ...draft.rules }, resetProviders = new Set(draft.resetProviders);
    for (const id of providers) {
      const catalog = catalogs.find(c => c.provider === id); if (!catalog) continue;
      defaults[id] = { identity: catalog.identity, mode: value }; resetProviders.add(id);
      for (const key of Object.keys(rules)) if (JSON.parse(key)[0] === id && rules[key]?.mode !== "disabled") delete rules[key];
    }
    change({ ...draft, defaults, rules, resetProviders: [...resetProviders] });
  };
  const save = async () => {
    setBusy(true); setError(""); setStatus("");
    const targets = base.providers.flatMap(p => {
      const value = draft.access[p.appId];
      return value && (value.enabled !== (p.offered === true) || !equal([...value.denied].sort(), [...p.deniedTools ?? []].sort()))
        ? [{ targetId: p.appId, enabled: value.enabled, deniedTools: value.denied }] : [];
    });
    const popup = targets.length && !pending.current?.review ? window.open("about:blank", "_blank") : null;
    if (popup) popup.opener = null;
    try {
      if (targets.length) {
        if (!base.accessRevision) throw new Error("Reload the Core directory before saving access.");
        pending.current ??= { input: { requestId: crypto.randomUUID(), revision: base.accessRevision, targets } };
        let current = pending.current.review ?? await (await call("/settings/mcp/review", { method: "POST", body: JSON.stringify(pending.current.input) })).json() as Review;
        pending.current.review = current; setReview(current);
        if (popup) popup.location.href = current.approvalUrl;
        setStatus("Confirm the access changes in Core.");
        const deadline = Date.now() + 15 * 60_000;
        while (current.status === "pending" || current.status === "executing") {
          if (!mounted.current) return;
          if (Date.now() > deadline) throw new Error("Review is still pending. Retry to check the same request.");
          await new Promise(resolve => setTimeout(resolve, 1500));
          current = await (await call(`/settings/mcp/review/${current.id}`)).json() as Review;
          pending.current.review = current; setReview(current);
        }
        if (current.status !== "succeeded") { pending.current = null; setReview(null); setStatus(""); throw new Error(current.error ?? "Access changes were cancelled. Your draft is preserved."); }
        // Record the actual saved access before saving Harness. A failed second step never repeats Core approval.
        const savedAccess = (previous: SettingsResponse) => ({ ...previous, providers: previous.providers.map(p => ({ ...p,
          offered: draft.access[p.appId]?.enabled ?? p.offered, deniedTools: draft.access[p.appId]?.denied ?? p.deniedTools })) });
        setBase(savedAccess); setLatest(savedAccess);
        pending.current = null; setReview(null); setStatus("Access saved. Saving Harness preferences…");
      }
      const defaults = Object.fromEntries(Object.entries(draft.defaults).filter(([id, value]) => !equal(value, base.settings.mcpDefaults?.[id]) || draft.resetProviders.includes(id)));
      const rules = Object.fromEntries(Object.entries(draft.rules).filter(([key, value]) => (value.mode !== "disabled" || JSON.parse(key)[0] === "hosty:development") &&
        (!equal(value, base.settings.mcpToolRules?.[key]) || draft.resetProviders.includes(JSON.parse(key)[0]))));
      await call("/settings/mcp/preferences", { method: "PUT", body: JSON.stringify({ revision: base.mcpRevision, defaults, rules,
        resetProviders: draft.resetProviders, removeRules: Object.keys(base.settings.mcpToolRules ?? {}).filter(key => !Object.hasOwn(draft.rules, key) && (base.settings.mcpToolRules?.[key]?.mode !== "disabled" || JSON.parse(key)[0] === "hosty:development")), skills: draft.skills }) });
      const loaded = await loadSettings(); setLatest(loaded); setBase(loaded); setDraft(initial(loaded)); setDirty(false); setReview(null);
      setStatus("Saved. Changes apply to subsequent tool calls."); await onRefresh();
    } catch (cause) {
      if (popup && !pending.current?.review) popup.close();
      // A definitive refusal/expiry cannot have applied this request. Unknown transport or
      // server failures retain the exact UUID so retry recovers the same operation.
      if (cause instanceof ApiError && [400, 401, 403, 404, 409, 410].includes(cause.status)) {
        pending.current = null; setReview(null);
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    finally { setBusy(false); }
  };
  const entries = [...base.providers, ...(catalogs.some(c => c.provider === "hosty:development") ? [{ appId: "hosty:development", displayName: "Development tools", running: true, url: null, offered: true }] : [])];
  const enabled = entries.filter(p => (draft.access[p.appId]?.enabled ?? p.offered) && catalogs.some(c => c.provider === p.appId));
  const allModes = enabled.flatMap(p => { const c = catalogs.find(c => c.provider === p.appId)!; return c.tools.filter(t => !draft.access[p.appId]?.denied.includes(t.name) && !locallyDisabled(c, t.name)).map(t => mode(c, t.name)); });
  return <FieldGroup>
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><h2 className="text-base font-semibold">MCP & tools</h2>
      <Popover><PopoverTrigger asChild><Button variant="ghost" size="icon" aria-label="About new tools"><Info /></Button></PopoverTrigger><PopoverContent>New tools from enabled applications become available automatically. Tools you explicitly disable remain disabled.</PopoverContent></Popover></div>
      <Button variant="outline" disabled={busy || loading} onClick={() => void refresh()}><RefreshCw data-icon="inline-start" />{loading ? "Loading…" : "Refresh tools"}</Button></div>
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {base.discovery !== "ok" && <Alert><AlertDescription>Core is unavailable. Existing access choices are unchanged.</AlertDescription></Alert>}
    <Field orientation="horizontal"><FieldLabel>All enabled applications</FieldLabel><ModeSelect label="Approval for all enabled applications" disabled={busy || loading || !enabled.length}
      value={new Set(allModes).size > 1 ? "mixed" : allModes[0] ?? "ask"} change={value => bulk(enabled.map(p => p.appId), value)} /></Field>
    <div className="flex flex-col divide-y rounded-lg border">{entries.map(provider => {
      const id = provider.appId, access = draft.access[id] ?? { enabled: true, denied: [] }, catalog = catalogs.find(c => c.provider === id);
      const tools = catalog?.tools ?? [], permitted = tools.filter(t => access.enabled && !access.denied.includes(t.name) && (!catalog || !locallyDisabled(catalog, t.name)));
      const modes = catalog ? permitted.map(t => mode(catalog, t.name)) : [];
      const instruction = base.instructions?.find(i => i.appId === id), accepted = draft.skills[id];
      return <Collapsible key={id} className="p-4"><div className="flex flex-wrap items-center gap-3">
        {id !== "hosty:development" && <Checkbox aria-label={`Allow ${provider.displayName}`} disabled={busy || loading} checked={access.enabled && access.denied.length ? "indeterminate" : access.enabled}
          onCheckedChange={checked => change({ ...draft, access: { ...draft.access, [id]: { enabled: checked === true,
            denied: checked === true ? access.denied.filter(name => !tools.some(t => t.name === name)) : access.denied } } })} />}
        <CollapsibleTrigger asChild><Button variant="ghost" className="min-w-0 flex-1 justify-start"><ChevronDown data-icon="inline-start" /><span className="truncate">{provider.displayName}</span><span className="ml-auto">{catalog ? `${permitted.length}/${tools.length}` : "—"}</span></Button></CollapsibleTrigger>
        <ModeSelect label={`Approval for ${provider.displayName}`} disabled={busy || loading || !access.enabled || !catalog}
          value={new Set(modes).size > 1 ? "mixed" : modes[0] ?? draft.defaults[id]?.mode ?? "ask"} change={value => bulk([id], value)} />
      </div><CollapsibleContent className="pt-4"><FieldSet disabled={busy || loading}><FieldLegend className="sr-only">{provider.displayName} tools</FieldLegend><FieldGroup>
        {!catalog && <p className="text-sm text-muted-foreground">{provider.running ? "Refresh tools to load this application’s catalog." : "Start this application to preview its tools."}</p>}
        {catalog && tools.map(tool => <Field key={tool.name} orientation="responsive"><div className="flex min-w-0 flex-1 items-start gap-3">
          <Checkbox id={`tool-${id}-${tool.name}`} disabled={!access.enabled} checked={access.enabled && !access.denied.includes(tool.name) && !locallyDisabled(catalog, tool.name)}
            onCheckedChange={checked => {
              if (id === "hosty:development") {
                const rules = { ...draft.rules }, key = keyOf(id, tool.name);
                if (checked === true) delete rules[key]; else rules[key] = { identity: catalog.identity, mode: "disabled" };
                change({ ...draft, rules });
              } else change({ ...draft, access: { ...draft.access, [id]: { ...access, denied: checked === true ? access.denied.filter(t => t !== tool.name) : [...new Set([...access.denied, tool.name])] } } });
            }} />
          <div className="min-w-0"><FieldLabel htmlFor={`tool-${id}-${tool.name}`}>{tool.name}</FieldLabel><p className="text-sm text-muted-foreground">{tool.description}</p></div></div>
          <ModeSelect label={`Approval for ${tool.name}`} disabled={!access.enabled || access.denied.includes(tool.name) || locallyDisabled(catalog, tool.name)} value={mode(catalog, tool.name)} change={value => { const rules = { ...draft.rules }; const key = keyOf(id, tool.name); if (value === (draft.defaults[id]?.mode ?? "ask")) delete rules[key]; else rules[key] = { identity: catalog.identity, mode: value }; change({ ...draft, rules }); }} /></Field>)}
        {instruction?.markdown && <Field><FieldLabel>Application instructions</FieldLabel><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border p-3 text-sm">{instruction.markdown}</pre>
          <Field orientation="horizontal"><Checkbox id={`instructions-${id}`} checked={accepted?.identity === instruction.identity && accepted.digest === instruction.digest}
            onCheckedChange={checked => { const skills = { ...draft.skills }; if (checked === true && instruction.digest) skills[id] = { identity: instruction.identity, digest: instruction.digest }; else delete skills[id]; change({ ...draft, skills }); }} />
            <FieldLabel htmlFor={`instructions-${id}`}>Use these instructions</FieldLabel></Field></Field>}
      </FieldGroup></FieldSet></CollapsibleContent></Collapsible>;
    })}</div>
    <div className="flex flex-wrap items-center justify-end gap-3"><p role="status" className="mr-auto text-sm text-muted-foreground">{status || (dirty ? "Unsaved changes" : "")}</p>
      {review && <Button variant="outline" asChild><a href={review.approvalUrl} target="_blank" rel="noopener noreferrer">Open Core confirmation</a></Button>}
      <Button variant="outline" disabled={busy || loading || !dirty} onClick={() => { setBase(latest); setDraft(initial(latest)); setDirty(false); pending.current = null; setReview(null); setError(""); }}>Discard</Button>
      <Button disabled={busy || loading || !dirty || base.discovery !== "ok"} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</Button></div>
  </FieldGroup>;
}
