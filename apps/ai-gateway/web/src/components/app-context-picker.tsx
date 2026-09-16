"use client";
import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger, PopoverHeader, PopoverTitle, PopoverDescription } from "@/components/ui/popover";
import { ContextAppIcon } from "@/components/context-app-icon";
import { Button } from "@/components/ui/button";
import { AssistantApiError, getSession, listContextApps, selectedContextApps, setSessionApps, type AssistantSession, type ContextApp } from "@/lib/assistant-api";

export function AppContextPicker({ session, busy, running, onChange }: {
  session: AssistantSession; busy: boolean; running: boolean; onChange: (session: AssistantSession) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState("");
  const [apps, setApps] = useState<ContextApp[]>([]);
  const [labels, setLabels] = useState<Record<string, ContextApp>>({});
  const [next, setNext] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);
  const [labelsUnavailable, setLabelsUnavailable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const generation = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const ids = session.appIds ?? [];
  useEffect(() => {
    const current = ++generation.current;
    let cancelled = false;
    // Label resolution is independent of the searchable page and never treats an outage as uninstall.
    void selectedContextApps(session.appIds ?? []).then(found => {
      if (!cancelled) { setLabels(Object.fromEntries(found.map(app => [app.id, app]))); setLabelsUnavailable(false); }
    }).catch(() => { if (!cancelled) { setLabels({}); setLabelsUnavailable(true); } });
    if (open) {
      setLoading(true);
      const timer = setTimeout(() => {
        void listContextApps(search).then(page => {
          if (cancelled || generation.current !== current) return;
          setApps(page.apps); setNext(page.nextOffset); setRosterError(null);
        }).catch(cause => { if (!cancelled) setRosterError(String(cause.message ?? cause)); })
          .finally(() => { if (!cancelled) setLoading(false); });
      }, 150);
      return () => { cancelled = true; clearTimeout(timer); };
    }
    return () => { cancelled = true; };
  }, [open, search, session.appIds, retry]);

  const close = () => { setOpen(false); trigger.current?.focus(); };
  const save = async (appIds: string[], expectedRevision: number) => {
    if (saving || busy) return;
    setSaving(true); setError(null);
    try { onChange(await setSessionApps(session.id, appIds, expectedRevision)); close(); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      if (cause instanceof AssistantApiError && cause.code === "app_context_conflict") {
        const current = await getSession(session.id).catch(() => null);
        if (current) { onChange(current); setSelected(current.appIds ?? []); setRevision(current.appContextRevision ?? 0); }
      }
    } finally { setSaving(false); }
  };
  return <div className="shrink-0 border-t px-3 py-2 text-xs">
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Session app context">
      {ids.map(id => <Badge key={id} variant="outline" className="max-w-full gap-1.5 py-1" title={id}>
        <ContextAppIcon app={labels[id]} className="size-4" />
        <span className="truncate">{labels[id]?.displayName ?? id}{labels[id]?.available === false ? " · Unavailable" : ""}</span>
        <button type="button" className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50" disabled={busy || saving} aria-label={`Remove ${id} from context`} onClick={() => void save(ids.filter(value => value !== id), session.appContextRevision ?? 0)}><X className="size-3" /></button>
      </Badge>)}
      {!ids.length && <span className="text-muted-foreground">General context</span>}
      <Popover open={open} onOpenChange={nextOpen => {
        if (saving) return;
        if (nextOpen) {
          setSelected(ids); setRevision(session.appContextRevision ?? 0); setSearch("");
        }
        setOpen(nextOpen);
      }}>
        <PopoverTrigger asChild>
          <Button ref={trigger} variant="ghost" size="icon-sm" disabled={busy || saving} aria-label="Add apps to context" title="Add apps to context"><Plus /></Button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" sideOffset={8} collisionPadding={12} aria-label="Select apps for this session"
          className="flex max-h-[var(--radix-popover-content-available-height)] w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-3 p-3">
          <PopoverHeader>
            <PopoverTitle>App context</PopoverTitle>
            <PopoverDescription>{selected.length}/16 selected</PopoverDescription>
          </PopoverHeader>
          <Input aria-label="Search apps" placeholder="Search installed apps…" value={search} onChange={event => setSearch(event.target.value)} />
          <fieldset className="flex min-h-0 flex-col gap-1 overflow-y-auto" style={{ maxHeight: "18rem" }}>
            <legend className="sr-only">Installed apps</legend>
            {loading ? <div role="status" className="flex items-center gap-2 p-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading apps…</div> : apps.map(app => <label key={app.id} className="flex cursor-pointer items-center gap-3 rounded-md p-2 hover:bg-muted">
              <Checkbox checked={selected.includes(app.id)} disabled={saving || (!selected.includes(app.id) && selected.length >= 16)} onCheckedChange={checked => setSelected(current => checked === true ? [...current, app.id] : current.filter(id => id !== app.id))} />
              <ContextAppIcon app={app} className="size-7" />
              <span className="min-w-0 text-sm"><span className="block truncate font-medium">{app.displayName}</span><span className="block break-all text-xs text-muted-foreground">{app.id} · {app.runtimeState ?? "Unknown"}</span></span>
            </label>)}
            {!loading && !rosterError && apps.length === 0 && <p className="p-2 text-sm text-muted-foreground">No matching apps</p>}
          </fieldset>
          {next !== null && <Button variant="ghost" size="sm" disabled={loading} onClick={() => {
            const current = generation.current; setLoading(true);
            void listContextApps(search, next).then(page => { if (generation.current === current) { setApps(previous => [...previous, ...page.apps]); setNext(page.nextOffset); } })
              .catch(cause => { if (generation.current === current) setRosterError(String(cause.message ?? cause)); }).finally(() => { if (generation.current === current) setLoading(false); });
          }}>Load more</Button>}
          {(error || rosterError) && <p role="alert" className="text-xs text-destructive">{error ?? rosterError}</p>}
          <div className="flex shrink-0 justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={saving} onClick={close}>Cancel</Button>
            <Button size="sm" disabled={saving || busy} onClick={() => void save(selected, revision)}>{saving ? "Applying…" : "Apply"}</Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
    {running && <p className="mt-1 text-muted-foreground">Applies to your next message</p>}
    {(error || rosterError || labelsUnavailable) && <div className="mt-2 flex items-center gap-2"><p role="alert" className="text-destructive">{error ?? rosterError ?? "App context is unavailable."}</p><Button variant="ghost" size="sm" onClick={() => { setError(null); setRetry(value => value + 1); }}>Retry</Button></div>}
  </div>;
}
