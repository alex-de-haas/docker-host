"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api";
import { loadPromptTemplates, savePromptTemplates, validatePromptTemplate, type PromptTemplate, type PromptTemplateCollection, type PromptTemplateErrors, type PromptTemplateSave } from "@/lib/prompt-templates-api";

type PendingSave = { input: PromptTemplateSave; action: "save" | "delete" };
const message = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;

export function PromptTemplatesSettings() {
  const [collection, setCollection] = useState<PromptTemplateCollection | null>(null);
  const [editing, setEditing] = useState<PromptTemplate | null>(null);
  const [removing, setRemoving] = useState<PromptTemplate | null>(null);
  const [errors, setErrors] = useState<PromptTemplateErrors>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState<PendingSave | null>(null);
  const acting = useRef(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const createButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let active = true;
    void loadPromptTemplates().then(result => { if (active) setCollection(result); })
      .catch(reason => { if (active) setError(message(reason, "Could not load prompt templates.")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  function restoreFocus(event: Event) {
    event.preventDefault();
    (opener.current?.isConnected ? opener.current : createButton.current)?.focus();
  }

  async function reload() {
    if (acting.current || pending) return;
    acting.current = true; setBusy(true); setError("");
    try {
      const latest = await loadPromptTemplates();
      setCollection(latest); setConflict(false); setErrors({});
      setNotice(editing ? "Saved templates reloaded. Your draft is unchanged; review it before saving." : "Prompt templates reloaded.");
    } catch (reason) { setError(message(reason, "Could not reload prompt templates.")); }
    finally { acting.current = false; setBusy(false); setLoading(false); }
  }

  async function execute(operation: PendingSave) {
    if (acting.current) return;
    acting.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const saved = await savePromptTemplates(operation.input);
      setCollection(saved); setPending(null); setConflict(false); setEditing(null); setRemoving(null);
      setNotice(operation.action === "save" ? "Prompt template saved." : "Prompt template deleted.");
    } catch (reason) {
      // A transport or server failure may follow a committed write. Only an exact replay can
      // resolve it safely; keep the request and freeze further mutations until it is resolved.
      const knownFailure = reason instanceof ApiError && reason.status < 500 && reason.status !== 408;
      setPending(knownFailure ? null : operation);
      setConflict(reason instanceof ApiError && reason.status === 409);
      setError(message(reason, "Could not save prompt templates."));
    } finally { acting.current = false; setBusy(false); }
  }

  function save() {
    if (!collection || !editing || conflict || pending) return;
    const validation = validatePromptTemplate(editing, collection.templates);
    setErrors(validation);
    if (Object.keys(validation).length) return;
    const template = { ...editing, name: editing.name.trim(), shortcut: editing.shortcut.trim().toLowerCase() };
    const existing = collection.templates.some(item => item.id === template.id);
    if (!existing && collection.templates.length >= 100) { setError("You can save at most 100 prompt templates. Delete one before adding another."); return; }
    const templates = existing ? collection.templates.map(item => item.id === template.id ? template : item) : [...collection.templates, template];
    void execute({ action: "save", input: { revision: collection.revision, requestId: crypto.randomUUID(), templates } });
  }

  function beginEdit(template?: PromptTemplate) {
    opener.current = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    setEditing(template ? { ...template } : { id: crypto.randomUUID(), name: "", shortcut: "", text: "" });
    setRemoving(null); setErrors({}); setError(""); setNotice(""); setConflict(false);
  }

  const locked = busy || pending !== null;
  const errorContent = error && <div className="space-y-2">
    <p role="alert" className="text-sm text-destructive-foreground">{error}</p>
    {pending && <p className="text-sm text-muted-foreground">The save result is unknown. Your draft is preserved. Retry the same save to resolve it before making more changes.</p>}
    {conflict && <><p className="text-sm text-muted-foreground">Templates changed in another client. Reload saved templates to update the list while keeping your draft.</p>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void reload()}>Reload saved templates</Button></>}
  </div>;

  return <section className="space-y-5" aria-label="Prompt templates">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1"><h2 className="text-lg font-semibold">Prompt templates</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">Save prompts for your own account. Type a shortcut such as <code>!pr</code> in a message, or choose Prompt template from the + menu. Edit the inserted text before sending.</p></div>
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={locked || loading} onClick={() => void reload()}>Refresh</Button>
        <Button ref={createButton} disabled={locked || !collection || collection.templates.length >= 100} onClick={() => beginEdit()}>Create template</Button></div>
    </div>
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {!editing && !removing && errorContent}
    {loading && <p role="status" className="text-sm text-muted-foreground">Loading prompt templates…</p>}
    {collection && collection.templates.length === 0 && <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">No prompt templates yet. Create one for a prompt you use often, such as preparing a pull request.</p>}
    {collection && collection.templates.length >= 100 && <p className="text-sm text-muted-foreground">You have 100 templates. Delete one to create another.</p>}
    {!!collection?.templates.length && <div className="divide-y rounded-md border">{collection.templates.map(template => <article key={template.id} className="flex flex-wrap items-start justify-between gap-4 p-4">
      <div className="min-w-0 flex-1 space-y-1"><h3 className="font-medium break-words">{template.name}</h3>
        <code className="text-xs text-muted-foreground">!{template.shortcut}</code>
        <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">{template.text.slice(0, 240)}{template.text.length > 240 ? "…" : ""}</p></div>
      <div className="flex gap-2"><Button size="sm" variant="outline" disabled={locked} onClick={() => beginEdit(template)}>Edit<span className="sr-only"> {template.name}</span></Button>
        <Button size="sm" variant="ghost" disabled={locked} onClick={event => { opener.current = event.currentTarget; setRemoving(template); setError(""); setNotice(""); setConflict(false); }}>Delete<span className="sr-only"> {template.name}</span></Button></div>
    </article>)}</div>}

    <Dialog open={editing !== null} onOpenChange={open => { if (!open && !locked) setEditing(null); }}>
      <DialogContent className="sm:max-w-2xl" showCloseButton={!locked} onCloseAutoFocus={restoreFocus}>
        <DialogHeader><DialogTitle>{collection?.templates.some(template => template.id === editing?.id) ? "Edit template" : "Create template"}</DialogTitle>
          <DialogDescription>Only you can use these templates. Prompt text is inserted exactly as written and stays editable.</DialogDescription></DialogHeader>
        {editing && <form noValidate className="flex min-h-0 flex-1 flex-col gap-4" onSubmit={event => { event.preventDefault(); if (pending) void execute(pending); else save(); }}>
          <DialogBody><FieldGroup>
            <Field data-invalid={!!errors.name}><FieldLabel htmlFor="template-name">Title</FieldLabel>
              <Input id="template-name" value={editing.name} maxLength={120} disabled={locked} aria-invalid={!!errors.name} aria-describedby={errors.name ? "template-name-error" : undefined} onChange={event => setEditing({ ...editing, name: event.target.value })} />
              <FieldError id="template-name-error">{errors.name}</FieldError></Field>
            <Field data-invalid={!!errors.shortcut}><FieldLabel htmlFor="template-shortcut">Shortcut</FieldLabel>
              <Input id="template-shortcut" value={editing.shortcut} maxLength={40} placeholder="pr" disabled={locked} aria-invalid={!!errors.shortcut} aria-describedby={`template-shortcut-help${errors.shortcut ? " template-shortcut-error" : ""}`} onChange={event => setEditing({ ...editing, shortcut: event.target.value })} />
              <FieldDescription id="template-shortcut-help">Enter the shortcut without !. For example, pr becomes !pr. Shortcuts ignore letter case.</FieldDescription>
              <FieldError id="template-shortcut-error">{errors.shortcut}</FieldError></Field>
            <Field data-invalid={!!errors.text}><FieldLabel htmlFor="template-text">Prompt text</FieldLabel>
              <Textarea id="template-text" className="min-h-56 resize-y" value={editing.text} maxLength={16000} disabled={locked} aria-invalid={!!errors.text} aria-describedby={errors.text ? "template-text-error" : undefined} onChange={event => setEditing({ ...editing, text: event.target.value })} />
              <FieldError id="template-text-error">{errors.text}</FieldError></Field>
          </FieldGroup>{errorContent}</DialogBody>
          <DialogFooter><Button type="button" variant="outline" disabled={locked} onClick={() => setEditing(null)}>Cancel</Button>
            <Button type="submit" disabled={busy || conflict}>{busy ? "Saving…" : pending ? "Retry save" : "Save template"}</Button></DialogFooter>
        </form>}
      </DialogContent>
    </Dialog>
    <Dialog open={removing !== null} onOpenChange={open => { if (!open && !locked) setRemoving(null); }}>
      <DialogContent showCloseButton={!locked} onCloseAutoFocus={restoreFocus}><DialogHeader><DialogTitle>Delete {removing?.name}?</DialogTitle>
        <DialogDescription>This removes the template from your account. Text already inserted into messages stays in place.</DialogDescription></DialogHeader>
        <DialogBody>{errorContent}</DialogBody><DialogFooter>
          <Button variant="outline" disabled={locked} onClick={() => setRemoving(null)}>Cancel</Button>
          <Button variant="destructive" disabled={busy || conflict} onClick={() => {
            if (pending) void execute(pending);
            else if (collection && removing) void execute({ action: "delete", input: { revision: collection.revision, requestId: crypto.randomUUID(), templates: collection.templates.filter(template => template.id !== removing.id) } });
          }}>{busy ? "Deleting…" : pending ? "Retry delete" : "Delete template"}</Button>
        </DialogFooter></DialogContent>
    </Dialog>
  </section>;
}
