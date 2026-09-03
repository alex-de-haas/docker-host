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
 * The stored name for what the operator called the file: a safe subset, never a path.
 *
 * The original name is metadata the transcript keeps; this is the only form that touches the
 * filesystem. Anything that could be a separator, a parent reference, or a control character is
 * dropped rather than escaped, and a name with nothing left is refused rather than invented.
 */
export function sanitizeAttachmentName(original: string): string | null {
  const base = path.basename(original.replace(/\\/g, "/"));
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (!cleaned || cleaned.length > 120) {
    return null;
  }
  return cleaned;
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
