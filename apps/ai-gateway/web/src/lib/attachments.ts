import type { AssistantEvent } from "./assistant-api";

/**
 * What the whole log says about the session's uploads, so every file is drawn exactly once.
 *
 * Adjacency cannot carry this. `attachment_added` is written when the upload lands, and the message
 * that claims the file is a separate request: usually the next event, but not when a message POST is
 * retried after other events, and not when a client references a file some earlier turn stored. So
 * the association is read from the log as a whole rather than from what happens to sit next to what.
 */
export type AttachmentIndex = {
  /** Stored names some `user_message` references; their upload rows defer to that message. */
  claimed: ReadonlySet<string>;
  /** Stored size per name, from the upload event that recorded it. */
  sizes: ReadonlyMap<string, number>;
};

/**
 * The files an operator just chose in a file input, with the input reset so choosing the same file
 * again fires `change` again.
 *
 * The order is the point. `files` is a live view of the input: resetting `value` empties it. A
 * caller that hands `input.files` to a React functional updater and then resets the input reads the
 * list only when React flushes — after the reset — and gets nothing. This copies first, in the
 * handler itself, so what is returned is what was chosen.
 */
export function takeChosenFiles(input: Pick<HTMLInputElement, "files" | "value">): File[] {
  const chosen = Array.from(input.files ?? []);
  input.value = "";
  return chosen;
}

/**
 * Which uploaded file belongs to which message, and how big each one was.
 *
 * Read from the whole log rather than from adjacency. `attachment_added` is written when the upload
 * request lands; the message that claims the file is a separate request, so the two are only usually
 * neighbours — a message POST retried after other events, or a client naming a file an earlier turn
 * stored, puts events between them. A name in `claimed` is drawn under its message, which is the
 * only event that knows the association; every other upload keeps a row of its own.
 */
export function indexAttachments(events: readonly AssistantEvent[]): AttachmentIndex {
  const claimed = new Set<string>();
  const sizes = new Map<string, number>();
  for (const event of events) {
    if (event.type === "user_message" && Array.isArray(event.attachments)) {
      for (const name of event.attachments) {
        claimed.add(String(name));
      }
    } else if (event.type === "attachment_added") {
      sizes.set(String(event.name ?? ""), Number(event.size ?? 0));
    }
  }
  return { claimed, sizes };
}
