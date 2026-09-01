"use client";

import { useRef, useState } from "react";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { isWaiting } from "@/lib/attention";
import { cn } from "@/lib/utils";
import type { AssistantSession } from "@/lib/assistant-api";

// The session picker. Its own file since rows became editable: a row is now a composite — open,
// rename, and the waiting marker — rather than one button, and the page was carrying it.

export function SessionList({
  sessions,
  activeId,
  onPick,
  onRename,
  onDelete,
}: {
  sessions: AssistantSession[];
  activeId: string | null;
  onPick: (session: AssistantSession) => void;
  onRename: (sessionId: string, title: string) => Promise<void>;
  onDelete: (sessionId: string) => Promise<void>;
}) {
  // Which row is being renamed, not what it says: the input owns its own text, so a reordering of
  // the list mid-edit cannot move someone's half-typed name onto another session.
  const [editingId, setEditingId] = useState<string | null>(null);
  // Deleting takes the transcript with it and nothing brings it back, so it asks first — in the row
  // rather than in a modal, which keeps the name of what is about to go next to the confirmation.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  if (sessions.length === 0) {
    return <p className="p-3 text-xs text-muted-foreground">No sessions yet.</p>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      {sessions.map((record) => (
        <div
          key={record.id}
          className={cn(
            "group flex items-center gap-1 rounded-md pr-1 transition-colors hover:bg-muted",
            record.id === activeId && "bg-muted",
          )}
        >
          {confirmingId === record.id ? (
            <div className="flex min-w-0 flex-1 items-center gap-1 px-2 py-1.5">
              <span className="min-w-0 flex-1 truncate text-sm">
                Delete “{record.title || "Untitled session"}”?
              </span>
              <button
                type="button"
                aria-label="Confirm delete"
                onClick={() => {
                  setConfirmingId(null);
                  void onDelete(record.id);
                }}
                className="shrink-0 rounded-md p-1.5 text-destructive hover:bg-destructive/10"
              >
                <Check className="h-3.5 w-3.5" aria-hidden />
              </button>
              <button
                type="button"
                aria-label="Keep session"
                onClick={() => setConfirmingId(null)}
                className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          ) : editingId === record.id ? (
            <SessionTitleInput
              title={record.title ?? ""}
              onCommit={async (title) => {
                setEditingId(null);
                await onRename(record.id, title);
              }}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <>
              <button
                type="button"
                onClick={() => onPick(record)}
                className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left"
              >
                <div className="truncate text-sm">{record.title || "Untitled session"}</div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {isWaiting(record.status) && (
                    // Marked as well as ordered: ordering alone is invisible to someone who has not seen the
                    // list before, and the row has to say *why* it is first.
                    <span className="inline-flex size-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden />
                  )}
                  <span>{new Date(record.createdAt).toLocaleString()}</span>
                  <span aria-hidden>·</span>
                  <span className={cn(isWaiting(record.status) && "font-medium text-amber-600 dark:text-amber-500")}>
                    {isWaiting(record.status) ? "waiting for you" : record.status}
                  </span>
                </div>
              </button>
              {/* Kept out of the row button rather than inside it: a button within a button is invalid,
                  and the rename must not double as "open this session". Focus reveals it too, so it is
                  reachable without a pointer. */}
              <button
                type="button"
                aria-label={`Rename ${record.title || "session"}`}
                onClick={() => setEditingId(record.id)}
                className="shrink-0 rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden />
              </button>
              <button
                type="button"
                aria-label={`Delete ${record.title || "session"}`}
                onClick={() => setConfirmingId(record.id)}
                className="shrink-0 rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function SessionTitleInput({
  title,
  onCommit,
  onCancel,
}: {
  title: string;
  onCommit: (title: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(title);
  // An edit ends exactly once. Enter, Escape and blur are three ways into the same ending, and
  // whether a browser also fires blur while the input is being removed is not something to depend
  // on: without this, Escape could still commit what it discarded, and Enter could send the rename
  // twice.
  const settled = useRef(false);
  const settle = (end: () => void) => {
    if (settled.current) {
      return;
    }
    settled.current = true;
    end();
  };

  return (
    <input
      autoFocus
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          settle(() => void onCommit(value));
        }
        if (event.key === "Escape") {
          event.preventDefault();
          settle(onCancel);
        }
      }}
      // Blur commits rather than discards: clicking away from a name you just typed reads as
      // finishing, and losing it would be the same theft as dropping a draft.
      onBlur={() => settle(() => void onCommit(value))}
      placeholder="Name this session…"
      className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus-visible:border-ring"
    />
  );
}
