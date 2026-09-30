"use client";
import { useEffect, useImperativeHandle, useRef, useState, type Ref, type RefObject } from "react";
import { Blocks, Plus, Loader2, X, CircleAlert } from "lucide-react";
import { Tooltip, Popover as PopoverPrimitive } from "radix-ui";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger, PopoverHeader, PopoverTitle, PopoverDescription } from "@/components/ui/popover";
import { AppContextIcons } from "@/components/app-context-icons";
import { ContextAppIcon } from "@/components/context-app-icon";
import { Button } from "@/components/ui/button";
import { AssistantApiError, getSession, listContextApps, selectedContextApps, setSessionApps, type AssistantSession, type ContextApp } from "@/lib/assistant-api";

export type AppContextPickerHandle = { open: () => void };

export function AppContextPicker({ session, busy, running, onChange, onBusyChange, ref, opener, compact = false, side = "top" }: {
  ref?: Ref<AppContextPickerHandle>; opener?: RefObject<HTMLButtonElement | null>; compact?: boolean; side?: "top" | "bottom";
  session: AssistantSession; busy: boolean; running: boolean; onChange: (session: AssistantSession) => void; onBusyChange?: (busy: boolean) => void;
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
  const busyListener = useRef(onBusyChange);
  const ids = session.appIds ?? [];
  useEffect(() => {
    busyListener.current = onBusyChange;
    onBusyChange?.(saving);
  }, [saving, onBusyChange]);
  useEffect(() => () => busyListener.current?.(false), []);
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

  const changeOpen = (nextOpen: boolean) => {
    if (saving || (nextOpen && busy)) return;
    if (nextOpen) { setSelected(ids); setRevision(session.appContextRevision ?? 0); setSearch(""); }
    setOpen(nextOpen);
  };
  useImperativeHandle(ref, () => ({ open: () => changeOpen(true) }));
  const close = () => { setOpen(false); (ids.length || !compact ? trigger : opener)?.current?.focus(); };
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
  return <div className="min-w-0 max-w-full text-xs" data-slot="session-app-context">
    <div className="flex items-center" role="group" aria-label="Session app context">
      <Popover open={open} onOpenChange={changeOpen}>
        <PopoverPrimitive.Anchor asChild><span className="inline-block" /></PopoverPrimitive.Anchor>
        <Tooltip.Provider delayDuration={300}>
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <PopoverTrigger asChild>
                <Button type="button" ref={trigger} variant="ghost" size="sm" className={compact && !ids.length ? "hidden" : "gap-1 rounded-full px-1"}
                  disabled={busy || saving} aria-label="Select app context">
                  {ids.length ? <AppContextIcons ids={ids} apps={Object.values(labels)} /> : <span className="inline-flex size-8 items-center justify-center" aria-hidden="true"><Blocks /></span>}
                  {(error || rosterError || labelsUnavailable) && <CircleAlert className="size-3 text-destructive" aria-label="App context needs attention" />}
                  {!compact && <span className="inline-flex size-7 items-center justify-center rounded-full border border-border" aria-hidden="true"><Plus /></span>}
                  <span className="sr-only">{ids.length ? `${ids.length} ${ids.length === 1 ? "app" : "apps"} selected` : "General context"}</span>
                </Button>
              </PopoverTrigger>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content side={side} sideOffset={6} className="max-w-72 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
                {ids.length ? ids.map(id => <p key={id}>{labels[id]?.displayName ?? id}{labels[id]?.available === false ? " · Unavailable" : ""}</p>) : "General context · Add apps"}
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        </Tooltip.Provider>
        <PopoverContent side={side} align="start" sideOffset={8} collisionPadding={12} onCloseAutoFocus={event => { if (compact && !ids.length) { event.preventDefault(); opener?.current?.focus(); } }} aria-label="Select apps for this session"
          className="flex max-h-[var(--radix-popover-content-available-height)] w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-3 p-3">
          <PopoverHeader>
            <PopoverTitle>App context</PopoverTitle>
            <PopoverDescription>{selected.length}/16 selected</PopoverDescription>
            {running && <p className="text-xs text-muted-foreground">Applies to your next message</p>}
          </PopoverHeader>
          {selected.length > 0 && <div className="flex max-h-28 shrink-0 flex-wrap gap-1 overflow-y-auto" aria-label="Selected apps">
            {selected.map(id => <Badge key={id} variant="outline" className="max-w-full gap-1.5 py-1">
              <ContextAppIcon app={labels[id] ?? apps.find(app => app.id === id)} className="size-4" />
              <span className="truncate">{labels[id]?.displayName ?? apps.find(app => app.id === id)?.displayName ?? id}{labels[id]?.available === false ? " · Unavailable" : ""}</span>
              <button type="button" className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
                disabled={saving} aria-label={`Remove ${labels[id]?.displayName ?? apps.find(app => app.id === id)?.displayName ?? id} from context`}
                onClick={() => setSelected(current => current.filter(value => value !== id))}><X className="size-3" /></button>
            </Badge>)}
          </div>}
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
          {next !== null && <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => {
            const current = generation.current; setLoading(true);
            void listContextApps(search, next).then(page => { if (generation.current === current) { setApps(previous => [...previous, ...page.apps]); setNext(page.nextOffset); } })
              .catch(cause => { if (generation.current === current) setRosterError(String(cause.message ?? cause)); }).finally(() => { if (generation.current === current) setLoading(false); });
          }}>Load more</Button>}
          {(error || rosterError || labelsUnavailable) && <div className="flex items-center gap-2"><p role="alert" className="text-xs text-destructive">{error ?? rosterError ?? "App context is unavailable."}</p><Button type="button" variant="ghost" size="sm" onClick={() => { setError(null); setRetry(value => value + 1); }}>Retry</Button></div>}
          <div className="flex shrink-0 justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={close}>Cancel</Button>
            <Button type="button" size="sm" disabled={saving || busy} onClick={() => void save(selected, revision)}>{saving ? "Applying…" : "Apply"}</Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
    {!compact && !open && (error || rosterError || labelsUnavailable) && <div className="mt-2 flex items-center gap-2"><p role="alert" className="text-destructive">{error ?? rosterError ?? "App context is unavailable."}</p><Button type="button" variant="ghost" size="sm" onClick={() => { setError(null); setRetry(value => value + 1); }}>Retry</Button></div>}
  </div>;
}
