import { randomUUID } from "node:crypto";
import { link, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

/** A storage operation was admitted; reopen/reconcile before deciding whether to retry it. */
export class DurableWriteError extends Error {
  readonly uncertain = true;
  constructor(readonly target: string, cause: unknown, readonly evidencePath = target) {
    super("The durable write outcome requires reconciliation.", { cause });
    this.name = "DurableWriteError";
  }
}

export const isUncertainWrite = (error: unknown): error is DurableWriteError => error instanceof DurableWriteError;

/** Retry only operations whose repetition cannot append another copy of the payload. */
export async function retrySharingViolation<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await action(); }
    catch (error) {
      if (attempt >= 3 || !["EACCES", "EPERM", "EBUSY"].includes((error as NodeJS.ErrnoException)?.code ?? "")) throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}

/** Node cannot open a Windows directory for FlushFileBuffers; file sync still precedes publication. */
export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  await settle(handle, () => handle.sync());
}

/** Persist newly created directory entries, from the deepest child through its existing parent. */
export async function durableMkdir(directory: string): Promise<void> {
  const first = await mkdir(directory, { recursive: true });
  try {
    const end = path.resolve(path.dirname(first ?? directory));
    for (let current = path.resolve(directory); ; current = path.dirname(current)) {
      await syncDirectory(current);
      if (current === end || current === path.dirname(current)) break;
    }
  } catch (error) { throw new DurableWriteError(directory, error); }
}

/** Preserve the first I/O error while still closing the handle, including after a failed flush. */
async function settle(handle: FileHandle, action: () => Promise<void>): Promise<void> {
  let failed = false, failure: unknown;
  try { await action(); } catch (error) { failed = true; failure = error; }
  try { await handle.close(); } catch (error) { if (!failed) { failed = true; failure = error; } }
  if (failed) throw failure;
}

const bytes = (content: string | Uint8Array): Buffer => typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
const writeAndSync = (handle: FileHandle, content: Buffer) => settle(handle, async () => {
  await handle.writeFile(content);
  await handle.sync();
});

/** The caller serializes the target and settles its directory creation before writing. */
export async function durableWriteFile(target: string, content: string | Uint8Array): Promise<void> {
  const data = bytes(content), temporary = `${target}.${randomUUID()}.tmp`;
  const handle = await retrySharingViolation(() => open(temporary, "wx", 0o600));
  let published = false;
  try {
    await writeAndSync(handle, data);
    await retrySharingViolation(() => rename(temporary, target));
    published = true;
    await syncDirectory(path.dirname(target));
  } catch (error) {
    // An unfinished file is evidence, not garbage. A post-rename failure leaves the target intact.
    throw new DurableWriteError(target, error, published ? target : temporary);
  }
}

/** Append exactly once. A failed write/sync/close must never be retried without inspecting the log. */
export async function durableAppendFile(target: string, content: string | Uint8Array): Promise<void> {
  const data = bytes(content);
  const handle = await retrySharingViolation(() => open(target, "a", 0o600));
  try {
    await writeAndSync(handle, data);
    // Also settles first creation; reopening an existing append file is not evidence that it existed.
    await syncDirectory(path.dirname(target));
  } catch (error) { throw new DurableWriteError(target, error); }
}

/** Exclusive creation keeps a pre-existing identity intact; EEXIST never becomes an uncertain write. */
export async function durableCreateFile(target: string, content: string | Uint8Array): Promise<void> {
  const data = bytes(content), temporary = `${target}.${randomUUID()}.tmp`;
  const handle = await retrySharingViolation(() => open(temporary, "wx", 0o600));
  let published = false;
  try {
    await writeAndSync(handle, data);
    // Linking publishes fully flushed bytes without replacing another creator's identity.
    await retrySharingViolation(() => link(temporary, target));
    published = true;
    await syncDirectory(path.dirname(target));
    await unlink(temporary);
    await syncDirectory(path.dirname(target));
  } catch (error) {
    if (!published && (error as NodeJS.ErrnoException)?.code === "EEXIST") {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    throw new DurableWriteError(target, error, published ? target : temporary);
  }
}
