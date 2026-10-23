"use client";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { ReviewThreadActionError } from "./review-thread";
import type { ReviewCommentLocation } from "@/lib/review-selection";
import type { NewReviewCommentResult } from "@/lib/workspace-review-actions";
type Pending = { requestId: string; head: string; location: ReviewCommentLocation; body: string; ask: boolean };
type Draft = { body: string; ask: boolean; pending?: Pending };
function readDraft(key: string): Draft {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (!value || typeof value !== "object" || !("body" in value) || typeof value.body !== "string") return { body: "", ask: false };
    const draft: Draft = { body: value.body, ask: "ask" in value && value.ask === true };
    if ("pending" in value && value.pending && typeof value.pending === "object") {
      const pending = value.pending as Pending;
      if (typeof pending.requestId === "string" && typeof pending.head === "string" && typeof pending.body === "string" && pending.location && typeof pending.location.path === "string"
        && ["LEFT", "RIGHT"].includes(pending.location.diffSide) && Number.isSafeInteger(pending.location.startLine) && Number.isSafeInteger(pending.location.line)
        && pending.location.startLine > 0 && pending.location.line >= pending.location.startLine) draft.pending = pending;
    }
    return draft;
  } catch { return { body: "", ask: false }; }
}
export function ReviewCommentComposer(props: {
  storageScope: string; head: string; location: ReviewCommentLocation | null; prNumber: string; pullRequestUrl?: string;
  canStart: boolean; onSubmit: (pending: Pending, recovering: boolean) => Promise<NewReviewCommentResult>;
  focusRequest?: string | null; onFocusHandled?: () => void;
  onAsk?: (reference: string) => void; onClose: () => void; onPosted: () => void;
}) { return <Composer key={props.storageScope} {...props} />; }
function Composer({ storageScope, head, location, prNumber, pullRequestUrl, canStart, onSubmit, onAsk, onClose, onPosted, focusRequest, onFocusHandled }: Parameters<typeof ReviewCommentComposer>[0]) {
  const id = useId(), key = `hosty.review-comment.${storageScope}`;
  const [draft, setDraft] = useState<Draft>(() => readDraft(key));
  const current = useRef(draft), active = useRef(false), mounted = useRef(true);
  const textarea = useRef<HTMLTextAreaElement>(null), focusedRequest = useRef<string | null>(null);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!focusRequest || focusedRequest.current === focusRequest) return;
    focusedRequest.current = focusRequest;
    textarea.current?.focus(); onFocusHandled?.();
  }, [focusRequest, onFocusHandled]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const update = (next: Draft) => { sessionStorage.setItem(key, JSON.stringify(next)); current.current = next; if (mounted.current) setDraft(next); };
  const submit = async () => {
    if (active.current) return;
    const existing = current.current.pending;
    if (!existing && (!canStart || !location || !current.current.body.trim())) return;
    active.current = true; setBusy(true); setError("");
    try {
      const pending = existing ?? { requestId: crypto.randomUUID(), head, location: location!, body: current.current.body.trim(), ask: current.current.ask };
      // One durable record preserves the original head, range and intent across every replay window.
      update({ ...current.current, pending });
      const result = await onSubmit(pending, !!existing);
      update({ body: "", ask: false });
      // A confirmed old request still clears its own durable scope after navigation. Its UI
      // callbacks must not close another PR composer or append to a different conversation.
      if (!mounted.current) return;
      if (pending.ask && onAsk) onAsk(`Address this posted PR review comment\n${JSON.stringify({ pullRequest: pullRequestUrl, threadId: result.threadId, commentId: result.commentId, file: pending.location.path, side: pending.location.diffSide, startLine: pending.location.startLine, line: pending.location.line, headRevision: pending.head, comment: pending.body }, null, 2)}`);
      onPosted(); onClose();
    } catch (cause) {
      const definitive = cause instanceof ReviewThreadActionError && cause.definitive;
      if (definitive) { try { update({ ...current.current, pending: undefined }); } catch { /* Keep the original request when storage is unavailable. */ } }
      if (mounted.current) setError(`${definitive ? "Comment was not posted" : "Could not confirm the comment"}: ${cause instanceof Error ? cause.message : String(cause)}${definitive ? ". Your draft is retained." : ". Recovery keeps the same request and original head."}`);
    } finally { active.current = false; if (mounted.current) setBusy(false); }
  };
  const target = draft.pending?.location ?? location;
  return <form aria-label="New PR comment" aria-busy={busy} className="max-h-[45dvh] min-w-0 shrink-0 space-y-2 overflow-y-auto border-b bg-card p-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <p className="break-all font-mono text-xs">{target ? `${target.path} · ${target.diffSide === "RIGHT" ? "new" : "old"} lines ${target.startLine}–${target.line}` : "Select lines in a published PR diff."}</p>
    <label htmlFor={id} className="block text-xs font-semibold">Comment on #{prNumber}</label>
    <Textarea ref={textarea} id={id} value={draft.body} readOnly={!!draft.pending} disabled={busy} maxLength={16000} onChange={event => { try { update({ ...current.current, body: event.target.value }); } catch { setError("Your browser could not save this draft. Nothing was sent."); } }} className="min-h-24" placeholder="Write a review comment…" />
    <label className="flex items-center gap-2 text-xs"><Checkbox checked={draft.ask} disabled={!onAsk || busy || !!draft.pending} onCheckedChange={value => { try { update({ ...current.current, ask: value === true }); } catch { setError("Your browser could not save this choice."); } }} />Also ask Harness to address it</label>
    {onAsk && <p className="text-xs text-muted-foreground">After posting, this adds a reference to your conversation draft.</p>}
    {draft.pending && <p role="status" className="text-xs text-muted-foreground">A comment is awaiting confirmation. Recover its original file, lines, body and head before starting another.</p>}
    {!canStart && !draft.pending && <p className="text-xs text-muted-foreground">New comments require an open, current published PR and a complete selected range.</p>}
    <div className="flex flex-wrap gap-2"><Button size="sm" type="submit" disabled={busy || (!draft.pending && (!canStart || !location || !draft.body.trim()))}>{busy ? "Posting…" : draft.pending ? "Recover comment" : "Post comment"}</Button><Button size="sm" type="button" variant="ghost" disabled={busy} onClick={onClose}>Close comment</Button></div>
    {error && <p role="alert" className="text-xs text-destructive-foreground wrap-anywhere">{error}</p>}
  </form>;
}
