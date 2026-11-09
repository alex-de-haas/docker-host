"use client";
import { ArrowDown, ArrowUp, Loader2, Pause, Pencil, Play, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "./ui/button";
import type { MessageQueue as QueueSnapshot, QueueCommand, QueueEntry } from "@/lib/message-queue-api";
import type { OutboxEntry } from "@/lib/message-outbox";
import type { PendingSend } from "@/lib/pending-send";

export function queueFileLabel(name: string): string {
  if (!/^q-[a-f0-9-]{36}-/i.test(name)) return name;
  return name.replace(/^(?:q-)?[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}-/i, "")
    .replace(/^(?:q-)?[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}-/i, "")
    .replace(/^q-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}-/i, "");
}
export function MessageQueue({ queue, outbox, transcriptRequestIds, busy, editingId, viewId, error, pendingOperation, legacySend, legacyBusy, onLegacyRetry,
  onCommand, onEdit, onRetryLocal, onRecoverLocal, onRetryOperation, onRefresh }: {
  queue: QueueSnapshot | null; outbox: OutboxEntry[]; transcriptRequestIds?: ReadonlySet<string>; busy: boolean; editingId?: string; viewId: string;
  error: string | null; pendingOperation: boolean; legacySend: PendingSend | null; legacyBusy: boolean;
  onCommand: (command: QueueCommand) => void; onEdit: (entry: QueueEntry, recover: boolean) => void;
  onRefresh: () => void; onRetryLocal: (id: string) => void; onRecoverLocal: (id: string) => void; onRetryOperation: () => void; onLegacyRetry: () => void;
}) {
  const visible = queue?.entries ?? [];
  const local = outbox.filter(row => !visible.some(entry => entry.id === row.id));
  if (!visible.length && !local.length && !legacySend && !error && !pendingOperation && !queue?.paused && !queue?.waiting) return null;
  return <section aria-label="Message queue" className="mx-3 mb-2 min-w-0 shrink-0 rounded-lg border bg-muted/20 text-sm">
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
      <span className="text-xs font-medium text-muted-foreground">{queue?.paused ? "Queue paused" : "Next messages"}</span>
      {!!visible.length && <Button type="button" variant="ghost" size="sm" disabled={busy || pendingOperation}
        onClick={() => onCommand({ type: queue?.paused ? "resume" : "pause" })}>
        {queue?.paused ? <Play /> : <Pause />}{queue?.paused ? "Resume queue" : "Pause queue"}
      </Button>}
    </div>
    {(queue?.waiting?.message || queue?.reason) && <p role="status" className="px-3 pt-2 text-xs text-muted-foreground">{queue.waiting?.message ?? queue.reason}</p>}
    <ol className="max-h-56 overflow-y-auto overscroll-contain divide-y" aria-label="Queued messages">
      {legacySend && <li className="flex items-start gap-2 px-3 py-2" aria-label="Previous send awaiting confirmation">
        {legacyBusy && <Loader2 className="mt-0.5 size-4 shrink-0 motion-safe:animate-spin" />}
        <div className="min-w-0 flex-1"><p className="line-clamp-3 whitespace-pre-wrap break-words">{legacySend.draftText || legacySend.text}</p>
          <p className="mt-1 text-xs text-muted-foreground">Checking the previous send preserves its original request.</p>
          <Button type="button" size="sm" variant="ghost" disabled={legacyBusy} onClick={onLegacyRetry}>Retry send</Button>
        </div>
      </li>}
      {visible.map((entry, index) => {
        const locked = entry.state === "sending" || entry.state === "unknown";
        const inTranscript = locked && !!entry.attempt && transcriptRequestIds?.has(entry.attempt.clientRequestId);
        const otherEditor = entry.state === "editing" && entry.edit?.viewId !== viewId;
        const editable = !locked && !otherEditor && entry.state !== "editing";
        const move = (offset: number) => {
          const ids = visible.map(row => row.id); [ids[index], ids[index + offset]] = [ids[index + offset]!, ids[index]!];
          onCommand({ type: "reorder", entryIds: ids });
        };
        return <li key={entry.id} className="flex min-w-0 items-start gap-2 px-3 py-2" aria-label={`Queued message ${index + 1}`}>
          {entry.state === "sending" && <Loader2 className="mt-0.5 size-4 shrink-0 motion-safe:animate-spin" aria-label="Sending message" />}
          <div className="min-w-0 flex-1">
            <p className="line-clamp-3 whitespace-pre-wrap break-words">{inTranscript ? "Message in conversation" : entry.text || "Attachments"}</p>
            {!inTranscript && !!entry.attachments.length && <p className="mt-1 truncate text-xs text-muted-foreground" title={entry.attachments.map(file => (file.displayName ?? queueFileLabel(file.name))).join(", ")}>{entry.attachments.map(file => (file.displayName ?? queueFileLabel(file.name))).join(" · ")}</p>}
            <p className="mt-1 text-xs text-muted-foreground">{entry.state === "sending" ? "Sending to agent…" : entry.state === "unknown" ? "Send not confirmed" : entry.state === "failed" ? "Could not send" : entry.state === "editing" ? otherEditor ? "Editing in another tab" : "Editing in composer" : "Waiting · uses current agent settings"}</p>
            {entry.error && <p role="alert" className="mt-1 text-xs text-destructive-foreground">{entry.error.message}</p>}
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {(entry.state === "failed" || entry.state === "unknown") && <Button type="button" variant="ghost" size="sm" disabled={busy || pendingOperation} onClick={() => onCommand({ type: "retry", entryId: entry.id })}><RotateCcw />Retry</Button>}
              {editable && <Button type="button" size="icon-sm" variant="ghost" disabled={busy || pendingOperation || !!editingId} aria-label={`Edit queued message ${index + 1}`} onClick={() => onEdit(entry, false)}><Pencil /></Button>}
              {otherEditor && <Button type="button" size="sm" variant="ghost" disabled={busy || pendingOperation || !!editingId} onClick={() => onEdit(entry, true)}>Recover edit</Button>}
              {editable && <>
                <Button type="button" size="icon-sm" variant="ghost" disabled={busy || pendingOperation || index === 0 || visible[index - 1]?.state !== "queued"} aria-label={`Move queued message ${index + 1} up`} onClick={() => move(-1)}><ArrowUp /></Button>
                <Button type="button" size="icon-sm" variant="ghost" disabled={busy || pendingOperation || index === visible.length - 1 || visible[index + 1]?.state !== "queued"} aria-label={`Move queued message ${index + 1} down`} onClick={() => move(1)}><ArrowDown /></Button>
                <Button type="button" size="icon-sm" variant="ghost" disabled={busy || pendingOperation} aria-label={`Delete queued message ${index + 1}`} onClick={() => onCommand({ type: "delete", entryId: entry.id })}><Trash2 /></Button>
              </>}
            </div>
          </div>
        </li>;
      })}
      {local.map(row => <li key={row.id} className="flex items-start gap-2 px-3 py-2" aria-label="Message saving to queue">
        {!row.error && <Loader2 className="mt-0.5 size-4 shrink-0 motion-safe:animate-spin" aria-hidden />}
        <div className="min-w-0 flex-1"><p className="line-clamp-3 whitespace-pre-wrap break-words">{row.draftText || row.text || "Attachments"}</p>
          <p className="mt-1 truncate text-xs text-muted-foreground">{[...row.attachments.map(file => (file.displayName ?? queueFileLabel(file.name))), ...row.files.map(file => file.name)].join(" · ")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{row.error ? "Not yet saved to server" : row.files.length ? "Uploading and saving…" : "Saving to queue…"}</p>
          {row.error && <><p role="alert" className="mt-1 text-xs text-destructive-foreground">{row.error}</p><Button type="button" size="sm" variant="ghost" onClick={() => onRetryLocal(row.id)}><RotateCcw />Retry</Button>
            {(!row.command || row.recoverable) && <Button type="button" size="sm" variant="ghost" onClick={() => onRecoverLocal(row.id)}>Recover draft</Button>}</>}
        </div>
      </li>)}
    </ol>
    {(error || pendingOperation) && <div className="border-t px-3 py-2 text-xs">
      {error && <p role="alert" className="text-destructive-foreground">{error}</p>}
      {error && !pendingOperation && <Button type="button" size="sm" variant="ghost" onClick={onRefresh}>Retry connection</Button>}
      {pendingOperation && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onRetryOperation}>{busy ? <Loader2 className="motion-safe:animate-spin" /> : <RotateCcw />}Retry queue change</Button>}
    </div>}
  </section>;
}
