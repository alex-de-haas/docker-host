"use client";
import { useEffect, useRef, useState } from "react";
import { AgentProfileForm } from "./agent-profile-form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { listAgentConnections } from "@/lib/assistant-api";
import { listProfiles, profileSkills, saveProfile, deleteProfile, defaultProfile, type AgentProfileConfig, type AgentProfile, type ProfileDirectory, type ProfileSkill } from "@/lib/profiles-api";
import type { AgentConnection } from "./agent-providers";
const empty = (): AgentProfileConfig => ({ name: "", description: "", instructions: "", connectionId: null, model: null, reasoningEffort: null, skillIds: [] });
function config(p: AgentProfile): AgentProfileConfig {
  return { name: p.name, description: p.description, instructions: p.instructions, connectionId: p.connectionId, model: p.model, reasoningEffort: p.reasoningEffort, skillIds: [...p.skillIds] };
}
export function AgentProfiles() {
  const [directory, setDirectory] = useState<ProfileDirectory | null>(null);
  const [connections, setConnections] = useState<AgentConnection[]>([]), [defaultConnectionId, setDefaultConnectionId] = useState<string | null>(null);
  const [skills, setSkills] = useState<ProfileSkill[]>([]), [skillsError, setSkillsError] = useState<string>();
  const [editing, setEditing] = useState<{ id?: string; revision: number; value: AgentProfileConfig } | null>(null);
  const [removing, setRemoving] = useState<AgentProfile | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const saving = useRef(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const createButton = useRef<HTMLButtonElement | null>(null);
  function restoreFocus(event: Event) {
    event.preventDefault();
    (opener.current?.isConnected ? opener.current : createButton.current)?.focus();
  }
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    void listProfiles().then(profiles => { if (active) { setDirectory(profiles); setError(""); } })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : "Could not load profiles."); });
    void listAgentConnections().then(agents => {
      if (active) { setConnections(agents.connections); setDefaultConnectionId(agents.defaultId); setConnectionError(""); }
    }).catch(e => { if (active) setConnectionError(e instanceof Error ? e.message : "Could not load agent connections."); });
    void profileSkills().then(result => { if (active) { setSkills(result.skills); setSkillsError(undefined); } })
      .catch(e => { if (active) setSkillsError(e instanceof Error ? e.message : "Could not load skills."); });
    return () => { active = false; };
  }, [refresh]);
  async function change(action: () => Promise<ProfileDirectory>, message: string, inForm = false) {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(""); setFormError(""); setNotice("");
    try { setDirectory(await action()); setNotice(message); if (inForm) setEditing(null); setRemoving(null); }
    catch (e) { (inForm ? setFormError : setError)(e instanceof Error ? e.message : "Could not save profile."); }
    finally { saving.current = false; setBusy(false); }
  }
  function edit(p?: AgentProfile, duplicate = false) {
    if (!directory) return;
    opener.current = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    setFormError(""); setEditing({ id: duplicate ? undefined : p?.id, revision: directory.revision,
      value: p ? { ...config(p), ...(duplicate ? { name: `${p.name} copy`.slice(0, 100) } : {}) } : empty() });
  }
  return <section className="space-y-5" aria-label="Agent profiles">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="space-y-1">
      <h2 className="text-lg font-semibold">Agent profiles</h2>
      <p className="max-w-2xl text-sm text-muted-foreground">Save a planner, developer, reviewer or another role. Choose a profile before starting a conversation.</p>
    </div><div className="flex gap-2"><Button variant="outline" disabled={busy} onClick={() => setRefresh(n => n + 1)}>Refresh</Button>
      <Button ref={createButton} disabled={busy || !directory} onClick={() => edit()}>Create profile</Button></div></div>
    {error && <p role="alert" className="text-sm text-destructive-foreground">{error}</p>}
    {connectionError && <p role="alert" className="text-sm">{connectionError} Saved profiles are retained. Refresh to retry.</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {!directory && !error && <p role="status">Loading profiles…</p>}
    {directory?.catalogUnavailable && <p className="text-sm text-muted-foreground">The skill catalog is unavailable. Saved selections are retained.</p>}
    {directory && !directory.profiles.length && <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">No profiles yet. Create a reusable agent configuration, or continue using chat without a profile.</p>}
    <div className="divide-y rounded-md border">{directory?.profiles.map(p => <article key={p.id} className="flex flex-wrap items-start justify-between gap-4 p-4">
      <div className="min-w-0 flex-1 space-y-1"><h3 className="font-medium break-words">{p.name}{p.id === directory.defaultId && <span className="ml-2 text-xs text-muted-foreground"> Default</span>}</h3>
        <p className="text-sm whitespace-pre-wrap break-words text-muted-foreground">{p.description}</p>
        <p className="text-xs text-muted-foreground">{p.connectionId ? connections.find(c => c.id === p.connectionId)?.name ?? "Unavailable connection" : "Harness default"} · {p.model ?? "Agent default model"} · {p.skillIds.length} {p.skillIds.length === 1 ? "skill" : "skills"}</p>
      </div><div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => edit(p)}>Edit<span className="sr-only"> {p.name}</span></Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => edit(p, true)}>Duplicate<span className="sr-only"> {p.name}</span></Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void change(() => defaultProfile(directory.defaultId === p.id ? null : p.id, directory.revision), "Default profile saved for new chats.")}>{directory.defaultId === p.id ? "Clear default" : "Set default"}<span className="sr-only"> {p.name}</span></Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={event => { opener.current = event.currentTarget; setError(""); setRemoving(p); }}>Delete<span className="sr-only"> {p.name}</span></Button>
      </div>
    </article>)}</div>
    <Dialog open={editing !== null} onOpenChange={open => { if (!open && !busy) setEditing(null); }}>
      <DialogContent onCloseAutoFocus={restoreFocus} className="sm:max-w-2xl"><DialogHeader><DialogTitle>{editing?.id ? "Edit profile" : "Create profile"}</DialogTitle>
        <DialogDescription>Changes apply when this configuration is selected for a new conversation. Started conversations keep their instructions.</DialogDescription></DialogHeader>
        {editing && <form className="flex min-h-0 flex-1 flex-col gap-4" onSubmit={e => { e.preventDefault(); void change(() => saveProfile(editing.value, editing.revision, editing.id), "Profile saved.", true); }}>
          <DialogBody>
            <AgentProfileForm value={editing.value} onChange={value => setEditing(current => current ? { ...current, value } : null)} connections={connections} defaultConnectionId={defaultConnectionId} skills={skills} skillsError={skillsError} disabled={busy} />
            {formError && <div className="space-y-2"><p role="alert" className="text-sm text-destructive-foreground">{formError}</p>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={async () => {
                try { const latest = await listProfiles(); setDirectory(latest); const saved = latest.profiles.find(p => p.id === editing.id);
                  setEditing({ id: saved?.id, revision: latest.revision, value: saved ? config(saved) : editing.value }); setFormError(""); }
                catch (e) { setFormError(e instanceof Error ? e.message : "Could not reload profiles."); }
              }}>Reload saved profile</Button></div>}
          </DialogBody>
          <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button>
            <Button type="submit" disabled={busy || !editing.value.name.trim()}>{busy ? "Saving…" : "Save profile"}</Button></DialogFooter>
        </form>}
      </DialogContent>
    </Dialog>
    <Dialog open={removing !== null} onOpenChange={open => { if (!open && !busy) setRemoving(null); }}>
      <DialogContent onCloseAutoFocus={restoreFocus}><DialogHeader><DialogTitle>Delete {removing?.name}?</DialogTitle><DialogDescription>Existing conversations keep their settings and history. You can create another profile later.</DialogDescription></DialogHeader>
        <DialogBody>
          {error && <p role="alert" className="text-sm text-destructive-foreground">{error}</p>}
        </DialogBody>
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => { if (removing && directory) void change(() => deleteProfile(removing.id, directory.revision), "Profile deleted."); }}>Delete profile</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
