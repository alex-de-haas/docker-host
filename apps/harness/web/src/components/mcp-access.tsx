"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Info, RefreshCw } from "lucide-react";
import { HostyLoader } from "../../../../../shared/web/hosty-states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError, call, loadSettings, type Settings, type SettingsResponse, type ToolCatalog, type ToolRule } from "@/lib/api";

import { mcpGroups } from "@/lib/mcp-groups";

type Mode = "ask" | "run";
type Access = { enabled: boolean; denied: string[] };
type Draft = { access: Record<string, Access>; defaults: NonNullable<Settings["mcpDefaults"]>; rules: Record<string, ToolRule>;
  resetProviders: string[] };
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
    resetProviders: [] };
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
    rules: merge(previous.rules, draft.rules, next.rules), resetProviders: draft.resetProviders };
}
// Never attach a fresh concurrency token to an edit of the same field in another client.
function hasDraftConflict(previous: Draft, draft: Draft, next: Draft): boolean {
  function overlap<T>(before: Record<string, T>, edited: Record<string, T>, fresh: Record<string, T>) {
    return [...new Set([...Object.keys(before), ...Object.keys(edited)])].some(key =>
      !equal(before[key], edited[key]) && !equal(before[key], fresh[key]));
  }
  if (overlap(previous.access, draft.access, next.access) || overlap(previous.defaults, draft.defaults, next.defaults) ||
    overlap(previous.rules, draft.rules, next.rules)) return true;
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
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [error, setError] = useState(""), [status, setStatus] = useState(""), [review, setReview] = useState<Review | null>(null);
  const pending = useRef<{ input: unknown; review?: Review } | null>(null);
  const mounted = useRef(true);
  const currentDraft = useRef({ base, draft, dirty });
  useLayoutEffect(() => { currentDraft.current = { base, draft, dirty }; }, [base, draft, dirty]);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    const abort = new AbortController();
    // Catalogs are loaded on entry, not polled. Discovery never replaces the access draft.
    void call("/settings/tools", { signal: abort.signal }).then(response => response.json()).then((result: { catalogs: ToolCatalog[]; unavailable?: string[]; settings?: Settings; mcpRevision?: string }) => {
      if (!active) return;
      setCatalogs(result.catalogs);
      // Discovery can atomically migrate policy. Use its resulting revision while keeping any
      // edits made during the request; an obsolete revision must not make the first save fail.
      if (result.settings && result.mcpRevision) {
        const current = currentDraft.current;
        const loaded = { ...current.base, settings: result.settings, mcpRevision: result.mcpRevision, toolCatalogs: result.catalogs };
        setLatest(loaded);
        if (current.dirty && hasDraftConflict(initial(current.base), current.draft, initial(loaded)))
          setError("Tool policy changed during discovery. Your draft is preserved. Discard it to load current values.");
        else {
          setBase(loaded);
          setDraft(current.dirty ? rebaseDraft(initial(current.base), current.draft, initial(loaded)) : initial(loaded));
        }
      }
      if (result.unavailable?.length) setError(`Could not load tools for ${result.unavailable.join(", ")}. Existing choices are preserved.`);
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; mounted.current = false; abort.abort(); };
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
  const sectionMode = (catalog: ToolCatalog, tools: ToolCatalog["tools"], value: Mode) => {
    const rules = { ...draft.rules };
    // A feature is a presentation subset of one provider. Never reset its provider default,
    // unavailable tools, disabled entries or the exceptions belonging to a different feature.
    for (const tool of tools) {
      if (draft.access[catalog.provider]?.denied.includes(tool.name) || locallyDisabled(catalog, tool.name)) continue;
      rules[keyOf(catalog.provider, tool.name)] = { identity: catalog.identity, mode: value };
    }
    change({ ...draft, rules });
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
        resetProviders: draft.resetProviders, removeRules: Object.keys(base.settings.mcpToolRules ?? {}).filter(key => !Object.hasOwn(draft.rules, key) && (base.settings.mcpToolRules?.[key]?.mode !== "disabled" || JSON.parse(key)[0] === "hosty:development")) }) });
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
  const entries = [...base.providers, ...(catalogs.some(c => c.provider === "hosty:development") ? [{ appId: "hosty:development", displayName: catalogs.find(c => c.provider === "hosty:development")?.localOwner?.displayName ?? "Harness private tools", running: true, url: null, offered: true }] : [])];
  const groups = mcpGroups(entries, catalogs);
  const coreAccess = draft.access["hosty:core"];
  const enabled = entries.filter(p => (draft.access[p.appId]?.enabled ?? p.offered) && catalogs.some(c => c.provider === p.appId));
  const allModes = enabled.flatMap(p => { const c = catalogs.find(c => c.provider === p.appId)!; return c.tools.filter(t => !draft.access[p.appId]?.denied.includes(t.name) && !locallyDisabled(c, t.name)).map(t => mode(c, t.name)); });
  return <FieldGroup>
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><h2 className="text-lg font-semibold tracking-[-0.01em]">MCP & tools</h2>
      <Popover><PopoverTrigger asChild><Button variant="ghost" size="icon" aria-label="About new tools"><Info /></Button></PopoverTrigger><PopoverContent>New Core tools require approval. Tools you explicitly disable remain disabled. Application access follows your Core settings.</PopoverContent></Popover></div>
      <Button variant="outline" disabled={busy || loading} onClick={() => void refresh()}><RefreshCw data-icon="inline-start" />{loading ? "Loading…" : "Refresh tools"}</Button></div>
    {loading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><HostyLoader label={null} className="size-4" />Loading tools…</p>}
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {base.discovery !== "ok" && <Alert><AlertDescription>Core is unavailable. Existing access choices are unchanged.</AlertDescription></Alert>}
    <Field orientation="horizontal"><FieldLabel>All enabled tools</FieldLabel><ModeSelect label="Approval for all enabled tools" disabled={busy || loading || !enabled.length}
      value={new Set(allModes).size > 1 ? "mixed" : allModes[0] ?? "ask"} change={value => bulk(enabled.map(p => p.appId), value)} /></Field>
    {groups.map(group => <section key={group.title} aria-label={group.title} className="flex flex-col gap-3">
      <div className="flex items-center gap-3"><h3 className="text-sm font-semibold">{group.title}</h3>
        {group.title === "Hosty tools" && coreAccess && <Checkbox aria-label="Allow Hosty tools" disabled={busy || loading}
          checked={coreAccess.enabled} onCheckedChange={checked => change({ ...draft, access: { ...draft.access,
            "hosty:core": { ...coreAccess, enabled: checked === true } } })} />}</div>
      {!group.rows.length && <p className="text-sm text-muted-foreground">{group.title === "Hosty tools" ? "No Hosty tools are currently available." : "No application tools are currently available."}</p>}
      {!!group.rows.length && <div className="flex flex-col divide-y rounded-lg border">{group.rows.map(row => {
      const { provider, catalog, tools } = row;
      const id = provider.appId, access = draft.access[id] ?? { enabled: true, denied: [] };
      const permitted = tools.filter(t => access.enabled && !access.denied.includes(t.name) && (!catalog || !locallyDisabled(catalog, t.name)));
      const modes = catalog ? permitted.map(t => mode(catalog, t.name)) : [];

      return <Collapsible key={row.id} className="p-4"><div className="flex flex-wrap items-center gap-3">
        {id !== "hosty:development" && <Checkbox aria-label={`Allow ${row.title}`} disabled={busy || loading || row.feature && (!access.enabled || !catalog)}
          checked={row.feature ? permitted.length > 0 && permitted.length < tools.length ? "indeterminate" : permitted.length > 0 : access.enabled && access.denied.length ? "indeterminate" : access.enabled}
          onCheckedChange={checked => change({ ...draft, access: { ...draft.access, [id]: row.feature ? { ...access,
            denied: checked === true ? access.denied.filter(name => !tools.some(t => t.name === name)) : [...new Set([...access.denied, ...tools.map(t => t.name)])] } : { enabled: checked === true,
            denied: checked === true ? access.denied.filter(name => !tools.some(t => t.name === name)) : access.denied } } })} />}
        <CollapsibleTrigger asChild><Button variant="ghost" className="min-w-0 flex-1 justify-start"><ChevronDown data-icon="inline-start" /><span className="truncate">{row.title}</span><span className="ml-auto">{catalog ? `${permitted.length}/${tools.length}` : "—"}</span></Button></CollapsibleTrigger>
        <ModeSelect label={`Approval for ${row.title}`} disabled={busy || loading || !access.enabled || !catalog || !permitted.length}
          value={new Set(modes).size > 1 ? "mixed" : modes[0] ?? draft.defaults[id]?.mode ?? "ask"} change={value => row.feature && catalog ? sectionMode(catalog, tools, value) : bulk([id], value)} />
      </div><CollapsibleContent className="pt-4"><FieldSet disabled={busy || loading}><FieldLegend className="sr-only">{row.title} tools</FieldLegend><FieldGroup>
        {!catalog && !loading && <p className="text-sm text-muted-foreground">{provider.running ? "Refresh tools to load the unavailable catalog. Saved choices are preserved." : "Start this application to preview its tools. Saved choices are preserved."}</p>}
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

      </FieldGroup></FieldSet></CollapsibleContent></Collapsible>;
    })}</div>}</section>)}
    <div className="flex flex-wrap items-center justify-end gap-3"><p role="status" className="mr-auto text-sm text-muted-foreground">{status || (dirty ? "Unsaved changes" : "")}</p>
      {review && <Button variant="outline" asChild><a href={review.approvalUrl} target="_blank" rel="noopener noreferrer">Open Core confirmation</a></Button>}
      <Button variant="outline" disabled={busy || loading || !dirty} onClick={() => { setBase(latest); setDraft(initial(latest)); setDirty(false); pending.current = null; setReview(null); setError(""); }}>Discard</Button>
      <Button disabled={busy || loading || !dirty || base.discovery !== "ok"} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</Button></div>
  </FieldGroup>;
}
