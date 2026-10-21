import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, open, unlink } from "node:fs/promises";
import path from "node:path";
import { MAX_EVENT_BYTES, REPLAY_MS, WorkerApiError, safeIdentity, terminal, type WorkerEvent, type WorkerReceipt, type WorkerRunRequest } from "./contracts.js";
import type { HarnessEvent } from "../harness/adapter.js";

type StoredRun = { version: 1; hash: string; receipt: WorkerReceipt; events: WorkerEvent[]; bytes: number; replayExpired?: boolean; controls: Record<string, { hash: string; applied: boolean }> };
export const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Atomic per-run records retain acceptance tombstones independently from bounded replay data. */
export class WorkerJournal {
  readonly generation = randomUUID();
  private tail: Promise<unknown> = Promise.resolve();
  private listeners = new Map<string, Set<() => void>>();
  constructor(private readonly directory: string, private readonly replayMs = REPLAY_MS, private readonly maxBytes = MAX_EVENT_BYTES, private readonly boundary: "container" | "local" = "local") {}
  exclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => {}).then(action); this.tail = next; return next;
  }
  private file(id: string): string {
    if (!safeIdentity(id)) throw new WorkerApiError(400, "invalid_run_id", "Invalid run identity.");
    return path.join(this.directory, id + ".json");
  }
  async load(id: string): Promise<StoredRun> {
    try {
      const record = JSON.parse(await readFile(this.file(id), "utf8")) as StoredRun;
      if (record.version !== 1 || record.receipt.runId !== id || !Array.isArray(record.events) || !record.controls) throw new Error("Invalid worker journal record.");
      if (terminal(record.receipt.state) && Date.now() - Date.parse(record.receipt.updatedAt) > this.replayMs) {
        record.events = []; record.bytes = 0; record.replayExpired = true;
      }
      return record;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WorkerApiError(404, "run_not_found", "Run not found."); throw error; }
  }
  private async save(record: StoredRun): Promise<void> {
    const file = this.file(record.receipt.runId), temp = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temp, file); }
    finally { await unlink(temp).catch(() => {}); }
    if (process.platform !== "win32") { const directory = await open(this.directory, "r"); try { await directory.sync(); } finally { await directory.close(); } }
    this.listeners.get(record.receipt.runId)?.forEach(listener => listener());
  }
  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const file of await readdir(this.directory)) {
      if (!file.endsWith(".json")) continue;
      const record = await this.load(file.slice(0, -5));
      if (!terminal(record.receipt.state)) {
        record.receipt.exitConfirmed = this.boundary === "container" && record.receipt.boundary === "container";
        record.receipt.state = "interrupted"; record.receipt.error = "Worker restarted; the previous run was not repeated.";
        record.receipt.pending = [];
        record.receipt.revision++; record.receipt.updatedAt = new Date().toISOString();
      }
      if (Date.now() - Date.parse(record.receipt.updatedAt) > this.replayMs) { record.events = []; record.bytes = 0; record.replayExpired = true; }
      await this.save(record);
    }
  }
  async prune(): Promise<void> {
    await this.exclusive(async () => {
      for (const file of await readdir(this.directory)) {
        if (!file.endsWith(".json")) continue;
        const record = JSON.parse(await readFile(path.join(this.directory, file), "utf8")) as StoredRun;
        if (!record.replayExpired && terminal(record.receipt.state) && Date.now() - Date.parse(record.receipt.updatedAt) > this.replayMs) {
          record.events = []; record.bytes = 0; record.replayExpired = true; await this.save(record);
        }
      }
    });
  }
  async accept(id: string, request: WorkerRunRequest): Promise<{ receipt: WorkerReceipt; fresh: boolean }> {
    const hash = digest(request);
    const previous = await this.load(id).catch(error => { if (error instanceof WorkerApiError && error.status === 404) return null; throw error; });
    if (previous) {
      if (previous.hash !== hash) throw new WorkerApiError(409, "run_conflict", "Run identity already has different input.");
      return { receipt: previous.receipt, fresh: false };
    }
    const time = new Date().toISOString();
    const receipt: WorkerReceipt = { runId: id, conversationId: request.conversationId, generation: this.generation,
      boundary: this.boundary, state: "accepted", revision: 0, selection: request.selection, createdAt: time, updatedAt: time };
    // Provider credentials and MCP callback configuration are never retained in the journal.
    await this.save({ version: 1, hash, receipt, events: [], bytes: 0, controls: {} });
    return { receipt, fresh: true };
  }
  async update(id: string, state: WorkerReceipt["state"], error?: string): Promise<WorkerReceipt> {
    const record = await this.load(id); record.receipt.state = state;
    if (terminal(state)) { record.receipt.pending = []; record.receipt.exitConfirmed = state !== "interrupted"; }
    record.receipt.revision++; record.receipt.updatedAt = new Date().toISOString();
    if (error) record.receipt.error = error;
    await this.save(record); return record.receipt;
  }
  async append(id: string, event: HarnessEvent): Promise<WorkerEvent> {
    // Match coordinator transcript privacy before any durable Worker copy is written.
    if ((event.type === "approval_request" || event.type === "tool_use")
      && ["hosty:development: environment_setup", "mcp__hosty-workspaces__environment_setup"].includes(event.toolName)
      && event.input && typeof event.input === "object" && !Array.isArray(event.input))
      event = { ...event, input: { ...event.input, password: "[redacted]" } };
    const record = await this.load(id);
    const frame: WorkerEvent = { runId: id, generation: record.receipt.generation, sequence: record.receipt.revision + 1, event };
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    if (bytes > 1024 * 1024 || record.bytes + bytes > this.maxBytes) throw new WorkerApiError(413, "event_limit", "Run event retention limit exceeded.");
    const snapshot = record.receipt.snapshot ??= {};
    if (event.type === "assistant_text") {
      const text = snapshot.text ? snapshot.text + "\n\n" + event.text : event.text;
      if (Buffer.byteLength(text) > 1024 * 1024) throw new WorkerApiError(413, "result_limit", "Final response exceeds the snapshot limit.");
      snapshot.text = text;
    }
    if (event.type === "harness_session") snapshot.nativeSessionId = event.harnessSessionId;
    if (event.type === "result" || event.type === "error") snapshot.result = event;
    if (event.type === "approval_request" || event.type === "question_request") (record.receipt.pending ??= []).push(frame);
    record.bytes += bytes; record.events.push(frame); record.receipt.revision = frame.sequence;
    record.receipt.updatedAt = new Date().toISOString(); await this.save(record); return frame;
  }
  async control(id: string, controlId: string, value: unknown, apply: (record: StoredRun) => Promise<void>, validate?: () => void): Promise<boolean> {
    if (!safeIdentity(controlId)) throw new WorkerApiError(400, "invalid_control", "Invalid control identity.");
    const record = await this.load(id), hash = digest(value), previous = record.controls[controlId];
    if (previous) { if (previous.hash !== hash) throw new WorkerApiError(409, "control_conflict", "Control identity has different input."); if (!previous.applied) throw new WorkerApiError(409, "control_uncertain", "Decision delivery is uncertain; inspect the run before another decision."); return false; }
    validate?.();
    // Persist intent before touching a native process. An uncertain control is never replayed.
    if (Object.keys(record.controls).length >= 10000) throw new WorkerApiError(413, "control_limit", "Run control limit exceeded.");
    record.controls[controlId] = { hash, applied: false }; await this.save(record); await apply(record);
    record.controls[controlId]!.applied = true;
    const eventId = (value as { eventId?: number }).eventId;
    if (eventId !== undefined) record.receipt.pending = record.receipt.pending?.filter(event => event.sequence !== eventId);
    await this.save(record); return true;
  }
  subscribe(id: string, listener: () => void): () => void {
    const listeners = this.listeners.get(id) ?? new Set(); listeners.add(listener); this.listeners.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
  }
}
