"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { HostyLoader } from "../../../../../shared/web/hosty-states";
import { ChevronDown, Loader2 } from "lucide-react";
import { APP_SESSION_RESTORED } from "@hosty-sdk/app/browser-auth";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { listAgentConnections, setSessionProvider, type AssistantSession } from "@/lib/assistant-api";
import type { AgentConnection } from "./agent-providers";

export function SessionProvider({ session, busy, onChange, onSavingChange }: {
  session: AssistantSession;
  busy: boolean;
  onChange(record: AssistantSession): void;
  onSavingChange?(saving: boolean): void;
}) {
  const [connections, setConnections] = useState<AgentConnection[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [selected, setSelected] = useState(session.connectionId ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const confirmationId = useId();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const refreshRef = useRef<() => void>(() => {});
  const savingRef = useRef(false);
  const attemptedDefault = useRef<string | null>(null);
  const locked = session.providerLocked === true && Boolean(session.connectionId);
  const legacy = session.providerLocked === true && !session.connectionId;
  const callbacks = useRef({ onChange, onSavingChange });
  useEffect(() => { callbacks.current = { onChange, onSavingChange }; }, [onChange, onSavingChange]);

  const save = useCallback(async (id: string, confirmLegacy = false) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    callbacks.current.onSavingChange?.(true);
    try {
      const record = await setSessionProvider(session.id, id, confirmLegacy);
      setSelected(record.connectionId ?? "");
      callbacks.current.onChange(record);
    } catch (cause) {
      setSelected(session.connectionId ?? "");
      setError(cause instanceof Error ? cause.message : "Could not select provider.");
    } finally {
      savingRef.current = false;
      setSaving(false);
      callbacks.current.onSavingChange?.(false);
    }
  }, [session.id, session.connectionId]);

  useEffect(() => {
    let disposed = false;
    let revision = 0;
    const refresh = (adoptInitialDefault = false) => {
      const request = ++revision;
      setLoading(true);
      void listAgentConnections().then(result => {
        if (disposed || request !== revision) return;
        setConnections(result.connections);
        setDefaultId(result.defaultId);
        setReadError(null);
        const defaultConnection = result.connections.find(c => c.id === result.defaultId && c.available);
        // Recovery refreshes only read choices; they never select an account on the user's behalf.
        if (adoptInitialDefault && !busy && !session.connectionId && !legacy && defaultConnection && attemptedDefault.current !== defaultConnection.id) {
          attemptedDefault.current = defaultConnection.id;
          void save(defaultConnection.id);
        }
      }).catch(cause => {
        if (!disposed && request === revision) setReadError(cause instanceof Error ? cause.message : "Could not load providers.");
      }).finally(() => { if (!disposed && request === revision) setLoading(false); });
    };
    const recover = () => refresh();
    refreshRef.current = recover;
    refresh(true);
    window.addEventListener("focus", recover);
    window.addEventListener(APP_SESSION_RESTORED, recover);
    return () => {
      disposed = true;
      refreshRef.current = () => {};
      window.removeEventListener("focus", recover);
      window.removeEventListener(APP_SESSION_RESTORED, recover);
    };
  }, [session.id, session.connectionId, busy, legacy, save]);

  const current = connections.find(c => c.id === session.connectionId);
  return (
    <div className="flex min-w-0 max-w-48 flex-col gap-1 text-xs" aria-label="Chat provider">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" className="h-9 min-w-0 max-w-full gap-1.5 px-2"
            aria-label={`Provider: ${connections.find(c => c.id === selected)?.name ?? session.harnessKind ?? "Choose provider"}`}
            title={locked ? "The provider cannot be changed after the first message." : "Choose provider"}
            disabled={busy || saving || locked}>
            <span className="truncate">{connections.find(c => c.id === selected)?.name ?? (selected ? session.harnessKind ?? "Unavailable provider" : "Choose provider")}</span>
            {saving || loading ? <Loader2 className="size-3.5 shrink-0 motion-safe:animate-spin" /> : <ChevronDown className="size-3.5 shrink-0" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-64 max-w-[calc(100vw-2rem)]">
          <DropdownMenuLabel>Provider</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={selected}>
            {connections.map(c => <DropdownMenuRadioItem key={c.id} value={c.id} disabled={!c.available}
              onSelect={() => {
                if (legacy) { setSelected(c.id); setConfirmed(false); }
                else if (c.id !== session.connectionId || c.revision !== session.connectionRevision) void save(c.id);
              }}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate">{c.name}</span>
                  {c.id === defaultId && <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">Default</span>}
                </div>
                <p className="text-xs text-muted-foreground">{c.kind === "codex" ? "Codex" : "Claude"}{c.available ? "" : " · reconnect required"}</p>
              </div>
            </DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
          {loading && <p role="status" className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground"><HostyLoader label={null} className="size-4 shrink-0" />Loading providers…</p>}
          {!loading && !readError && !connections.length && <p className="px-2 py-1.5 text-xs text-muted-foreground">Add a provider in Hosty Harness settings.</p>}
        </DropdownMenuContent>
      </DropdownMenu>
      {saving && <span role="status" className="sr-only">Saving provider…</span>}
      {locked && current && current.revision !== session.connectionRevision &&
        <p className="text-muted-foreground">Credentials changed; start a new chat.</p>}
      {legacy && <>
        <label htmlFor={confirmationId} className="flex gap-2 text-muted-foreground">
          <Checkbox id={confirmationId} checked={confirmed} disabled={busy || saving}
            onCheckedChange={checked => setConfirmed(checked === true)} />
          This older chat used the selected provider and account. Resume it with that connection.
        </label>
        <Button type="button" size="sm" variant="outline" disabled={busy || saving || !selected || !confirmed}
          onClick={() => void save(selected, confirmed)}>Confirm original provider</Button>
      </>}
      {readError && <div className="space-y-1"><p role="alert" className="text-destructive-foreground wrap-anywhere">{readError}</p>
        <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => refreshRef.current()}>Retry providers</Button>
      </div>}
      {error && <p role="alert" className="text-destructive-foreground wrap-anywhere">{error}</p>}
    </div>
  );
}
