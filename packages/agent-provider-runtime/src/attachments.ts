import { sameProvider } from "./provider-ref.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentAttachment, AgentProviderRef } from "@hosty-sdk/app/agent";
import { AgentApiError } from "@hosty-sdk/app/agent";
import { validateAgentAttachmentChunk } from "@hosty-sdk/app/agent/server";
import { durableMkdir, durableWriteFile } from "./internal/persistence.js";
import { bytesHash, sameActor, type Actor } from "./store.js";

export type AttachmentChunk = { digest: string; sizeBytes: number; mediaType: string; name?: string; count: number; data: string };
type Record = { owner: Actor; provider?: AgentProviderRef; metadata: Omit<AttachmentChunk, "data">; chunks: { index: number; hash: string; size: number }[]; attachment?: AgentAttachment };
const maxBytes = 25 * 1024 * 1024, chunkBytes = 512 * 1024;

/** Inputs become provider-owned immutable assets before a native process can see a local path. */
export class AttachmentStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string, readonly provider: AgentProviderRef) {}
  private folder(id: string) { if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)) throw new AgentApiError("invalid_attachment", "Invalid attachment identity.", 400); return path.join(this.directory, id); }
  private async load(id: string, owner: Actor): Promise<Record | null> {
    try { const record = JSON.parse(await readFile(path.join(this.folder(id), "record.json"), "utf8")) as Record;
      const target = record.provider ?? record.attachment?.owner;
      if (!sameActor(record.owner, owner) || (target ? !sameProvider(target, this.provider) : this.provider.implementationId != null)) throw new AgentApiError("attachment_not_found", "Attachment not found.", 404); return record;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async chunk(id: string, index: number, input: AttachmentChunk, owner: Actor): Promise<{ attachment: AgentAttachment | null; received: number[] }> {
    const action = this.tail.catch(() => {}).then(async () => {
      validateAgentAttachmentChunk(input, index);
      const data = Buffer.from(input.data, "base64");
      if (data.length !== Math.min(chunkBytes, input.sizeBytes - index * chunkBytes)) throw new AgentApiError("invalid_attachment", "Attachment chunk length does not match its declared position.", 400);
      const { data: _, ...metadata } = input;
      const record = await this.load(id, owner) ?? { owner, provider: this.provider, metadata, chunks: [] };
      if (JSON.stringify(record.metadata) !== JSON.stringify(metadata)) throw new AgentApiError("request_conflict", "Attachment identity has different metadata.", 409);
      const existing = record.chunks.find(chunk => chunk.index === index), hash = bytesHash(data);
      if (existing && existing.hash !== hash) throw new AgentApiError("request_conflict", "Attachment chunk has different bytes.", 409);
      await durableMkdir(this.folder(id));
      if (!existing) { await durableWriteFile(path.join(this.folder(id), `${index}.chunk`), data); record.chunks.push({ index, hash, size: data.length }); }
      if (record.chunks.length === input.count && !record.attachment) {
        const bytes = Buffer.concat(await Promise.all(Array.from({ length: input.count }, (_, at) => readFile(path.join(this.folder(id), `${at}.chunk`)))));
        if (bytes.length !== input.sizeBytes || bytesHash(bytes) !== input.digest) throw new AgentApiError("attachment_digest_mismatch", "Attachment content does not match its immutable digest.", 409);
        await durableWriteFile(path.join(this.folder(id), "content"), bytes);
        record.attachment = { owner: this.provider, id, digest: input.digest, sizeBytes: input.sizeBytes, mediaType: input.mediaType, ...(input.name ? { name: input.name } : {}) };
      }
      await durableWriteFile(path.join(this.folder(id), "record.json"), JSON.stringify(record));
      return { attachment: record.attachment ?? null, received: record.chunks.map(chunk => chunk.index).sort((a, b) => a - b) };
    });
    this.tail = action; return action;
  }
  async resolve(ref: AgentAttachment, owner: Actor): Promise<string> {
    if (!sameProvider(ref.owner, this.provider)) throw new AgentApiError("attachment_owner_mismatch", "Copy the attachment into this execution provider before starting a run.", 409);
    const record = await this.load(ref.id, owner);
    if (!record?.attachment || record.attachment.digest !== ref.digest || record.attachment.sizeBytes !== ref.sizeBytes || record.attachment.mediaType !== ref.mediaType)
      throw new AgentApiError("attachment_not_found", "The exact immutable attachment is unavailable.", 404);
    const file = path.join(this.folder(ref.id), "content"), bytes = await readFile(file);
    if (bytesHash(bytes) !== ref.digest) throw new AgentApiError("attachment_unavailable", "Stored attachment integrity verification failed.", 503);
    return file;
  }
}
