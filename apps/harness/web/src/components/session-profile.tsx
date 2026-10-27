"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { listProfiles, selectSessionProfile, type AgentProfile } from "@/lib/profiles-api";
import type { AssistantSession } from "@/lib/assistant-api";
export function SessionProfile({ session, busy, onChange, onSavingChange }: {
  session: AssistantSession; busy: boolean; onChange(value: AssistantSession): void; onSavingChange(value: boolean): void;
}) {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]), [error, setError] = useState("");
  const [saving, setSaving] = useState(false), [refresh, setRefresh] = useState(0);
  const pending = useRef(false);
  const locked = session.profileLocked === true || session.providerLocked === true;
  useEffect(() => {
    if (locked) return;
    let active = true;
    void listProfiles().then(value => { if (active) { setProfiles(value.profiles); setError(""); } })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : "Could not load profiles."); });
    return () => { active = false; };
  }, [session.id, locked, refresh]);
  async function choose(id: string) {
    if (locked || busy || pending.current) return;
    pending.current = true; setSaving(true); onSavingChange(true); setError("");
    const selected = profiles.find(p => p.id === id);
    try { onChange(await selectSessionProfile(session.id, id === "__none__" ? null : id, selected?.revision, session.selectionRevision ?? 0)); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not select profile."); }
    finally { pending.current = false; setSaving(false); onSavingChange(false); }
  }
  return <div className="min-w-0 text-xs">
    <DropdownMenu onOpenChange={open => { if (open) setRefresh(n => n + 1); }}><DropdownMenuTrigger asChild>
      <Button type="button" variant="ghost" className="h-9 max-w-48 px-2" disabled={locked || busy || saving} aria-label="Agent profile" title={locked ? "Profile is fixed for this conversation" : "Choose an agent profile"}>
        <span className="truncate">{session.agentProfile?.name ?? "No profile"}</span>
      </Button>
    </DropdownMenuTrigger><DropdownMenuContent side="top" align="start">
      <DropdownMenuRadioGroup value={session.agentProfile?.id ?? "__none__"} onValueChange={id => void choose(id)}>
        <DropdownMenuRadioItem value="__none__">No profile</DropdownMenuRadioItem>
        {profiles.map(p => <DropdownMenuRadioItem key={p.id} value={p.id}><span>{p.name}{p.description && <span className="block max-w-64 text-xs text-muted-foreground">{p.description}</span>}</span></DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent></DropdownMenu>
    {saving && <span role="status" className="sr-only">Saving profile…</span>}
    {error && <div className="max-w-72"><p role="alert" className="text-destructive-foreground">{error}</p><Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => setRefresh(n => n + 1)}>Refresh profiles</Button></div>}
  </div>;
}
