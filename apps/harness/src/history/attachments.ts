import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import type { SessionStore } from "../sessions/store.js";
import { fingerprint } from "./projection.js";
import { fail, missing } from "./storage.js";

const stamp = (info: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }) => BigInt("0x" + fingerprint([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]).slice(0, 32)).toString();
/** Open a regular source-owned cache file without following a tool-created link. No path leaves Harness. */
export async function attachmentFile(sessions: SessionStore, conversation: string, name: string, read?: { revision: string; offset: number; length: number }) {
  let target: string | null;
  try { target = sessions.attachmentPath(conversation, name); } catch { return missing(); }
  if (!target) return missing();
  try {
    let parent = path.dirname(target);
    for (let depth = 0; depth < 3; depth++, parent = path.dirname(parent)) {
      const info = await lstat(parent); if (!info.isDirectory() || info.isSymbolicLink()) return missing();
    }
    const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await file.stat(); if (!before.isFile() || before.size > 25 * 1024 * 1024) return missing();
      const revision = stamp(before);
      if (!read) return { attachmentId: name, revision, name, mediaType: "application/octet-stream", sizeBytes: before.size };
      if (revision !== read.revision) fail("revision_conflict", "The attachment content changed.", 409);
      if (!Number.isSafeInteger(read.offset) || !Number.isSafeInteger(read.length) || read.offset < 0 || read.length < 0 || read.length > 1024 * 1024 || read.offset + read.length > before.size) fail("invalid_range", "Use one available range of at most 1 MiB.", 416);
      const bytes = Buffer.alloc(read.length); let offset = 0;
      while (offset < read.length) {
        const result = await file.read(bytes, offset, read.length - offset, read.offset + offset); if (!result.bytesRead) break; offset += result.bytesRead;
      }
      if (offset !== read.length || stamp(await file.stat()) !== revision) fail("revision_conflict", "The attachment changed while reading.", 409);
      return bytes;
    } finally { await file.close(); }
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return missing(); throw error;
  }
}
