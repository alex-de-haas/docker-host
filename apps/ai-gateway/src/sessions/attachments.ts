import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// What an operator may hand a session, and what happens to the name they gave it.
//
// The caps are the operator's numbers (docs/features/assistant-attachments/plan.md, Decisions). The
// per-session byte cap is the one guarding something real: the workspace lives under the cache root,
// which is never backed up but is disk on the host, and a session nobody deletes holds it until the
// retention sweep does. The other two exist so one upload cannot spend the whole allowance.
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_SESSION = 20;
export const MAX_SESSION_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export type AttachmentInfo = { name: string; size: number };

export type AttachmentRefusal =
  | { code: "attachment_too_large"; limit: number }
  | { code: "too_many_attachments"; limit: number }
  | { code: "session_attachments_too_large"; limit: number }
  | { code: "attachment_name_invalid" };

export class AttachmentRefusedError extends Error {
  constructor(readonly refusal: AttachmentRefusal) {
    super(refusal.code);
  }
}

/**
 * The longest stored name, in bytes: comfortably under the 255-byte limit common to filesystems,
 * measured in bytes rather than characters because a Cyrillic or CJK letter is two or three of them
 * and a character count would let a name through that the filesystem then refuses.
 */
export const MAX_ATTACHMENT_NAME_BYTES = 200;

/**
 * The stored name for what the operator called the file: never a path, and still their name.
 *
 * Letters and digits in any script are kept — an operator whose files are named in Russian must not
 * get `______.png` back for every one of them, which is what an ASCII-only subset did. What goes is
 * anything that could be a separator or a parent reference, control characters, and the characters
 * shells and URLs treat specially. A name that is too long is cut to fit, extension kept, rather
 * than refused: length is not a reason to lose the file. Refusal is reserved for a name with nothing
 * usable left, and that was the only case the old message was ever accurate about.
 */
export function sanitizeAttachmentName(original: string): string | null {
  const base = path.basename(original.replace(/\\/g, "/"));
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{M}\p{N}._ \-()]/gu, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (!cleaned) {
    return null;
  }
  return fitToBytes(cleaned, MAX_ATTACHMENT_NAME_BYTES);
}

/**
 * Cuts a name to fit `maxBytes`, on character boundaries, keeping the extension when a non-hidden
 * stem of at least one character fits beside it and dropping it otherwise.
 *
 * Two invariants, both asserted: the result is never over the cap, and never dot-prefixed — a
 * dot-prefixed file is one `listAttachments` treats as hidden, so it would take quota without ever
 * being listed. An extension long enough to leave no room for a stem is not an extension worth
 * keeping; the name is cut as a whole instead.
 */
export function fitToBytes(name: string, maxBytes: number): string {
  if (Buffer.byteLength(name) <= maxBytes) {
    return name;
  }
  const extension = path.extname(name);
  // Four bytes is the widest single character; the extension stays only if one of those fits too.
  const keepExtension = extension.length > 0 && Buffer.byteLength(extension) + 4 <= maxBytes;
  const stem = keepExtension ? name.slice(0, name.length - extension.length) : name;
  const room = keepExtension ? maxBytes - Buffer.byteLength(extension) : maxBytes;
  const kept = takeBytes(stem, room).trimEnd().replace(/^\.+/, "");
  const fitted = `${kept || "attachment"}${keepExtension ? extension : ""}`;
  // The fallback stem can only overshoot when the extension left less room than its ten bytes.
  return Buffer.byteLength(fitted) <= maxBytes ? fitted : takeBytes(fitted, maxBytes).replace(/^\.+/, "") || "attachment";
}

/** The longest prefix of `text` within `maxBytes`, never splitting a character. */
function takeBytes(text: string, maxBytes: number): string {
  let kept = "";
  for (const char of Array.from(text)) {
    if (Buffer.byteLength(kept + char) > maxBytes) {
      break;
    }
    kept += char;
  }
  return kept;
}

/** A name that is not already taken: `report.log`, then `report (2).log`, and so on. */
export function dedupeAttachmentName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) {
    return name;
  }
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${extension}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

export async function listAttachments(workspace: string): Promise<AttachmentInfo[]> {
  let entries;
  try {
    entries = await readdir(workspace, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files: AttachmentInfo[] = [];
  for (const entry of entries) {
    // Only what was uploaded is an attachment. The harness may write anything else into its cwd,
    // and a temp file from an upload that failed mid-stream is not an attachment either.
    if (!entry.isFile() || entry.name.startsWith(".")) {
      continue;
    }
    files.push({ name: entry.name, size: (await stat(path.join(workspace, entry.name))).size });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Writes an upload into the workspace under a sanitised, de-duplicated name.
 *
 * Every cap is checked before a byte is written, against what the caller declared; the byte cap is
 * checked again while streaming, against what actually arrived, since a client can declare one
 * length and send another. The stream lands under a dotted temp name and is renamed into place
 * only once complete, so a failed upload never leaves a partial file under the name a later turn
 * would read.
 */
// One upload at a time per workspace. Two concurrent PUTs reading the same listing would pick the
// same de-duplicated name and rename onto one path — the second silently replacing the first while
// both returned 201 — and two with different names would both pass the caps from the same stale
// snapshot. A single process owns each workspace, so a promise chain per path is the whole lock.
const workspaceLocks = new Map<string, Promise<unknown>>();

async function withWorkspaceLock<T>(workspace: string, work: () => Promise<T>): Promise<T> {
  const previous = workspaceLocks.get(workspace) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(work);
  workspaceLocks.set(workspace, run);
  try {
    return await run;
  } finally {
    if (workspaceLocks.get(workspace) === run) {
      workspaceLocks.delete(workspace);
    }
  }
}

export async function storeAttachment(
  workspace: string,
  originalName: string,
  declaredBytes: number,
  body: Readable,
): Promise<AttachmentInfo> {
  const safe = sanitizeAttachmentName(originalName);
  if (safe === null) {
    throw new AttachmentRefusedError({ code: "attachment_name_invalid" });
  }
  if (declaredBytes > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentRefusedError({ code: "attachment_too_large", limit: MAX_ATTACHMENT_BYTES });
  }

  return withWorkspaceLock(workspace, () => storeUnderLock(workspace, safe, declaredBytes, body));
}

async function storeUnderLock(
  workspace: string,
  safe: string,
  declaredBytes: number,
  body: Readable,
): Promise<AttachmentInfo> {
  await mkdir(workspace, { recursive: true });
  const existing = await listAttachments(workspace);
  if (existing.length >= MAX_ATTACHMENTS_PER_SESSION) {
    throw new AttachmentRefusedError({ code: "too_many_attachments", limit: MAX_ATTACHMENTS_PER_SESSION });
  }
  const used = existing.reduce((sum, file) => sum + file.size, 0);
  if (used + declaredBytes > MAX_SESSION_ATTACHMENT_BYTES) {
    throw new AttachmentRefusedError({
      code: "session_attachments_too_large",
      limit: MAX_SESSION_ATTACHMENT_BYTES,
    });
  }

  const name = dedupeAttachmentName(safe, new Set(existing.map((file) => file.name)));
  const finalPath = path.join(workspace, name);
  const tempPath = path.join(workspace, `.upload-${process.pid}-${Date.now()}-${name}`);

  let received = 0;
  const guard = async function* (source: Readable): AsyncGenerator<Buffer> {
    for await (const chunk of source) {
      received += (chunk as Buffer).length;
      if (received > MAX_ATTACHMENT_BYTES) {
        throw new AttachmentRefusedError({ code: "attachment_too_large", limit: MAX_ATTACHMENT_BYTES });
      }
      yield chunk as Buffer;
    }
  };

  try {
    await pipeline(guard(body), createWriteStream(tempPath, { flags: "wx" }));
    await rename(tempPath, finalPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }

  return { name, size: received };
}
