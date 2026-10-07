import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseSourceDocument } from "./parser";
import type { ParsedDocument, ReferencePath } from "./types";

export function blobSha(content: string, length = 40): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash(length === 64 ? "sha256" : "sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}
type CacheEntry = { version: 2; content: string; documents: Record<string, ParsedDocument> };
// This cache contains derived bytes and parsed syntax, never credentials or access decisions.
// A caller must get a fresh Core listing before passing any SHA to read(). Writes and eviction
// share one queue, so simultaneous repository loads cannot evade the global disk bound.
// Validated parse results have a separate memory bound and include current reference metadata
// in their key. They contain derived documents, never authorization decisions.
export class DocumentCache {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly validated = new Map<string, { document: ParsedDocument; bytes: number }>();
  private validatedBytes = 0;
  constructor(private readonly directory: string, readonly maxBytes = 32 * 1024 * 1024) {}
  private file(sha: string) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) throw new Error("Invalid blob SHA.");
    return path.join(this.directory, `${sha}.json`);
  }
  private validationKey(sha: string, documentPath: string, references: ReferencePath[]): string {
    this.file(sha);
    return `${sha}\0${documentPath}\0${JSON.stringify(references)}`;
  }
  readValidated(sha: string, documentPath: string, references: ReferencePath[]): ParsedDocument | null {
    const key = this.validationKey(sha, documentPath, references);
    const entry = this.validated.get(key);
    if (!entry) return null;
    this.validated.delete(key);
    this.validated.set(key, entry);
    return entry.document;
  }
  validate(sha: string, documentPath: string, content: string, references: ReferencePath[]): ParsedDocument {
    if (blobSha(content, sha.length) !== sha) throw new Error("Core returned a SHA that does not match the document bytes.");
    const byPath = new Map(references.map(reference => [reference.path, reference]));
    const document = parseSourceDocument(documentPath, content, {
      componentExists: component => byPath.get(component)?.isDirectory === true,
      linkExists: target => byPath.get(target)?.exists === true,
    });
    const key = this.validationKey(sha, documentPath, references);
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(document));
    if (bytes <= this.maxBytes) {
      const previous = this.validated.get(key);
      if (previous) this.validatedBytes -= previous.bytes;
      this.validated.delete(key);
      this.validated.set(key, { document, bytes });
      this.validatedBytes += bytes;
      for (const [oldestKey, oldest] of this.validated) {
        if (this.validatedBytes <= this.maxBytes) break;
        this.validated.delete(oldestKey);
        this.validatedBytes -= oldest.bytes;
      }
    }
    return document;
  }
  async read(sha: string, documentPath: string): Promise<{ content: string; document: ParsedDocument } | null> {
    const file = this.file(sha);
    try {
      const entry = JSON.parse(await readFile(file, "utf8")) as CacheEntry;
      if (entry.version !== 2 || typeof entry.content !== "string" || blobSha(entry.content, sha.length) !== sha) { await rm(file, { force: true }); return null; }
      const now = new Date();
      await utimes(file, now, now);
      return { content: entry.content, document: entry.documents[documentPath] ?? parseSourceDocument(documentPath, entry.content) };
    } catch { return null; }
  }
  async write(sha: string, documentPath: string, content: string): Promise<ParsedDocument> {
    if (blobSha(content, sha.length) !== sha) throw new Error("Core returned a SHA that does not match the document bytes.");
    const document = parseSourceDocument(documentPath, content);
    const file = this.file(sha);
    const entry: CacheEntry = { version: 2, content, documents: { [documentPath]: document } };
    const bytes = JSON.stringify(entry);
    const task = this.queue.catch(() => undefined).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (Buffer.byteLength(bytes) > this.maxBytes) return;
      const temp = path.join(this.directory, `${sha}.${randomUUID()}.tmp`);
      try { await writeFile(temp, bytes, { mode: 0o600 }); await rename(temp, file); }
      finally { await rm(temp, { force: true }); }
      const entries = await Promise.all((await readdir(this.directory)).filter(name => /^[a-f0-9]{40,64}\.json$/.test(name)).map(async name => {
        const full = path.join(this.directory, name); const info = await stat(full); return { full, size: info.size, at: info.mtimeMs };
      }));
      let total = entries.reduce((sum, item) => sum + item.size, 0);
      for (const item of entries.sort((a, b) => a.at - b.at)) { if (total <= this.maxBytes) break; await rm(item.full, { force: true }); total -= item.size; }
    });
    this.queue = task;
    // A read still succeeds if cache storage is unavailable; it has just been authorized by Core.
    await task.catch(() => undefined);
    return document;
  }
}
