import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, copyFile } from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AssistantHandoff } from "@hosty-sdk/app/assistant";
import type { SessionManager } from "../sessions/manager.js";
import type { SettingsStore } from "../settings/store.js";
import type { ProviderDirectory } from "../settings/providers.js";
import { ConnectionError } from "../connections/registry.js";
import { AppContextError, parseAppIds, validateSelection } from "../sessions/app-context.js";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_SESSION, MAX_SESSION_ATTACHMENT_BYTES, sanitizeAttachmentName, fitToBytes } from "../sessions/attachments.js";

const DAY = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Attachment = AssistantHandoff["attachments"][number] & { storedName: string };
type Record = Omit<AssistantHandoff, "attachments"> & {
  actor: string; consumer?: string; fingerprint: string; prompt?: string; appIds?: string[];
  attachments: Attachment[]; allocating?: boolean;
};
const fail = (status: number, code: string, message: string): never => { throw new AppContextError(status, code, message); };

/** One atomic record per request, outside the agent workspace and transcript retention. */
export class HandoffStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly root: string;
  constructor(private readonly manager: SessionManager, private readonly settings: SettingsStore | null,
    private readonly providers: ProviderDirectory | null, private readonly now: () => number = Date.now) {
    this.root = path.join(manager.store.dataDir, "handoffs");
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const run = this.queue.then(action, action); this.queue = run.catch(() => undefined); return run;
  }
  private dir(id: string): string {
    if (!UUID.test(id)) fail(404, "handoff_not_found", "Handoff not found.");
    return path.join(this.root, id);
  }
  private async save(record: Record): Promise<void> {
    const dir = this.dir(record.handoffId); await mkdir(dir, { recursive: true });
    const temporary = path.join(dir, "record.tmp");
    await import("node:fs/promises").then(fs => fs.writeFile(temporary, JSON.stringify(record)));
    await rename(temporary, path.join(dir, "record.json"));
  }
  private async read(id: string): Promise<Record | null> {
    try { return JSON.parse(await readFile(path.join(this.dir(id), "record.json"), "utf8")) as Record; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  private async recordIds(): Promise<string[]> {
    const entries = await readdir(this.root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []; throw error;
    });
    return entries.filter(id => UUID.test(id));
  }
  private async records(): Promise<Record[]> {
    const result: Record[] = [];
    for (const id of await this.recordIds()) { const record = await this.read(id); if (record) result.push(record); }
    return result;
  }
  private async owned(id: string, actor: string, consumer?: string): Promise<Record> {
    const record = await this.read(id);
    if (!record || record.actor !== actor || record.consumer !== consumer) fail(404, "handoff_not_found", "Handoff not found.");
    await this.expire(record!); return record!;
  }
  private pending(record: Record): void {
    if (record.state === "cancelled" || record.state === "expired") fail(410, "handoff_closed", "This handoff is no longer pending.");
    if (record.state !== "pending") fail(409, "handoff_finalized", "This handoff is already finalized.");
  }
  private async expire(record: Record): Promise<void> {
    if (record.state === "pending" && this.now() >= Date.parse(record.expiresAt)) {
      record.state = "expired"; await this.save(record);
    }
    if (record.state === "expired" || record.state === "cancelled") {
      await this.manager.deleteSession(record.conversationId, record.actor);
      await this.cleanPayload(record);
    }
  }
  private async cleanPayload(record: Record): Promise<void> {
    await rm(path.join(this.dir(record.handoffId), "files"), { recursive: true, force: true });
    delete record.prompt; delete record.appIds; record.attachments = [];
    await this.save(record);
  }
  private async view(record: Record): Promise<AssistantHandoff> {
    const { actor: _actor, consumer: _consumer, fingerprint: _fingerprint, prompt: _prompt, appIds: _apps, allocating: _allocating, ...visible } = record;
    const session = await this.manager.getSession(record.conversationId);
    return { ...visible, limits: { maxFileBytes: MAX_ATTACHMENT_BYTES, maxFiles: MAX_ATTACHMENTS_PER_SESSION, maxTotalBytes: MAX_SESSION_ATTACHMENT_BYTES }, attachments: record.attachments.map(({ storedName: _name, ...attachment }) => attachment),
      ...(record.result?.dispatchId ? { executionState: session?.handoffDispatch?.state ?? "unknown" } : {}),
      // Return a result reference after transcript deletion; never recreate the conversation.
    };
  }
  async prepare(actor: string, input: { requestId?: unknown; prompt?: unknown; appIds?: unknown }, consumer?: string): Promise<{ created: boolean; value: AssistantHandoff }> {
    return this.serial(async () => {
      if (typeof input.requestId !== "string" || !UUID.test(input.requestId) || input.requestId[14] !== "7") fail(400, "request_id_invalid", "requestId must be a UUIDv7.");
      if (typeof input.prompt !== "string" || Buffer.byteLength(input.prompt) > 48 * 1024) fail(400, "prompt_invalid", "Provide a prompt of at most 48 KiB.");
      const requestId = input.requestId as string, prompt = input.prompt as string;
      const appIds = parseAppIds(input.appIds).sort();
      const fingerprint = createHash("sha256").update(JSON.stringify({ prompt, appIds })).digest("hex");
      let record = (await this.records()).find(r => r.actor === actor && r.consumer === consumer && r.requestId === requestId);
      const created = !record;
      if (record) {
        if (record.fingerprint !== fingerprint) fail(409, "request_conflict", "This request identity already has different input.");
        await this.expire(record);
      } else {
        const time = parseInt(requestId.replaceAll("-", "").slice(0, 12), 16), now = this.now();
        if (time < now - DAY) fail(410, "request_expired", "This unseen request identity is too old. Inspect the previous request instead of submitting it again.");
        if (time > now + 300_000) fail(400, "request_clock_skew", "The request clock is more than five minutes ahead.");
        await validateSelection(this.providers, appIds);
        const id = randomUUID();
        record = { handoffId: id, conversationId: id, requestId, actor, consumer, fingerprint, prompt, appIds,
          state: "pending", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + DAY).toISOString(),
          replayUntil: new Date(now + 30 * DAY).toISOString(), attachments: [], allocating: true };
        await this.save(record);
      }
      if (record.state === "pending" && record.allocating) {
        await this.manager.createSession({ createdBy: actor, appIds: record.appIds, clientRequestId: record.handoffId, reservedHandoffId: record.handoffId });
        delete record.allocating; await this.save(record);
      }
      return { created, value: await this.view(record) };
    });
  }
  async upload(actor: string, id: string, attachmentId: string, name: string, mediaType: string, stream: Readable, consumer?: string): Promise<{ created: boolean; value: Omit<Attachment, "storedName"> }> {
    return this.serial(async () => {
      const record = await this.owned(id, actor, consumer); this.pending(record);
      if (!UUID.test(attachmentId) || !name || Buffer.byteLength(name) > 1024 || !sanitizeAttachmentName(name)) fail(400, "attachment_invalid", "Provide a UUID attachment identity and a filename.");
      const existing = record.attachments.find(a => a.attachmentId === attachmentId);
      if (!existing && record.attachments.length >= MAX_ATTACHMENTS_PER_SESSION) fail(413, "too_many_attachments", "At most 20 attachments are allowed.");
      const total = record.attachments.reduce((n, a) => n + (a === existing ? 0 : a.sizeBytes), 0);
      const dir = path.join(this.dir(id), "files"); await mkdir(dir, { recursive: true });
      const temporary = path.join(dir, `.${randomUUID()}.tmp`), target = path.join(dir, attachmentId);
      let sizeBytes = 0; const digest = createHash("sha256");
      const counter = new Transform({ transform(chunk: Buffer, _encoding, done) {
        sizeBytes += chunk.length;
        if (sizeBytes > MAX_ATTACHMENT_BYTES || total + sizeBytes > MAX_SESSION_ATTACHMENT_BYTES) { done(new AppContextError(413, "attachment_too_large", "Attachment size limit exceeded.")); return; }
        digest.update(chunk); done(null, chunk);
      }});
      try {
        // Keep the HTTP request alive long enough to send a structured size-limit error.
        await pipeline(stream.iterator({ destroyOnReturn: false }), counter, createWriteStream(temporary, { flags: "wx" }));
        const value: Attachment = { attachmentId, name, mediaType, sizeBytes, sha256: digest.digest("hex"),
          storedName: `${attachmentId}-${fitToBytes(sanitizeAttachmentName(name)!, 150)}` };
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(value)) fail(409, "attachment_conflict", "This attachment identity already has different content or metadata.");
        } else { await rename(temporary, target); record.attachments.push(value); await this.save(record); }
        const { storedName: _storedName, ...publicValue } = value;
        return { created: !existing, value: publicValue };
      } finally { stream.resume(); await rm(temporary, { force: true }); }
    });
  }
  private async applyFinalized(record: Record, credential?: string, dispatch = false): Promise<void> {
    const session = await this.manager.getSession(record.conversationId);
    if (!session) {
      delete record.prompt; delete record.appIds;
      await rm(path.join(this.dir(record.handoffId), "files"), { recursive: true, force: true });
      await this.save(record); return;
    }
    if (session.handoffPending) {
      const workspace = await this.manager.workspaceFor(record.conversationId);
      if (record.attachments.length && !workspace) fail(503, "attachments_unavailable", "The assistant workspace is unavailable.");
      for (const attachment of record.attachments) await copyFile(path.join(this.dir(record.handoffId), "files", attachment.attachmentId), path.join(workspace!, attachment.storedName));
      await this.manager.releaseHandoff(record.conversationId, { text: record.prompt ?? "", attachments: record.attachments.map(a => ({ name: a.storedName, size: a.sizeBytes })) }, record.result?.dispatchId);
    }
    if (record.result?.dispatchId && dispatch) {
      const current = await this.manager.getSession(record.conversationId);
      if (current?.handoffDispatch?.state === "queued") {
        try { await this.manager.postMessage(record.conversationId, current.handoffDraft?.text ?? "", credential,
          current.handoffDraft?.attachments.map(a => a.name) ?? [], { expectedRevision: current.appContextRevision, dispatchId: record.result.dispatchId }); }
        catch (error) {
          await this.manager.recordHandoffFailure(record.conversationId,
            error instanceof AppContextError || error instanceof ConnectionError ? error.message : "Execution could not be confirmed. Inspect this conversation before retrying.");
        }
      }
    }
    // Bytes now belong to the conversation; only the fingerprint and result survive for replay.
    delete record.prompt; delete record.appIds;
    await rm(path.join(this.dir(record.handoffId), "files"), { recursive: true, force: true });
    await this.save(record);
  }
  async finalize(actor: string, id: string, ids: unknown, credential?: string, consumer?: string): Promise<AssistantHandoff> {
    return this.serial(async () => {
      const record = await this.owned(id, actor, consumer);
      if (record.state !== "finalized") this.pending(record);
      if (!Array.isArray(ids) || ids.some(x => typeof x !== "string" || !UUID.test(x)) || new Set(ids).size !== ids.length) fail(400, "attachments_invalid", "Provide unique completed attachment IDs.");
      if (JSON.stringify([...(ids as string[])].sort()) !== JSON.stringify(record.attachments.map(a => a.attachmentId).sort())) fail(409, "attachments_incomplete", "Finalize must name every completed attachment exactly once.");
      if (record.state !== "finalized") {
        await validateSelection(this.providers, record.appIds ?? []);
        if (!await this.manager.getSession(record.conversationId)) fail(410, "conversation_deleted", "The reserved conversation was deleted.");
        const immediate = (await this.settings?.read())?.immediateHandoffs === true && Boolean(record.prompt?.trim() || record.attachments.length);
        record.result = { conversationId: record.conversationId, disposition: immediate ? "accepted" : "draft",
          open: { endpoint: "http", path: `/assistant?session=${encodeURIComponent(record.conversationId)}` }, ...(immediate ? { dispatchId: randomUUID() } : {}) };
        record.state = "finalized"; await this.save(record);
      }
      await this.applyFinalized(record, credential, true); return this.view(record);
    });
  }
  async status(actor: string, id: string, consumer?: string): Promise<AssistantHandoff> {
    return this.serial(async () => { const record = await this.owned(id, actor, consumer); if (record.state === "finalized") await this.applyFinalized(record); return this.view(record); });
  }
  async cancel(actor: string, id: string, consumer?: string): Promise<AssistantHandoff> {
    return this.serial(async () => {
      const record = await this.owned(id, actor, consumer);
      if (record.state === "finalized") fail(409, "handoff_finalized", "Finalized handoffs cannot be cancelled through preparation cleanup.");
      if (record.state === "pending") { record.state = "cancelled"; await this.save(record); }
      await this.expire(record); return this.view(record);
    });
  }
  async sweep(): Promise<void> {
    return this.serial(async () => {
      for (const id of await this.recordIds()) {
        try {
          const record = await this.read(id);
          if (!record) continue;
          await this.manager.recoverHandoff(record.conversationId);
          await this.expire(record);
          const dir = path.join(this.dir(record.handoffId), "files");
          for (const file of await readdir(dir).catch(() => [])) if (file.endsWith(".tmp")) await rm(path.join(dir, file), { force: true });
          if (record.state === "finalized") await this.applyFinalized(record);
          if (this.now() > Date.parse(record.replayUntil) && !await this.manager.getSession(record.conversationId)) await rm(this.dir(record.handoffId), { recursive: true, force: true });
        } catch (error) {
          // Retain the record for repair/retry; one unavailable workspace must not block others.
          console.error(`[handoff] recovery failed for ${id}`, error);
        }
      }
    });
  }
}
