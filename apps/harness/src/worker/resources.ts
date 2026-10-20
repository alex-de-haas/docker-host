import path from "node:path";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, link, realpath, writeFile, unlink, open } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { safeIdentity, WorkerApiError } from "./contracts.js";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export async function conversationDirectory(cache: string, id: string): Promise<string> {
  if (!safeIdentity(id)) throw new WorkerApiError(400, "invalid_conversation", "Invalid conversation identity.");
  const root = path.join(cache, "conversations"), candidate = path.join(root, id);
  await mkdir(candidate, { recursive: true });
  if (path.dirname(await realpath(candidate)) !== await realpath(root)) throw new WorkerApiError(400, "invalid_resource", "Conversation storage redirects outside its root.");
  return candidate;
}
export async function storeAttachment(cache: string, id: string, name: string, request: IncomingMessage): Promise<{ path: string; hash: string }> {
  if (!name || name.startsWith(".") || /[\\/\0]/.test(name) || name.length > 240) throw new WorkerApiError(400, "invalid_attachment", "Invalid attachment name.");
  const root = await conversationDirectory(cache, id), target = path.join(root, name);
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk); bytes += value.length;
    if (bytes > MAX_ATTACHMENT_BYTES) throw new WorkerApiError(413, "attachment_limit", "Attachment exceeds 20 MiB.");
    chunks.push(value);
  }
  const data = Buffer.concat(chunks), hash = createHash("sha256").update(data).digest("hex");
  const readExisting = async () => {
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!handle) return null;
    try { const info = await handle.stat(); if (!info.isFile() || info.size > MAX_ATTACHMENT_BYTES) throw new WorkerApiError(409, "attachment_conflict", "Attachment target is not an ordinary bounded file."); return await handle.readFile(); }
    finally { await handle.close(); }
  };
  const previous = await readExisting();
  if (previous && !previous.equals(data)) throw new WorkerApiError(409, "attachment_conflict", "Attachment name already has different content.");
  if (!previous) {
    const temporary = `${target}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, data, { mode: 0o600, flag: "wx" }); await link(temporary, target).catch(async error => {
      if (error.code !== "EEXIST") throw error;
      if (!(await readExisting())?.equals(data)) throw new WorkerApiError(409, "attachment_conflict", "Attachment name already has different content.");
    }); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  return { path: target, hash };
}

/** Rewrite only recognized worktree descriptors, never arbitrary strings from source content. */
export function projectWorktreePaths(value: unknown, trees: string): unknown {
  if (Array.isArray(value)) return value.map(item => projectWorktreePaths(item, trees));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const mapped = Object.fromEntries(Object.entries(record).map(([key, item]) => [key, projectWorktreePaths(item, trees)]));
  if (typeof record.id === "string" && /^[a-f0-9]{64}$/.test(record.id) && typeof record.path === "string" && typeof record.repository === "string") {
    const separator = trees.includes("\\") ? "\\" : "/";
    mapped.path = trees.replace(/[\\/]$/, "") + separator + record.id;
  }
  return mapped;
}
