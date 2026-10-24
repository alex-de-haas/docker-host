"use client";

import { useId, useRef, useState } from "react";
import { Bot, ExternalLink, MessageSquare, Sparkles } from "lucide-react";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { reviewThreadLocation, type ReviewThread, type ReviewThreadComment } from "@/lib/review-threads";

export type ReviewThreadActions = {
  onThreadAsk?: (thread: ReviewThread) => void;
  onResolve?: (thread: ReviewThread, requestId: string) => Promise<void>;
  onReply?: (thread: ReviewThread, body: string, requestId: string) => Promise<void>;
  threadActionsUnavailable?: string;
  canStartThreadActions?: boolean;
  threadStorageScope?: string;
};

export class ReviewThreadActionError extends Error {
  readonly definitive: boolean;
  constructor(message: string, definitive = false) { super(message); this.name = "ReviewThreadActionError"; this.definitive = definitive; }
}

type Draft = { body: string; reply?: { body: string; requestId: string }; resolve?: { requestId: string } };
const storageKey = (id: string, scope?: string) => `hosty.review-thread.${scope ? `${scope}.` : ""}${id}`;
function readDraft(id: string, scope?: string): Draft {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey(id, scope)) ?? "null");
    if (!value || typeof value !== "object" || !("body" in value) || typeof value.body !== "string") return { body: "" };
    const draft: Draft = { body: value.body };
    if ("reply" in value && value.reply && typeof value.reply === "object" && "body" in value.reply && typeof value.reply.body === "string" && "requestId" in value.reply && typeof value.reply.requestId === "string") draft.reply = { body: value.reply.body, requestId: value.reply.requestId };
    if ("resolve" in value && value.resolve && typeof value.resolve === "object" && "requestId" in value.resolve && typeof value.resolve.requestId === "string") draft.resolve = { requestId: value.resolve.requestId };
    return draft;
  } catch { return { body: "" }; }
}
function saveDraft(id: string, draft: Draft, scope?: string) {
  try {
    if (!draft.body && !draft.reply && !draft.resolve) sessionStorage.removeItem(storageKey(id, scope));
    else sessionStorage.setItem(storageKey(id, scope), JSON.stringify(draft));
  } catch { /* The mounted card still retains its draft and replay identifiers. */ }
}
function webLink(value?: string | null): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined; } catch { return undefined; }
}
function Comment({ comment }: { comment: ReviewThreadComment }) {
  const date = comment.createdAt ? new Date(comment.createdAt) : null;
  const validDate = date && !Number.isNaN(date.valueOf());
  const bot = comment.authorKind?.toLowerCase() === "bot";
  const url = webLink(comment.url);
  return <div className="min-w-0 space-y-2 px-3 py-3">
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="min-w-0 font-semibold wrap-anywhere">{comment.authorLogin || "Author unavailable"}</span>
      {comment.authorKind && <Badge variant="outline" className="gap-1 py-0">{bot && <Bot className="size-3" />}{bot ? "Bot" : "Reviewer"}</Badge>}
      {validDate && <time dateTime={date.toISOString()} className="tabular-nums text-muted-foreground">{date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>}
      {url && <a href={url} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 text-muted-foreground underline underline-offset-2">GitHub<ExternalLink className="size-3" /></a>}
    </div>
    <Markdown text={comment.body} className="min-w-0 text-sm wrap-anywhere [&_pre]:max-w-full [&_pre]:overflow-x-auto" />
  </div>;
}

export function ReviewThreadCard(props: { thread: ReviewThread } & ReviewThreadActions) {
  return <ThreadCard key={JSON.stringify([props.threadStorageScope, props.thread.id])} {...props} />;
}
function ThreadCard({ thread, onThreadAsk, onResolve, onReply, threadActionsUnavailable, canStartThreadActions = true, threadStorageScope }: { thread: ReviewThread } & ReviewThreadActions) {
  const textareaId = useId();
  const [draft, setDraft] = useState(() => readDraft(thread.id, threadStorageScope));
  const draftRef = useRef(draft);
  const [replyOpen, setReplyOpen] = useState(!!draft.body || !!draft.reply);
  const [busy, setBusy] = useState<"reply" | "resolve" | null>(null);
  const active = useRef(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const updateDraft = (next: Draft) => { draftRef.current = next; setDraft(next); saveDraft(thread.id, next, threadStorageScope); };
  const comments: ReviewThreadComment[] = thread.details?.length ? thread.details : thread.comments.map((body, index) => ({ id: `${thread.id}:${index}`, body }));
  const unavailable = threadActionsUnavailable || "This view cannot publish review changes. Open the thread on GitHub to reply or resolve it.";
  async function reply() {
    if (!onReply || active.current || (!draftRef.current.reply && (!canStartThreadActions || !draftRef.current.body.trim()))) return;
    const request = draftRef.current.reply ?? { body: draftRef.current.body.trim(), requestId: crypto.randomUUID() };
    updateDraft({ ...draftRef.current, reply: request });
    active.current = true; setBusy("reply"); setFailure(null); setNotice(null);
    try {
      await onReply(thread, request.body, request.requestId);
      updateDraft({ ...draftRef.current, body: "", reply: undefined }); setReplyOpen(false); setNotice("Reply posted.");
    } catch (error) {
      const definitive = error instanceof ReviewThreadActionError && error.definitive;
      if (definitive) updateDraft({ ...draftRef.current, reply: undefined });
      setFailure(`${definitive ? "Reply was not posted" : "Could not confirm the reply"}: ${error instanceof Error ? error.message : String(error)}${definitive ? " Your draft is retained." : " Retry keeps the same request."}`);
    }
    finally { active.current = false; setBusy(null); }
  }
  async function resolve() {
    if (!onResolve || active.current || (!draftRef.current.resolve && (thread.resolved || !canStartThreadActions))) return;
    const request = draftRef.current.resolve ?? { requestId: crypto.randomUUID() };
    updateDraft({ ...draftRef.current, resolve: request });
    active.current = true; setBusy("resolve"); setFailure(null); setNotice(null);
    try {
      await onResolve(thread, request.requestId);
      updateDraft({ ...draftRef.current, resolve: undefined }); setNotice("Thread resolved.");
    } catch (error) {
      const definitive = error instanceof ReviewThreadActionError && error.definitive;
      if (definitive) updateDraft({ ...draftRef.current, resolve: undefined });
      setFailure(`${definitive ? "Thread was not resolved" : "Could not confirm resolution"}: ${error instanceof Error ? error.message : String(error)}${definitive ? "" : " Retry keeps the same request."}`);
    }
    finally { active.current = false; setBusy(null); }
  }
  return <article aria-label={`Review thread ${thread.id}`} aria-busy={busy !== null} className="min-w-0 overflow-hidden rounded-xl border bg-card font-sans text-foreground shadow-sm">
    <div className="space-y-2 border-b bg-muted/25 px-3 py-2 text-xs">
      <div className="flex min-w-0 items-start gap-2"><MessageSquare className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 break-all font-mono text-xs text-muted-foreground">{reviewThreadLocation(thread)}</span></div>
      <div className="flex flex-wrap items-center gap-2"><Badge variant="outline" className={thread.resolved ? "text-muted-foreground" : "border-warning-foreground/30 bg-warning-soft text-warning-foreground"}>{thread.resolved ? "Resolved" : "Unresolved"}</Badge>
      {thread.changedLocally && <Badge variant="outline" className="border-info-foreground/30 bg-info-soft text-info-foreground" title="Local changes overlap this thread. This does not resolve the review.">Changed locally</Badge>}
      </div>
    </div>
    <div className="divide-y">{comments.length ? comments.map(comment => <Comment key={comment.id} comment={comment} />) : <p className="p-3 text-xs text-muted-foreground">Thread comments are unavailable.</p>}</div>
    {thread.commentsComplete !== true && <p role="status" className="border-t bg-warning-soft px-3 py-2 text-xs text-warning-foreground">{thread.commentsComplete === false ? "Some replies have not been loaded." : "Reply completeness is unavailable."} Open the full thread on GitHub.</p>}
    <div className="flex flex-wrap items-center gap-1 border-t px-2 py-1.5">
      <Button type="button" variant="ghost" size="sm" disabled={!onReply || (!canStartThreadActions && !draft.reply) || busy !== null} title={!onReply || !canStartThreadActions ? unavailable : undefined} aria-expanded={replyOpen} aria-controls={textareaId} onClick={() => setReplyOpen(open => !open)}>Reply</Button>
      {(!thread.resolved || draft.resolve) && <Button type="button" variant="ghost" size="sm" disabled={!onResolve || (!canStartThreadActions && !draft.resolve) || busy !== null} title={!onResolve || !canStartThreadActions ? unavailable : undefined} onClick={() => void resolve()}>{busy === "resolve" ? "Resolving…" : draft.resolve ? "Retry resolve" : "Resolve"}</Button>}
      {onThreadAsk && <Button type="button" variant="ghost" size="sm" onClick={() => onThreadAsk(thread)}><Sparkles className="size-3.5" />Ask Harness</Button>}
    </div>
    {(!canStartThreadActions || !onReply || (!thread.resolved && !onResolve)) && <p className="px-3 pb-2 text-xs text-muted-foreground">{unavailable}</p>}
    {replyOpen && <form className="min-w-0 space-y-2 border-t p-3" onSubmit={event => { event.preventDefault(); void reply(); }}>
      <label htmlFor={textareaId} className="text-xs font-semibold">Reply to review thread</label>
      <Textarea id={textareaId} value={draft.body} readOnly={!!draft.reply} disabled={busy !== null} onChange={event => updateDraft({ ...draftRef.current, body: event.target.value })} placeholder="Write a reply…" className="min-h-20" />
      {draft.reply && <p className="text-xs text-muted-foreground">This reply is awaiting confirmation. Retry submits the same reply and request.</p>}
      <div className="flex gap-2"><Button type="submit" size="sm" disabled={!onReply || busy !== null || (!draft.reply && (!canStartThreadActions || !draft.body.trim()))}>{busy === "reply" ? "Posting…" : draft.reply ? "Retry reply" : "Post reply"}</Button><Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => setReplyOpen(false)}>Close reply</Button></div>
    </form>}
    {failure && <p role="alert" className="border-t px-3 py-2 text-xs text-destructive-foreground wrap-anywhere">{failure}</p>}
    {notice && <p role="status" className="border-t px-3 py-2 text-xs text-muted-foreground">{notice}</p>}
  </article>;
}
