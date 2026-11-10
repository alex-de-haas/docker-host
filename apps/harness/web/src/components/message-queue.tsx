"use client";
import { useRef, useState, type PointerEvent } from "react";
import { CircleAlert, GripVertical, Loader2, Paperclip, Pause, Pencil, Play, RotateCcw, Trash2, Undo2 } from "lucide-react";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";
import type { MessageQueue as QueueSnapshot, QueueCommand, QueueEntry } from "@/lib/message-queue-api";
import type { OutboxEntry } from "@/lib/message-outbox";
import type { PendingSend } from "@/lib/pending-send";

export function queueFileLabel(name: string): string {
  if (!/^q-[a-f0-9-]{36}-/i.test(name)) return name;
  return name.replace(/^(?:q-)?[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}-/i, "")
    .replace(/^(?:q-)?[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}-/i, "")
    .replace(/^q-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}-/i, "");
}
const movable = (entry: QueueEntry) => entry.state === "queued" || entry.state === "failed";
type QueueDrag = { pointerId: number; id: string; targetId: string | null; startY: number; signature: string };
function QueueAttachments({ names }: { names: string[] }) {
  return names.length ? <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground" title={names.join(", ")}
    aria-label={`${names.length} attachment${names.length === 1 ? "" : "s"}: ${names.join(", ")}`}><Paperclip className="size-3" aria-hidden />{names.length}</span> : null;
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
  const list = useRef<HTMLOListElement>(null);
  const drag = useRef<QueueDrag | null>(null);
  const [drop, setDrop] = useState<QueueDrag | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const signature = JSON.stringify([queue?.installationId, queue?.ownerId, viewId, queue?.revision, visible.map(row => [row.id, row.state]), busy, pendingOperation]);
  const canMove = (from: number, to: number) => !busy && !pendingOperation && from >= 0 && to >= 0 && to < visible.length
    && visible.slice(Math.min(from, to), Math.max(from, to) + 1).every(movable);
  const move = (id: string, targetId: string) => {
    const from = visible.findIndex(row => row.id === id), to = visible.findIndex(row => row.id === targetId);
    if (from === to || !canMove(from, to)) return;
    const ids = visible.map(row => row.id);
    ids.splice(from, 1); ids.splice(to, 0, id);
    onCommand({ type: "reorder", entryIds: ids });
    setAnnouncement(`Message moved to position ${to + 1} of ${visible.length}.`);
  };
  const cancelDrag = () => { drag.current = null; setDrop(null); };
  const pointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (current.signature !== signature) { cancelDrag(); return; }
    if (Math.abs(event.clientY - current.startY) < 4 && !drop) return;
    event.preventDefault();
    const bounds = list.current?.getBoundingClientRect();
    let targetId: string | null = null;
    if (bounds && event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom) {
      if (event.clientY < bounds.top + 20) list.current?.scrollBy?.(0, -12);
      else if (event.clientY > bounds.bottom - 20) list.current?.scrollBy?.(0, 12);
      const row = Array.from(list.current!.querySelectorAll<HTMLElement>("[data-queue-entry]")).find(row => {
        const rect = row.getBoundingClientRect(); return event.clientY >= rect.top && event.clientY < rect.bottom;
      });
      const candidate = row?.dataset.queueEntry;
      if (candidate && canMove(visible.findIndex(row => row.id === current.id), visible.findIndex(row => row.id === candidate))) targetId = candidate;
    }
    drag.current = { ...current, targetId }; setDrop(drag.current);
  };
  const activeDrop = drop?.signature === signature ? drop : null;
  if (!visible.length && !local.length && !legacySend && !error && !pendingOperation && !queue?.paused && !queue?.waiting) return null;
  return <section aria-label="Message queue" className="@container/queue mx-3 mb-2 min-w-0 shrink-0 rounded-lg border bg-muted/20 text-sm">
    <p className="sr-only" role="status">{announcement}</p>
    <div className="flex min-w-0 items-center justify-between gap-2 border-b px-3 py-1">
      <span className="text-xs font-medium text-muted-foreground">{queue?.paused ? "Queue paused" : "Next messages"}</span>
      {!!visible.length && <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" disabled={busy || pendingOperation}
        onClick={() => onCommand({ type: queue?.paused ? "resume" : "pause" })}>
        {queue?.paused ? <Play /> : <Pause />}{queue?.paused ? "Resume queue" : "Pause queue"}
      </Button>}
    </div>
    {(queue?.waiting?.message || (queue?.reason && queue.reason !== "Queue paused")) && <p role="status" className="truncate px-3 py-1 text-xs text-muted-foreground" title={queue.waiting?.message ?? queue.reason}>{queue.waiting?.message ?? queue.reason}</p>}
    <ol ref={list} className="max-h-56 overflow-y-auto overscroll-contain divide-y" aria-label="Queued messages">
      {legacySend && <li className="flex min-w-0 items-center gap-2 px-3 py-1" aria-label="Previous send awaiting confirmation">
        {legacyBusy && <Loader2 className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden />}
        <p className="min-w-0 flex-1 truncate">{legacySend.draftText || legacySend.text}</p>
        <span className="sr-only">Checking the previous send preserves its original request.</span>
        <Button type="button" size="sm" className="h-7 text-xs" variant="ghost" disabled={legacyBusy} onClick={onLegacyRetry}>Retry send</Button>
      </li>}
      {visible.map((entry, index) => {
        const locked = entry.state === "sending" || entry.state === "unknown";
        const inTranscript = locked && !!entry.attempt && transcriptRequestIds?.has(entry.attempt.clientRequestId);
        const otherEditor = entry.state === "editing" && entry.edit?.viewId !== viewId;
        const editable = !locked && !otherEditor && entry.state !== "editing";
        const status = entry.state === "sending" ? "Sending to agent…" : entry.state === "unknown" ? "Send not confirmed" : entry.state === "failed" ? "Could not send" : entry.state === "editing" ? otherEditor ? "Editing in another tab" : "Editing in composer" : "";
        const dropTarget = activeDrop?.targetId === entry.id && activeDrop.id !== entry.id;
        return <li key={entry.id} data-queue-entry={entry.id} className={cn("group/queue-row relative flex min-w-0 items-center gap-2 px-2 py-1",
          activeDrop?.id === entry.id && "opacity-50", dropTarget && "bg-accent")}
          aria-label={`Queued message ${index + 1}`}>
          {dropTarget && <span aria-hidden className={cn("pointer-events-none absolute inset-x-2 h-0.5 bg-ring", visible.findIndex(row => row.id === activeDrop.id) < index ? "bottom-0" : "top-0")} />}
          <Button type="button" size="icon-sm" variant="ghost" className="size-7 touch-none cursor-grab text-muted-foreground active:cursor-grabbing"
            disabled={!movable(entry) || busy || pendingOperation || !(canMove(index, index - 1) || canMove(index, index + 1))}
            aria-label={`Reorder queued message ${index + 1}`} aria-description="Drag to reorder, or use the Up and Down arrow keys."
            title="Drag to reorder · ↑ / ↓"
            onPointerDown={event => {
              if (event.button !== 0 || event.isPrimary === false) return;
              event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { pointerId: event.pointerId, id: entry.id, targetId: null, startY: event.clientY, signature };
            }}
            onPointerMove={pointerMove}
            onPointerUp={event => {
              const current = drag.current;
              if (current?.pointerId !== event.pointerId) return;
              cancelDrag(); event.currentTarget.releasePointerCapture(event.pointerId);
              if (current.signature === signature && current.targetId) move(current.id, current.targetId);
            }}
            onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}
            onKeyDown={event => {
              if (event.key === "Escape") { event.preventDefault(); cancelDrag(); return; }
              const offset = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
              if (offset) { event.preventDefault(); cancelDrag(); const target = visible[index + offset]; if (target) move(entry.id, target.id); }
            }}><GripVertical /></Button>
          {entry.state === "sending" && <Loader2 className="size-3.5 shrink-0 motion-safe:animate-spin" aria-label="Sending message" />}
          <p className="min-w-0 flex-[3_1_0%] truncate">{inTranscript ? "Message in conversation" : entry.text || "Attachments"}</p>
          {!inTranscript && <QueueAttachments names={entry.attachments.map(file => file.displayName ?? queueFileLabel(file.name))} />}
          {status && <span className="min-w-0 max-w-28 flex-[1_1_0%] truncate text-xs text-muted-foreground" title={status}>{status}</span>}
          {entry.error && <span role="alert" className="shrink-0 text-destructive-foreground" title={entry.error.message}><CircleAlert className="size-4" aria-hidden /><span className="sr-only">{entry.error.message}</span></span>}
          {(entry.state === "failed" || entry.state === "unknown") && <Button type="button" variant="ghost" size="sm" className="size-7 p-0 text-xs @sm/queue:w-auto @sm/queue:px-1.5" title="Retry" disabled={busy || pendingOperation} onClick={() => onCommand({ type: "retry", entryId: entry.id })}><RotateCcw /><span className="sr-only @sm/queue:not-sr-only">Retry</span></Button>}
          {otherEditor && <Button type="button" size="sm" className="h-7 px-1.5 text-xs" variant="ghost" disabled={busy || pendingOperation || !!editingId} onClick={() => onEdit(entry, true)}>Recover edit</Button>}
          {editable && <div className="flex shrink-0 items-center gap-0.5 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/queue-row:opacity-100 [@media(hover:hover)]:group-focus-within/queue-row:opacity-100">
            <Button type="button" size="icon-sm" className="size-7" variant="ghost" disabled={busy || pendingOperation || !!editingId} aria-label={`Edit queued message ${index + 1}`} title="Edit message" onClick={() => onEdit(entry, false)}><Pencil /></Button>
            <Button type="button" size="icon-sm" className="size-7" variant="ghost" disabled={busy || pendingOperation} aria-label={`Delete queued message ${index + 1}`} title="Delete message" onClick={() => onCommand({ type: "delete", entryId: entry.id })}><Trash2 /></Button>
          </div>}
        </li>;
      })}
      {local.map(row => <li key={row.id} className="flex min-w-0 items-center gap-2 px-3 py-1" aria-label="Message saving to queue">
        {!row.error && <Loader2 className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden />}
        <p className="min-w-0 flex-[3_1_0%] truncate">{row.draftText || row.text || "Attachments"}</p>
        <QueueAttachments names={[...row.attachments.map(file => file.displayName ?? queueFileLabel(file.name)), ...row.files.map(file => file.name)]} />
        <span className="min-w-0 max-w-28 flex-[1_1_0%] truncate text-xs text-muted-foreground" title={row.error ? "Not yet saved to server" : row.files.length ? "Uploading and saving…" : "Saving to queue…"}>{row.error ? "Not yet saved to server" : row.files.length ? "Uploading and saving…" : "Saving to queue…"}</span>
        {row.error && <><span role="alert" title={row.error} className="shrink-0 text-destructive-foreground"><CircleAlert className="size-4" aria-hidden /><span className="sr-only">{row.error}</span></span><Button type="button" size="sm" className="size-7 p-0 text-xs @sm/queue:w-auto @sm/queue:px-1.5" title="Retry" variant="ghost" onClick={() => onRetryLocal(row.id)}><RotateCcw /><span className="sr-only @sm/queue:not-sr-only">Retry</span></Button>
          {(!row.command || row.recoverable) && <Button type="button" size="sm" className="size-7 p-0 text-xs @sm/queue:w-auto @sm/queue:px-1.5" title="Recover draft" variant="ghost" onClick={() => onRecoverLocal(row.id)}><Undo2 /><span className="sr-only @sm/queue:not-sr-only">Recover draft</span></Button>}</>}
      </li>)}
    </ol>
    {(error || pendingOperation) && <div className="border-t px-3 py-2 text-xs">
      {error && <p role="alert" className="text-destructive-foreground">{error}</p>}
      {error && !pendingOperation && <Button type="button" size="sm" variant="ghost" onClick={onRefresh}>Retry connection</Button>}
      {pendingOperation && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onRetryOperation}>{busy ? <Loader2 className="motion-safe:animate-spin" /> : <RotateCcw />}Retry queue change</Button>}
    </div>}
  </section>;
}
