"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { call } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";

type Skill = { id: string; name: string; description: string; sourceKind: string; coreVersion?: string; appId?: string; appVersion?: string;
  repository?: string; ref?: string; path: string; commit?: string; fileCount: number; bytes: number };
type Candidate = { path: string; name: string; description: string; fileCount: number; bytes: number };
type Discovery = { repository: string; ref: string; commit: string; skills: Candidate[] };
type Update = { id: string; availableCommit?: string; removed: boolean; error?: string };
type Connection = { id: string; label: string; provider: string };
async function json<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  return (await call(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json();
}

export function SkillLibrary() {
  const fieldId = useId();
  const [addOpen, setAddOpen] = useState(false);
  const [addStep, setAddStep] = useState<"source" | "skills">("source");
  const repositoryInput = useRef<HTMLInputElement>(null);
  const stepTitle = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (addOpen) (addStep === "source" ? repositoryInput.current : stepTitle.current)?.focus();
  }, [addOpen, addStep]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [filter, setFilter] = useState("");
  const [repository, setRepository] = useState("");
  const [reference, setReference] = useState("HEAD");
  const [directory, setDirectory] = useState("");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [discoverySource, setDiscoverySource] = useState<unknown>(null);
  const [discoveryFilter, setDiscoveryFilter] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [updates, setUpdates] = useState<Update[]>([]);
  const [preview, setPreview] = useState<{ id: string; name: string; path: string; text: string; files: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const catalog = await json<{ skills: Skill[] }>("/skills");
    setSkills(catalog.skills);
    setLoaded(true);
  }, []);
  useEffect(() => {
    let active = true;
    void json<{ skills: Skill[] }>("/skills").then(catalog => {
      if (!active) return;
      setSkills(catalog.skills); setLoaded(true);
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "Could not load skills."); });
    void json<{ connections: Connection[] }>("/source-connections").then(value => { if (active) setConnections(value.connections); }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "Could not load Source connections."); });
    return () => { active = false; };
  }, []);

  async function action(work: () => Promise<void>) {
    setBusy(true); setError(null); setNotice(null);
    try { await work(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The skill operation failed."); }
    finally { setBusy(false); }
  }
  async function read(id: string, name: string, file = "SKILL.md") {
    const content = await json<{ content: string; files: string[] }>(`/skills/${id}/content?path=${encodeURIComponent(file)}`);
    const bytes = Uint8Array.from(atob(content.content), character => character.charCodeAt(0));
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); if (text.includes("\0")) text = "Binary file; use the native package export to access this file."; }
    catch { text = "Binary file; use the native package export to access this file."; }
    setPreview({ id, name, path: file, text, files: content.files });
  }
  async function update(ids: string[]) {
    await json("/skills/update", "POST", { skillIds: ids });
    await refresh(); setUpdates(current => current.filter(item => !ids.includes(item.id)));
    setNotice("Installed skills updated. Native clients pick up the current files when they reload them.");
  }
  const gitIds = skills.filter(skill => skill.sourceKind === "git").map(skill => skill.id);
  const visible = skills.filter(skill => `${skill.name} ${skill.description} ${skill.sourceKind} ${skill.coreVersion ?? ""} ${skill.repository ?? skill.appId ?? ""}`.toLowerCase().includes(filter.toLowerCase()));

  const discoveryQuery = discoveryFilter.trim().toLowerCase();
  const visibleCandidates = discovery?.skills.filter(skill =>
    skill.name.toLowerCase().includes(discoveryQuery) || skill.description.toLowerCase().includes(discoveryQuery)) ?? [];

  return <Dialog open={addOpen} onOpenChange={open => { if (!busy) { setAddOpen(open); if (open) setError(null); } }}>
  <section className="flex flex-col gap-6" aria-label="Shared skill library">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
      <h2 className="text-lg font-semibold">Skills</h2>
      <p className="text-sm text-muted-foreground">One shared library from Core, Git repositories and installed apps. Choose each agent’s skills in Agent profiles. Instructions and tool permissions are configured separately.</p>
      </div>
      <DialogTrigger asChild><Button disabled={busy}>Add skills</Button></DialogTrigger>
    </div>
    {error && !addOpen && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    <div className="flex flex-wrap gap-2">
      <Input aria-label="Filter skills" placeholder="Filter by name, description or source" value={filter} onChange={event => setFilter(event.target.value)} className="max-w-lg" />
      <Button variant="outline" disabled={busy} onClick={() => void action(refresh)}>Refresh</Button>
      <Button variant="outline" disabled={busy || !gitIds.length} onClick={() => void action(async () => {
        setUpdates((await json<{ skills: Update[] }>("/skills/check-updates", "POST", { skillIds: gitIds })).skills);
        setNotice("Update check complete. Installed files have not changed.");
      })}>Check updates</Button>
      <Button variant="outline" disabled={busy || !gitIds.length} onClick={() => void action(() => update(gitIds))}>Update all Git skills</Button>
    </div>
    {!loaded && !error && <p role="status">Loading skills…</p>}
    {loaded && !skills.length && <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">No skills installed. Choose Add skills to import from Git, or install an app that supplies skills.</p>}
    {visible.length > 0 && <div className="divide-y rounded-md border">
      {visible.map(skill => {
        const status = updates.find(item => item.id === skill.id);
        return <article key={skill.id} className="flex flex-wrap items-start justify-between gap-4 p-4">
          <div className="flex min-w-0 flex-1 gap-3">
            <div className="min-w-0 space-y-1">
              <h3 className="font-medium">{skill.name}</h3>
              <p className="text-sm text-muted-foreground">{skill.description}</p>
              <p className="break-all text-xs text-muted-foreground">{skill.sourceKind === "core" ? `Core · ${skill.coreVersion}` : skill.sourceKind === "app"
                ? `App · ${skill.appId} · ${skill.appVersion}`
                : `Git · ${skill.repository} · ${skill.ref} · ${skill.commit?.slice(0, 12)}`}</p>
              <p className="text-xs text-muted-foreground">{skill.fileCount} files · {Math.ceil(skill.bytes / 1024)} KiB</p>
              {status && <p className="text-sm">{status.error ?? (status.removed ? "Removed upstream. Applying the update removes this skill." :
                status.availableCommit !== skill.commit ? "Update available." : "Up to date.")}</p>}
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void action(() => read(skill.id, skill.name))}>Read</Button>
            {skill.sourceKind === "git" && <>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void action(() => update([skill.id]))}>Update</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void action(async () => {
                await json(`/skills/${skill.id}`, "DELETE"); await refresh(); setNotice("Skill removed from the shared library and native exports.");
              })}>Remove</Button>
            </>}
          </div>
        </article>;
      })}
    </div>}
    {preview && <section className="space-y-2" aria-label="Skill content">
      <div className="flex items-center justify-between"><h3 className="font-medium">{preview.name} / {preview.path}</h3><Button size="sm" variant="ghost" onClick={() => setPreview(null)}>Close</Button></div>
      <label className="block text-sm">Package file<select aria-label="Package file" className="ml-2 rounded-md border bg-background p-2" disabled={busy} value={preview.path} onChange={event => void action(() => read(preview.id, preview.name, event.target.value))}>
        {preview.files.map(file => <option key={file} value={file}>{file}</option>)}
      </select></label>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border p-4 text-sm">{preview.text}</pre>
    </section>}
  </section>
  <DialogContent className={cn("flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-2xl",
    addStep === "skills" && "h-[min(42rem,calc(100dvh-2rem))]")} showCloseButton={!busy}>
    <DialogHeader className="shrink-0">
      <DialogTitle ref={stepTitle} tabIndex={-1}>{addStep === "source" ? "Add skills" : "Choose skills"}</DialogTitle>
      <DialogDescription>{addStep === "source"
        ? "Step 1 of 2 · Choose a Git repository to discover its skill packages."
        : "Step 2 of 2 · Select the skills to add to the shared library."}</DialogDescription>
    </DialogHeader>
    {error && <Alert className="shrink-0" variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {addStep === "source" ? <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
      <FieldGroup className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${fieldId}-repository`}>Repository URL</FieldLabel>
          <Input ref={repositoryInput} id={`${fieldId}-repository`} disabled={busy} value={repository} onChange={event => setRepository(event.target.value)} placeholder="https://github.com/owner/repository.git" />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${fieldId}-reference`}>Branch, tag or commit</FieldLabel>
          <Input id={`${fieldId}-reference`} disabled={busy} value={reference} onChange={event => setReference(event.target.value)} placeholder="HEAD" />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${fieldId}-directory`}>Subdirectory (optional)</FieldLabel>
          <Input id={`${fieldId}-directory`} disabled={busy} value={directory} onChange={event => setDirectory(event.target.value)} placeholder="skills" />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${fieldId}-connection`}>Source connection</FieldLabel>
          <select id={`${fieldId}-connection`} className="h-9 w-full rounded-md border bg-background px-3 text-sm" disabled={busy} value={connectionId} onChange={event => setConnectionId(event.target.value)}>
            <option value="">Public repository</option>{connections.map(connection => <option key={connection.id} value={connection.id}>{connection.label} · {connection.provider}</option>)}
          </select>
        </Field>
      </FieldGroup>
      <p className="text-xs text-muted-foreground">Private sources use your existing Source connections. Manage accounts in Shell settings. Discovery may fetch repository files; only selected packages enter the library.</p>
    </div> : discovery && <>
      <div className="flex shrink-0 flex-col gap-1 text-sm">
        <p className="break-all">{discovery.repository}</p>
        <p className="text-muted-foreground">{discovery.skills.length} skills found · {discovery.commit.slice(0, 12)}</p>
      </div>
      <div className="shrink-0">
        <Input aria-label="Filter discovered skills" placeholder="Filter by name or description" disabled={busy}
          value={discoveryFilter} onChange={event => setDiscoveryFilter(event.target.value)} />
      </div>
      <div role="region" aria-label="Discovered skills" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-md border p-3">
        <div className="divide-y">
          {!discovery.skills.length && <p className="text-sm text-muted-foreground">No SKILL.md packages found in this directory. Go back to choose another repository or subdirectory.</p>}
          {discovery.skills.length > 0 && !visibleCandidates.length && <p className="text-sm text-muted-foreground">No skills match your filter.</p>}
          {visibleCandidates.map(skill => <label key={skill.path} className="flex items-start gap-3 py-4 text-sm first:pt-1 last:pb-1">
            <Checkbox checked={chosen.includes(skill.path)} disabled={busy} onCheckedChange={checked => setChosen(current => checked === true ? [...current, skill.path] : current.filter(path => path !== skill.path))} />
            <span className="min-w-0 break-words"><span className="font-medium">{skill.name}</span><span className="block text-muted-foreground">{skill.description}</span><span className="block text-xs text-muted-foreground">{skill.path || "Repository root"} · {skill.fileCount} files</span></span>
          </label>)}
        </div>
      </div>
    </>}
    <DialogFooter className="shrink-0 flex-row flex-wrap border-t pt-4">
      {addStep === "skills" && <Button className="mr-auto" variant="outline" disabled={busy} onClick={() => { setAddStep("source"); setError(null); }}>Back</Button>}
      <DialogClose asChild><Button variant="outline" disabled={busy}>Cancel</Button></DialogClose>
      {addStep === "source" ? <Button disabled={busy || !repository.trim()} onClick={() => void action(async () => {
        const source = { repository: repository.trim(), ref: reference.trim() || "HEAD", path: directory.trim(), ...(connectionId ? { connectionId } : {}) };
        const result = await json<Discovery>("/skills/discover", "POST", source);
        const unchanged = discovery?.commit === result.commit && JSON.stringify(discoverySource) === JSON.stringify(source);
        setChosen(current => unchanged ? current.filter(path => result.skills.some(skill => skill.path === path)) : []);
        setDiscovery(result); setDiscoverySource(source); setDiscoveryFilter(""); setAddStep("skills");
      })}>{busy ? "Discovering…" : "Discover skills"}</Button> : <Button disabled={busy || !chosen.length} onClick={() => void action(async () => {
        await json("/skills/install", "POST", { source: discoverySource, commit: discovery!.commit, paths: chosen });
        await refresh(); setDiscovery(null); setChosen([]); setAddOpen(false); setAddStep("source"); setNotice("Skills installed. Select the ones your agents should use.");
      })}>{busy ? "Installing…" : `Install selected (${chosen.length})`}</Button>}
    </DialogFooter>
  </DialogContent>
  </Dialog>;
}
