"use client";

import { useRef, useState } from "react";
import { Plus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldSet, FieldLegend } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { InlineError } from "@/components/status";
import { dispatchAppCreation, getSession, workspaceAction, type AssistantSession } from "@/lib/assistant-api";

type Draft = { appId: string; name: string; description: string; authorName: string; authorEmail: string; prompt: string; consent: boolean; requestId?: string; iconPng?: string };
const empty: Draft = { appId: "", name: "", description: "", authorName: "", authorEmail: "", prompt: "", consent: false };
const key = (id: string) => "hosty.creation." + id;

function suggestId(name: string) { return "local." + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 57); }
function readDraft(raw: string | null): Draft {
  if (!raw) return { ...empty };
  if (raw.length > 384 * 1024) throw new Error("Draft is too large.");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid draft.");
  const data = value as Record<string, unknown>;
  const next = { ...empty };
  for (const [field, limit] of Object.entries({ appId: 63, name: 120, description: 4000, authorName: 200, authorEmail: 254, prompt: 20000 })) {
    if (data[field] !== undefined && (typeof data[field] !== "string" || (data[field] as string).length > limit)) throw new Error("Invalid draft field.");
    if (typeof data[field] === "string") Object.assign(next, { [field]: data[field] });
  }
  next.consent = data.consent === true;
  if (typeof data.requestId === "string" && /^[0-9a-f-]{36}$/i.test(data.requestId)) next.requestId = data.requestId;
  if (typeof data.iconPng === "string" && data.iconPng.length <= 174764 && /^[A-Za-z0-9+/]+={0,2}$/.test(data.iconPng)) next.iconPng = data.iconPng;
  return next;
}

export function CreateApp({ session, busy, onChange }: {
  session: AssistantSession; busy: boolean; onChange: (session: AssistantSession) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(empty);
  const [working, setWorking] = useState(false);
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [readingIcon, setReadingIcon] = useState(false);
  const memory = useRef<Draft | null>(null);
  const generation = useRef(0);
  const saved = session.appCreations?.find(o => o.input.requestId === draft.requestId);
  const locked = working || !!draft.requestId;
  const operations = session.appCreations?.filter(o => o.state !== "rejected") ?? [];
  const pending = operations.filter(o => o.state === "pending");
  const recoverable = operations.filter(o => o.state === "pending" || !o.prompt || (session.handoffDispatch?.id === o.input.requestId && session.handoffDispatch?.state === "queued"));

  function persist(next: Draft) {
    memory.current = next;
    try {
      localStorage.setItem(key(session.id), JSON.stringify(next));
      setStorageError(""); return true;
    } catch {
      setStorageError("Draft could not be saved in this browser. Keep this page open and free storage before creating the app.");
      return false;
    }
  }
  function update(change: Partial<Draft>) {
    const next = { ...(memory.current ?? draft), ...change };
    setDraft(next); persist(next);
  }
  async function show(operation?: NonNullable<AssistantSession["appCreations"]>[number]) {
    const opened = ++generation.current;
    setError(""); setStep("");
    let next = memory.current ?? { ...empty };
    if (!memory.current) {
      try { next = readDraft(localStorage.getItem(key(session.id))); }
      catch { setStorageError("The saved draft could not be read. Keep this page open; review all fields before continuing."); }
    }
    const stored = operation ?? session.appCreations?.find(o => o.input.requestId === next.requestId);
    if (stored?.state === "rejected") next = { ...next, requestId: undefined };
    else if (stored) next = readDraft(JSON.stringify({ ...next, ...stored.input,
      consent: stored.input.bootstrapCommit === true, prompt: stored.prompt ?? next.prompt }));
    memory.current = next; setDraft(next); setOpen(true);
    if (next.requestId || (next.authorName && next.authorEmail)) return;
    try {
      const capabilities = await workspaceAction<{ gitIdentity?: { name: string; email: string } }>(session.id, "app-creation-capabilities");
      if (opened !== generation.current || memory.current?.requestId) return;
      if (capabilities.gitIdentity) update({
        authorName: memory.current?.authorName || capabilities.gitIdentity.name,
        authorEmail: memory.current?.authorEmail || capabilities.gitIdentity.email });
    } catch (cause) { if (opened === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  function close() { generation.current++; setOpen(false); }
  async function chooseIcon(file?: File) {
    if (!file) return;
    const opened = generation.current;
    setReadingIcon(true); setError("");
    try {
      if (file.size > 128 * 1024 || file.type !== "image/png") throw new Error("Choose a PNG icon up to 128 KiB and 1024×1024 pixels.");
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("The icon could not be read.")); reader.readAsDataURL(file);
      });
      await new Promise<void>((resolve, reject) => {
        const image = new Image();
        image.onload = () => image.width <= 1024 && image.height <= 1024 ? resolve() : reject(new Error("The icon must be at most 1024×1024 pixels."));
        image.onerror = () => reject(new Error("Choose a valid PNG image.")); image.src = data;
      });
      if (opened === generation.current) update({ iconPng: data.split(",")[1] });
    } catch (cause) { if (opened === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setReadingIcon(false); }
  }
  async function submit() {
    if (working || readingIcon || !draft.consent) return;
    setWorking(true); setError("");
    const current = { ...draft, requestId: draft.requestId ?? crypto.randomUUID() };
    // Persist the replay identity before any request; a lost response must not allocate a second app.
    if (!persist(current)) { memory.current = draft; setWorking(false); return; }
    setDraft(current);
    try {
      setStep("Preparing local source and workspace…");
      const saved = session.appCreations?.find(o => o.input.requestId === current.requestId);
      const input = saved?.input ?? { requestId: current.requestId, appId: current.appId, name: current.name,
        description: current.description, bootstrapCommit: current.consent, authorName: current.authorName, authorEmail: current.authorEmail, ...(current.iconPng ? { iconPng: current.iconPng } : {}) };
      await workspaceAction(session.id, "app-create", input);
      onChange(await getSession(session.id));
      setStep("Sending the request to the assistant…");
      const result = await dispatchAppCreation(session.id, current.requestId, current.prompt);
      onChange(result);
      if (result.handoffDispatch?.id === current.requestId && result.handoffDispatch.state === "unknown") {
        setError("Submission is uncertain. Inspect the conversation before sending another message. The app and workspace are retained.");
        return;
      }
      // A storage failure after acknowledged dispatch must not turn success into a new request.
      try { localStorage.removeItem(key(session.id)); } catch { /* Server replay remains authoritative. */ }
      memory.current = null; close(); setDraft(empty);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      try {
        const latest = await getSession(session.id); onChange(latest);
        if (latest.appCreations?.find(o => o.input.requestId === current.requestId)?.state === "rejected") {
          const editable = { ...current, requestId: undefined };
          setDraft(editable); persist(editable);
        }
      } catch { /* The original error and replay identity remain visible. */ }
    } finally { setWorking(false); setStep(""); }
  }

  return <Dialog open={open} onOpenChange={value => { if (!working && !readingIcon) { if (value) setOpen(true); else close(); } }}>
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button size="icon-sm" variant="ghost" className="relative" aria-label="Create app" disabled={busy || working} onClick={() => void show()}>
              <Plus aria-hidden="true" />
              {recoverable.length > 0 && <span aria-hidden="true" className="absolute top-1 right-1 size-1.5 rounded-full bg-warning-foreground" />}
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">Create app{recoverable.length > 0 ? " · recovery available" : ""}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader><DialogTitle>Create a local app</DialogTitle>
          <DialogDescription>Your source stays on this host. The assistant works in a separate worktree and prepares a Docker preview with its own data.</DialogDescription>
        </DialogHeader>
        {operations.length > 0 && <div className="space-y-2 text-sm" aria-label="App creation history">
          {operations.map(operation => <div key={String(operation.input.requestId)} className="flex items-center justify-between gap-2">
            <span className="min-w-0 text-muted-foreground">{String(operation.input.name || operation.input.appId)} · {operation.state === "observed" ? "Created locally" : "Creation pending"}</span>
            {recoverable.includes(operation) && <Button size="sm" variant="ghost" disabled={busy || working || readingIcon} onClick={() => void show(operation)}>Recover</Button>}
          </div>)}
        </div>}
        <form className="flex flex-col gap-5" onSubmit={event => { event.preventDefault(); void submit(); }}>
          <FieldGroup className="gap-4">
            <Field><FieldLabel htmlFor="create-app-name">Name</FieldLabel><Input id="create-app-name" required maxLength={120} disabled={locked} value={draft.name} onChange={e => update({ name: e.target.value, ...(!draft.appId || draft.appId === suggestId(draft.name) ? { appId: suggestId(e.target.value) } : {}) })} /></Field>
            <Field><FieldLabel htmlFor="create-app-id">App ID</FieldLabel><Input id="create-app-id" required maxLength={63} pattern={"(?!.*\\.\\.)[a-z0-9][a-z0-9._\\-]*"} placeholder="local.my-app" disabled={locked} value={draft.appId} onChange={e => update({ appId: e.target.value })} />
              <FieldDescription>Choose a unique ID. It remains the same when you publish later.</FieldDescription></Field>
            <Field><FieldLabel htmlFor="create-app-description">Description (optional)</FieldLabel><Input id="create-app-description" maxLength={4000} disabled={locked} value={draft.description} onChange={e => update({ description: e.target.value })} /></Field>
            <Field>
              <FieldLabel htmlFor="create-app-icon">Icon (optional)</FieldLabel>
              <Input id="create-app-icon" type="file" accept="image/png" disabled={locked || readingIcon} onChange={e => { void chooseIcon(e.target.files?.[0]); e.target.value = ""; }} />
              <FieldDescription>PNG, up to 128 KiB and 1024×1024 pixels. Included in the initial commit.</FieldDescription>
              {draft.iconPng && <div className="flex items-center gap-2">
                {/* Uploaded local data is displayed directly, without an image optimization request. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`data:image/png;base64,${draft.iconPng}`} alt="App icon preview" className="size-12 rounded-md object-contain" />
                <Button type="button" variant="outline" disabled={locked || readingIcon} onClick={() => update({ iconPng: undefined })}>Remove icon</Button>
              </div>}
            </Field>
            <FieldSet><FieldLegend variant="label">Local Git repository</FieldLegend>
            <FieldDescription>No remote is connected and nothing is published. These author details apply to the initial commit; your account settings stay unchanged.</FieldDescription>
            <FieldGroup className="grid gap-4 sm:grid-cols-2">
              <Field><FieldLabel htmlFor="create-app-author">Git author</FieldLabel><Input id="create-app-author" required maxLength={200} disabled={locked} value={draft.authorName} onChange={e => update({ authorName: e.target.value })} /></Field>
              <Field><FieldLabel htmlFor="create-app-email">Git email</FieldLabel><Input id="create-app-email" type="email" required maxLength={254} disabled={locked} value={draft.authorEmail} onChange={e => update({ authorEmail: e.target.value })} /></Field>
            </FieldGroup></FieldSet>
            <Field><FieldLabel htmlFor="create-app-prompt">What would you like to build?</FieldLabel><Textarea id="create-app-prompt" required maxLength={20000} rows={4} disabled={working || saved?.prompt !== undefined} value={draft.prompt} onChange={e => update({ prompt: e.target.value })} /></Field>
            <Field orientation="horizontal"><Checkbox id="create-app-consent" checked={draft.consent} disabled={locked} onCheckedChange={value => update({ consent: value === true })} />
              <FieldLabel htmlFor="create-app-consent">Create one initial commit with these author details. Keep the repository local; later commits and publication are separate actions.</FieldLabel></Field>
          </FieldGroup>
          {storageError ? <p role="alert" className="text-sm text-destructive-foreground">{storageError}</p> : <p className="text-sm text-muted-foreground">Draft is saved in this browser as you edit. Close and reopen to continue.</p>}
          {draft.requestId && <p className="text-sm text-muted-foreground">{saved?.state === "observed" ? "App and workspace created locally. Continue to send the saved request to the assistant." : "Creation was submitted. Continue with the same details to check its result."}</p>}
          {error && <div role="alert"><InlineError message={error} /></div>}
          {step && <p role="status" className="text-sm text-muted-foreground">{step}</p>}
          {pending.length > 0 && !draft.requestId && <p className="text-sm text-muted-foreground">This session has pending creation work. Use Recover to continue it without creating another app.</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={working || readingIcon} onClick={close}>Close</Button>
            <Button type="submit" disabled={working || readingIcon || busy || !draft.consent}>{working && <Loader2 className="motion-safe:animate-spin" data-icon="inline-start" />}{draft.requestId ? "Continue creation" : "Create and build"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
  </Dialog>;
}
