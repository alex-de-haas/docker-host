"use client";
import { useEffect, useRef, useState } from "react";
import { LockKeyhole, ChevronDown } from "lucide-react";
import { Field, FieldTitle, FieldDescription } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { listProfiles, selectSessionProfile, type AgentProfile } from "@/lib/profiles-api";
import type { AssistantSession } from "@/lib/assistant-api";
type ProfileProps = {
  session: AssistantSession; busy: boolean; onChange(value: AssistantSession): void; onSavingChange(value: boolean): void; enabled?: boolean;
};
export function useSessionProfile({ session, busy, onChange, onSavingChange, enabled = true }: ProfileProps) {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]), [error, setError] = useState("");
  const [saving, setSaving] = useState(false), [refresh, setRefresh] = useState(0);
  const pending = useRef(false);
  const locked = session.profileLocked === true || session.providerLocked === true || !!session.taskExecutionId;
  useEffect(() => {
    if (locked || !enabled) return;
    let active = true;
    void listProfiles().then(value => { if (active) { setProfiles(value.profiles); setError(""); } })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : "Could not load profiles."); });
    return () => { active = false; };
  }, [session.id, locked, refresh, enabled]);
  async function choose(id: string) {
    if (locked || busy || pending.current) return;
    pending.current = true; setSaving(true); onSavingChange(true); setError("");
    const selected = profiles.find(p => p.id === id);
    try { onChange(await selectSessionProfile(session.id, id === "__none__" ? null : id, selected?.revision, session.selectionRevision ?? 0)); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not select profile."); }
    finally { pending.current = false; setSaving(false); onSavingChange(false); }
  }
  return { session, busy, profiles, error, saving, locked, choose, refresh: () => setRefresh(n => n + 1) };
}
export function SessionProfile(props: ProfileProps) {
  return <SessionProfileField controller={useSessionProfile(props)} />;
}
export function SessionProfileField({ controller }: { controller: ReturnType<typeof useSessionProfile> }) {
  const { session, busy, profiles, error, saving, locked, choose, refresh } = controller;
  return <Field className="min-w-0 gap-2">
    <FieldTitle>Agent profile</FieldTitle>
    {locked ? <>
      <div className="flex items-center gap-2 text-sm" aria-label="Current agent profile"><LockKeyhole className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="wrap-anywhere">{session.agentProfile?.name ?? "No profile"}</span></div>
      <FieldDescription>{session.taskExecutionId ? "Fixed for this task." : "Fixed after the first message."}</FieldDescription>
    </> : <>

    <DropdownMenu onOpenChange={open => { if (open) refresh(); }}><DropdownMenuTrigger asChild>
      <Button type="button" variant="outline" className="h-9 w-full min-w-0 justify-between px-3" disabled={locked || busy || saving} aria-label="Agent profile" title={locked ? "Profile is fixed for this conversation" : "Choose an agent profile"}>
        <span className="truncate">{session.agentProfile?.name ?? "No profile"}</span><ChevronDown data-icon="inline-end" />
      </Button>
    </DropdownMenuTrigger><DropdownMenuContent side="top" align="start" className="max-h-72 max-w-[calc(100vw-2rem)] overflow-y-auto">
      <DropdownMenuRadioGroup value={session.agentProfile?.id ?? "__none__"} onValueChange={id => void choose(id)}>
        <DropdownMenuRadioItem value="__none__">No profile</DropdownMenuRadioItem>
        {profiles.map(p => <DropdownMenuRadioItem key={p.id} value={p.id}><span>{p.name}{p.description && <span className="block max-w-64 text-xs text-muted-foreground">{p.description}</span>}</span></DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent></DropdownMenu>
    </>}
    {saving && <span role="status" className="sr-only">Saving profile…</span>}
    {error && <div className="max-w-72"><p role="alert" className="text-destructive-foreground">{error}</p><Button type="button" variant="outline" size="sm" disabled={saving} onClick={refresh}>Refresh profiles</Button></div>}
  </Field>;
}
