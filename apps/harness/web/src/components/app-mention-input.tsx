"use client";

import { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type ComponentProps, type Ref, type RefObject } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { InputGroupTextarea } from "@/components/ui/input-group";
import { Button } from "@/components/ui/button";
import { ContextAppIcon } from "@/components/context-app-icon";
import { cn } from "@/lib/utils";
import { AssistantApiError, getSession, listContextApps, setSessionApps, type AssistantSession, type ContextApp } from "@/lib/assistant-api";
import { editMentionDraft, insertMention, mentionQuery, readMentionDraft, writeMentionDraft, serializeMentions, type MentionDraft } from "@/lib/app-mentions";

export type AppMentionInputHandle = { serialize: () => string };

type Props = Omit<ComponentProps<"textarea">, "value" | "onChange" | "ref"> & {
  ref?: Ref<AppMentionInputHandle>;
  value: string; onChange: (text: string) => void; session: AssistantSession | null;
  inputRef: RefObject<HTMLTextAreaElement | null>; contextBusy: boolean;
  onContextChange: (session: AssistantSession) => void; onBusyChange: (busy: boolean) => void;
};

/** Native text editing keeps IME, selection and mixed clipboard input intact; a mirror highlights known mentions. */
export function AppMentionInput({ ref, value, onChange, session, inputRef, contextBusy, onContextChange, onBusyChange,
  onKeyDown, onSelect, onFocus, onBlur, onCompositionStart, onCompositionEnd, disabled, className, ...props }: Props) {
  const [draft, setDraft] = useState<MentionDraft>(() => readMentionDraft(session?.id ?? "", value));
  const current = draft.text === value ? draft : editMentionDraft(draft, value);
  if (draft.text !== value) setDraft(current);
  useImperativeHandle(ref, () => ({ serialize: () => serializeMentions(current) }));
  const history = useRef<MentionDraft[]>([current]);
  const historyIndex = useRef(0);
  const [caret, setCaret] = useState({ start: 0, end: 0 });
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [results, setResults] = useState<{ key: string; apps: ContextApp[]; next: number | null }>({ key: "", apps: [], next: null });
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const pending = useRef(false);
  const mounted = useRef(true);
  const latest = useRef({ value, session, onChange, onContextChange, onBusyChange });
  useLayoutEffect(() => { latest.current = { value, session, onChange, onContextChange, onBusyChange }; });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; latest.current.onBusyChange(false); }; }, []);
  useEffect(() => { if (session) writeMentionDraft(session.id, current); }, [current, session]);
  const wrapper = useRef<HTMLDivElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const suggestions = useRef<HTMLDivElement>(null);
  const listId = useId();
  const query = focused && !composing && !disabled ? mentionQuery(value, caret.start, caret.end, current.mentions) : null;
  const key = query ? `${query.start}:${query.end}:${query.search}` : "";
  const open = !!session && !!query && dismissed !== key;
  const search = open ? query!.search : null;
  const apps = results.key === key ? results.apps : [];
  const next = results.key === key ? results.next : null;
  const waiting = loading || (open && results.key !== key && !error);
  const limit = (session?.appIds?.length ?? 0) >= 16;
  const blocked = (app: ContextApp) => limit && !session?.appIds?.includes(app.id);

  useEffect(() => {
    const request = ++generation.current;
    if (search === null) return;
    const timer = setTimeout(() => {
      setLoading(true); setError(null); setActive(0);
      void listContextApps(search).then(page => {
        if (generation.current === request) setResults({ key, apps: page.apps, next: page.nextOffset });
      }).catch(cause => { if (generation.current === request) setError(cause instanceof Error ? cause.message : String(cause)); })
        .finally(() => { if (generation.current === request) setLoading(false); });
    }, 150);
    return () => { clearTimeout(timer); generation.current = request + 1; };
  }, [search, key, retry]);
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, listId, open]);
  useLayoutEffect(() => {
    const textarea = inputRef.current;
    const layer = mirror.current;
    if (!textarea || !layer) return;
    const sync = () => { layer.style.width = `${textarea.clientWidth}px`; layer.scrollTop = textarea.scrollTop; };
    sync();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync); observer?.observe(textarea);
    textarea.addEventListener("scroll", sync);
    return () => { observer?.disconnect(); textarea.removeEventListener("scroll", sync); };
  }, [inputRef]);

  const record = (nextDraft: MentionDraft) => {
    // External insertions (dictation/handoff) participate in the same undo history.
    if (history.current[historyIndex.current].text !== current.text) {
      history.current = history.current.slice(0, historyIndex.current + 1);
      history.current.push(current); historyIndex.current++;
    }
    history.current = [...history.current.slice(0, historyIndex.current + 1), nextDraft].slice(-100);
    historyIndex.current = history.current.length - 1;
    setDraft(nextDraft); onChange(nextDraft.text);
  };
  const undo = (redo: boolean) => {
    if (!redo && history.current[historyIndex.current].text !== current.text) {
      history.current = [...history.current.slice(0, historyIndex.current + 1), current].slice(-100);
      historyIndex.current = history.current.length - 1;
    }
    const index = historyIndex.current + (redo ? 1 : -1);
    if (index < 0 || index >= history.current.length) return;
    historyIndex.current = index;
    const restored = history.current[index]; setDraft(restored); onChange(restored.text); setDismissed(key);
  };
  const undoHandler = useRef(undo);
  useLayoutEffect(() => { undoHandler.current = undo; });
  useEffect(() => {
    const textarea = inputRef.current;
    const handle = (event: InputEvent) => {
      if (!pending.current && (event.inputType === "historyUndo" || event.inputType === "historyRedo")) {
        event.preventDefault(); undoHandler.current(event.inputType === "historyRedo");
      }
    };
    textarea?.addEventListener("beforeinput", handle);
    return () => textarea?.removeEventListener("beforeinput", handle);
  }, [inputRef]);
  const choose = async (app: ContextApp) => {
    if (!query || !session || pending.current || contextBusy || blocked(app)) return;
    const original = value, selectedQuery = query;
    const selectedDraft = current;
    const sessionId = session.id;
    pending.current = true; setSaving(true); onBusyChange(true); setError(null);
    try {
      if (!session.appIds?.includes(app.id)) {
        const updated = await setSessionApps(sessionId, [...(session.appIds ?? []), app.id], session.appContextRevision ?? 0);
        if (!mounted.current || latest.current.session?.id !== sessionId) return;
        latest.current.onContextChange(updated);
      }
      if (!mounted.current || latest.current.value !== original || latest.current.session?.id !== sessionId) return;
      const updated = insertMention(selectedDraft, selectedQuery, app);
      record(updated); setDismissed(key);
      const position = selectedQuery.start + updated.text.length - original.length + selectedQuery.end - selectedQuery.start;
      requestAnimationFrame(() => {
        if (!mounted.current || latest.current.session?.id !== sessionId) return;
        inputRef.current?.focus(); inputRef.current?.setSelectionRange(position, position);
        setCaret({ start: position, end: position });
      });
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      if (cause instanceof AssistantApiError && cause.code === "app_context_conflict") {
        const updated = await getSession(sessionId).catch(() => null);
        if (mounted.current && updated && latest.current.session?.id === sessionId) latest.current.onContextChange(updated);
      }
    } finally {
      pending.current = false;
      if (mounted.current) { setSaving(false); latest.current.onBusyChange(false); }
    }
  };
  let position = 0;
  const highlights = current.mentions.flatMap(mention => {
    const before = value.slice(position, mention.start); position = mention.end;
    const included = session?.appIds?.includes(mention.id);
    return [before, <mark key={`${mention.start}:${mention.id}`} className={cn("rounded-sm bg-accent text-transparent", !included && "underline decoration-destructive decoration-dotted")}>
      {mention.label}
    </mark>];
  });
  const outside = current.mentions.filter(mention => !session?.appIds?.includes(mention.id));
  return <Popover open={open} onOpenChange={nextOpen => { if (!nextOpen) setDismissed(key); }}>
    <PopoverPrimitive.Anchor asChild>
      <div ref={wrapper} className="relative w-full min-w-0">
        <div ref={mirror} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-3 py-3 text-base text-transparent md:text-sm">
          {highlights}{value.slice(position)}{"\n"}
        </div>
        <InputGroupTextarea {...props} ref={inputRef} value={value} disabled={disabled} readOnly={saving || props.readOnly} aria-busy={saving}
          className={cn("relative max-h-48 min-h-20 w-full px-3", className)}
          aria-autocomplete="list" aria-controls={open ? listId : undefined} aria-expanded={open}
          aria-activedescendant={open && apps[active] ? `${listId}-${active}` : undefined}
          aria-describedby={outside.length ? `${listId}-outside` : undefined}
          onCopy={event => {
            props.onCopy?.(event);
            if (event.defaultPrevented) return;
            const { selectionStart: start, selectionEnd: end } = event.currentTarget;
            if (!current.mentions.some(m => m.start >= start && m.end <= end)) return;
            event.clipboardData.setData("text/plain", serializeMentions(current, start, end)); event.preventDefault();
          }}
          onCut={event => {
            props.onCut?.(event);
            if (event.defaultPrevented || saving) return;
            const { selectionStart: start, selectionEnd: end } = event.currentTarget;
            if (!current.mentions.some(m => m.start >= start && m.end <= end)) return;
            event.clipboardData.setData("text/plain", serializeMentions(current, start, end)); event.preventDefault();
            record(editMentionDraft(current, value.slice(0, start) + value.slice(end)));
            requestAnimationFrame(() => { if (mounted.current) inputRef.current?.setSelectionRange(start, start); });
          }}
          onChange={event => { record(editMentionDraft(current, event.target.value)); setCaret({ start: event.target.selectionStart, end: event.target.selectionEnd }); setDismissed(null); }}
          onSelect={event => { setCaret({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd }); onSelect?.(event); }}
          onFocus={event => { setFocused(true); onFocus?.(event); }}
          onBlur={event => {
            if (!pending.current && !suggestions.current?.contains(event.relatedTarget as Node)) setFocused(false);
            onBlur?.(event);
          }}
          onCompositionStart={event => { setComposing(true); onCompositionStart?.(event); }}
          onCompositionEnd={event => { setComposing(false); onCompositionEnd?.(event); }}
          onKeyDown={event => {
            if (saving || event.nativeEvent.isComposing || event.keyCode === 229) return;
            if ((event.metaKey || event.ctrlKey) && ["z", "y"].includes(event.key.toLowerCase())) {
              event.preventDefault(); undo(event.shiftKey || event.key.toLowerCase() === "y"); return;
            }
            if (open) {
              if (event.key === "Escape") { event.preventDefault(); setDismissed(key); return; }
              if (["ArrowDown", "ArrowUp"].includes(event.key)) {
                event.preventDefault(); setActive(index => apps.length ? (index + (event.key === "ArrowDown" ? 1 : apps.length - 1)) % apps.length : 0); return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault(); if (apps[active]) void choose(apps[active]); return;
              }
            }
            onKeyDown?.(event);
          }} />
        {outside.length > 0 && <p id={`${listId}-outside`} className="px-3 pb-1 text-xs text-muted-foreground">Mention outside current app context: {[...new Set(outside.map(m => m.id))].join(", ")}</p>}
      </div>
    </PopoverPrimitive.Anchor>
    <PopoverContent ref={suggestions} aria-label="Mention an app" side="top" align="start" sideOffset={8} collisionPadding={12} className="w-[min(22rem,calc(100vw-1.5rem))] p-2"
      onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}
      onInteractOutside={event => { if (wrapper.current?.contains(event.target as Node)) event.preventDefault(); }}>
      <p className="px-2 pb-2 text-sm font-medium">Mention an app</p>
      <div id={listId} role="listbox" aria-label="Apps to mention" aria-busy={waiting || saving} className="max-h-60 overflow-y-auto">
        {apps.map((app, index) => <button key={app.id} id={`${listId}-${index}`} type="button" role="option" tabIndex={-1}
          aria-selected={index === active} aria-disabled={saving || contextBusy || blocked(app)}
          className={cn("flex w-full items-center gap-2 rounded-md p-2 text-left aria-disabled:opacity-50", index === active && "bg-accent")}
          onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => void choose(app)}>
          <ContextAppIcon app={app} /><span className="min-w-0"><span className="block truncate text-sm">{app.displayName}</span><span className="block break-all text-xs text-muted-foreground">{app.id}{blocked(app) ? " · 16-app limit reached" : ""}</span></span>
        </button>)}
      </div>
      {(waiting || saving) && <p role="status" className="p-2 text-xs text-muted-foreground">{saving ? "Adding app to context…" : "Loading apps…"}</p>}
      {!waiting && !error && !apps.length && <p role="status" className="p-2 text-xs text-muted-foreground">No matching apps</p>}
      {error && <div className="p-2"><p role="alert" className="text-xs text-destructive">{error}</p><Button type="button" size="sm" variant="ghost" onClick={() => setRetry(n => n + 1)}>Retry search</Button></div>}
      {next !== null && <Button type="button" variant="ghost" size="sm" disabled={loading || saving} onClick={() => {
        const request = generation.current; setLoading(true);
        void listContextApps(search ?? "", next).then(page => { if (generation.current === request) setResults(previous => ({ key, apps: [...previous.apps, ...page.apps], next: page.nextOffset })); })
          .catch(cause => { if (generation.current === request) setError(String(cause)); }).finally(() => { if (generation.current === request) setLoading(false); });
      }}>Load more</Button>}
    </PopoverContent>
  </Popover>;
}
