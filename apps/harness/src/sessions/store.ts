import { lstat, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { durableWriteFile, durableAppendFile, durableCreateFile, durableMkdir, syncDirectory, DurableWriteError, isUncertainWrite } from "../persistence.js";
import path from "node:path";

// Session records and transcripts live in the gateway's app data directory (decision 2026-08-08):
// standard app backup/removal semantics apply, Core audit never receives transcript content.
// Layout: {dataDir}/sessions/{id}/record.json + events.ndjson (append-only transcript).

// "awaiting_question" is deliberately its own status rather than a flavor of awaiting_approval: the
// two pauses look identical from the outside but resolve through different routes with different
// payloads, and a client that cannot tell them apart cannot render the right card.
export type SessionStatus =
  | "idle"
  | "running"
  | "suggesting"
  | "awaiting_approval"
  | "awaiting_question"
  | "cancelled"
  /**
   * Waited for a person long enough that nobody is coming.
   *
   * Distinct from `cancelled`, which the operator chose, and from `failed`, which the harness caused.
   * Collapsing it into either would misreport who decided — and the transcript is kept precisely so
   * the operator can still read what it was waiting to ask.
   */
  | "abandoned"
  | "failed";

export type SessionAutonomy = "normal" | "autonomous";

export interface SessionRecord {
  /** Immutable admitted input versions remain available independently of working-file cache. */
  sourceAttachments?: import("./message-queue.js").StoredQueueAttachment[];
  /** Unsettled durable input never authorizes a new physical execution after reopening. */
  sourceAdmission?: { clientRequestId?: string; runId: string; state: "preparing" | "dispatching" };
  storageRecovery?: { state: "required"; code: SessionStorageError["code"]; message: string };
  messageQueue?: import("./message-queue.js").MessageQueueRecord;
  suggestionHistoryVersion?: 1;
  /** Provider-owned execution attempt identity; distinct from chat and native session IDs. */
  agentRunId?: string;
  taskExecutionId?: string;
  taskDispatch?: import("@hosty-sdk/app/providers").TaskDispatchRef;
  autonomyRevision?: number;
  taskAdoptionApplied?: { id: string; executionId: string; before: string; after: string };
  taskInputGeneration?: number;
  taskCancellationRequested?: string;
  taskBarrier?: {
    id: string; kind: import("../worker/contracts.js").WorkerBarrier["kind"]; generation: number; owner: string;
    snapshot: string; runId: string; state: "armed" | "parked" | "resuming"; commandId: string;
    origin?: "coordinator"; acknowledgedSequence?: number; nativeSessionId?: string; sourceBefore?: SessionRecord["taskWorkspace"]; control?: import("../worker/contracts.js").WorkerBarrier;
  };
  taskContext?: {
    taskRef: import("@hosty-sdk/app/tasks").TaskRef;
    rootTaskRef: import("@hosty-sdk/app/tasks").TaskRef;
    parentTaskRef: import("@hosty-sdk/app/tasks").TaskRef | null;
    executor: { kind: "option" | "configuration"; id: string; revision: number; name: string; rationale?: string };
  };
  taskConfiguration?: { id: string; revision: number; rationale: string };
  taskDecisionReference?: import("@hosty-sdk/app/decisions").DecisionReference;
  taskRun?: { started: boolean; exitConfirmed: boolean; error?: string };
  agentProfile?: import("../profiles/types.js").AgentProfile | null;
  profileLocked?: boolean;
  /** Standing instructions captured once; skill package contents remain current. */
  instructionSnapshot?: string;
  skillIds?: string[];
  skillExportId?: string;
  executionSelection?: import("../worker/contracts.js").ExecutionSelection;
  selectionRevision?: number;
  workerRun?: { id: string; sequence: number; generation?: string };
  workerRecovery?: { runId: string; input: import("../worker/contracts.js").WorkerRecovery; state: "pending" | "completed" };
  retentionVersion?: 1;
  retention?: import("./retention.js").RetentionStatus;
  retentionCleanup?: { requestId: string; expectedRevision: number };
  /** Recorded execution mode for legacy data and recovery; the selected application profile governs idle sessions. */
  executionMode?: "native" | "docker";
  autonomy?: SessionAutonomy;
  developmentWorkspaces?: import("./development.js").DevelopmentWorkspace[];
  developmentLease?: string;
  taskWorkspace?: { source?: import("@hosty-sdk/app/providers").TaskSourceReference; dispatch: import("@hosty-sdk/app/providers").TaskDispatchRef; executionId: string; workspaceId: string; leaseId: string };
  developmentLeaseState?: "admitting" | "stopped";
  taskHistoryAssociation?: { workspaceId: string; associatedAt: string };
  workspaceAssociation?: { id: string; revision: number } | null;
  associationRequests?: { id: string; action: "attach" | "detach"; input: Record<string, unknown>; state: "pending" | "succeeded" | "rejected" }[];
  /** Freeze omitted prepare names before dispatch so a mutable conversation title cannot change replay. */
  developmentPreparationNames?: { requestId: string; name?: string }[];
  workspaceActivation?: { action: "execution-select" | "activation-apply" | "activation-return" | "activation-resume"; input: Record<string, unknown>; state: "queued" | "blocked" | "dispatched"; error?: string };
  workflowCompletion?: { requestId: string; expectedRevision: number; state: "queued" | "blocked"; error?: string };
  coreEnvironments?: import("@hosty-sdk/app/sandbox/server").CoreEnvironment[];
  appCreations?: { input: Record<string, unknown>; state: "pending" | "observed" | "rejected"; prompt?: string }[];
  coreEnvironmentOperations?: { action: string; input: Record<string, unknown>; state: "pending" | "observed" | "rejected" }[];
  handoffPending?: boolean;
  handoffDraft?: { text: string; attachments: { name: string; size: number }[] };
  handoffDispatch?: { id: string; state: "queued" | "running" | "completed" | "failed" | "unknown"; error?: string };

  id: string;
  decisionGeneration?: number;
  decisionRunIds?: Record<string, string>;
  decisionWaitIds?: string[];
  parkedQuestionRun?: { id: string; confirmedAt: string };
  mcpPendingApprovals?: { id: string; tool: string }[];
  publicationReferences?: { workspaceId: string; repository: string; url: string; head?: string }[];
  connectionId?: string;
  connectionRevision?: number;
  connectionIdentity?: string;
  harnessKind?: "claude" | "codex" | "ollama";
  providerLocked?: boolean;
  title: string | null;
  /**
   * Who chose the title. An operator's own name is never overwritten by a derived one — a session
   * renamed to "disk pressure" must not become the first line of the next message. Absent on records
   * written before titles existed, which read as `auto`: nobody had typed one.
   */
  titleSource?: "auto" | "operator";
  /** Structured page context from the client (app id, route) — seeds the first prompt, never parsed. */
  context: Record<string, string> | null;
  appIds?: string[];
  appContextRevision?: number;
  appContextRequests?: import("./app-context-tools.js").ContextReceipt[];
  /** Durable outbox committed atomically with the selection and replay receipt. */
  appContextEvent?: StoredEvent;
  creationRequest?: { id: string; fingerprint: string };
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  harnessSessionId: string | null;
  lastEventSeq: number;
  workspaceActivitySequence?: number;
}

/** A dispatch receipt is admission evidence, not a promise that the model completed successfully. */
export interface MessageReceipt {
  clientRequestId: string;
  state: "unknown" | "accepted" | "rejected";
  eventSeq?: number;
  error?: { code: string; message: string };
}

export interface StoredMessageReceipt extends MessageReceipt {
  actorUserId: string;
  fingerprint: string;
}

export function messageRequestId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value))
    throw new Error("invalid message request id");
  return value.toLowerCase();
}

export interface StoredEvent {
  seq: number;
  ts: string;
  type: string;
  [key: string]: unknown;
}

export class SessionStorageError extends Error {
  readonly status = 503;
  constructor(readonly sessionId: string, readonly code: "session_storage_corrupt" | "session_storage_uncertain", message: string, options?: ErrorOptions) {
    super(message, options); this.name = "SessionStorageError";
  }
}
type AcceptedAttachmentMetadata = { name: string; size: number; digest: string; revision: string };
type AcceptedAttachment = AcceptedAttachmentMetadata & { bytes: Buffer };
const attachmentGeneration = (info: BigIntStats) => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
const MAX_VERIFIED_ATTACHMENT_GENERATIONS = 256;

interface JournalRead { missing?: boolean; events: StoredEvent[]; raw: Buffer; keepBytes: number; repair: boolean; needsNewline: boolean }
interface JournalTail { high: number; bytes: number; needsNewline: boolean; generation?: string; identity?: string; repair?: JournalRead }
const MAX_VALIDATED_JOURNAL_TAILS = 256;
const fileIdentity = (info: BigIntStats) => [info.dev, info.ino].join(":");
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const statuses = new Set<SessionStatus>(["idle", "running", "suggesting", "awaiting_approval", "awaiting_question", "cancelled", "abandoned", "failed"]);

/** Only a syntactically valid JSON prefix at EOF, or an all-NUL suffix, is repairable. */
function incompleteTail(line: string): boolean {
  const prefix = line.replace(/\0+$/, "");
  if (prefix !== line && !prefix.trim()) return true;
  if (!prefix.trimStart().startsWith("{")) return false;
  try { JSON.parse(prefix); return prefix !== line; }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    const position = /at position (\d+)/.exec(message);
    return /Unexpected end of JSON input/.test(message) || !!position && Number(position[1]) === prefix.length;
  }
}

/** Recognize only an unfinished valid UTF-8 scalar at physical EOF. Invalid interior bytes stay corrupt. */
function utf8TailStart(raw: Buffer): number | null {
  let start = raw.length - 1;
  while (start >= 0 && (raw[start]! & 0xc0) === 0x80) start--;
  if (start < 0) return null;
  const lead = raw[start]!, count = raw.length - start;
  const width = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
  if (!width || count >= width) return null;
  for (let index = start + 1; index < raw.length; index++) if ((raw[index]! & 0xc0) !== 0x80) return null;
  const second = raw[start + 1];
  if (second !== undefined && (lead === 0xe0 && second < 0xa0 || lead === 0xed && second > 0x9f
    || lead === 0xf0 && second < 0x90 || lead === 0xf4 && second > 0x8f)) return null;
  return start;
}

/** A raw multibyte scalar is legal only inside a JSON string, outside an escape sequence. */
function utf8StringPosition(text: string): boolean {
  let string = false, escaped = false, unicode = 0;
  for (const char of text) {
    if (!string) { if (char === '"') string = true; continue; }
    if (unicode) { unicode--; continue; }
    if (escaped) { escaped = false; if (char === "u") unicode = 4; continue; }
    if (char === "\\") escaped = true; else if (char === '"') string = false;
  }
  return string && !escaped && !unicode;
}

export class SessionStore {
  constructor(readonly dataDir: string, private readonly workspaceRoot: string | null = null) {}
  private sessionsRoot(): string { return path.join(this.dataDir, "sessions"); }
  private readonly writes = new Map<string, Promise<unknown>>();
  private readonly sealed = new Map<string, SessionStorageError>();
  private readonly issues = new Map<string, SessionStorageError>();
  private readonly observerFailures = new Map<string, string>();
  // Cache only an integrity-checked physical generation, never attachment payload buffers.
  private readonly verifiedAttachments = new Map<string, string>();
  // Retain only clean-tail identity/high water; transcript payloads remain on disk.
  private readonly journalTails = new Map<string, JournalTail>();
  private readonly observers = new Set<(id: string) => Promise<void>>();

  recoveryIssues(): { sessionId: string; code: SessionStorageError["code"]; message: string }[] {
    return [...this.issues.values()].map(({ sessionId, code, message }) => ({ sessionId, code, message }));
  }
  projectionIssues(): { sessionId: string; code: "history_projection_unavailable"; message: string }[] {
    return [...this.observerFailures].map(([sessionId, message]) => ({ sessionId, code: "history_projection_unavailable", message }));
  }
  private problem(id: string, error: unknown, message = "This conversation's retained source needs recovery."): SessionStorageError {
    this.journalTails.delete(id);
    const issue = error instanceof SessionStorageError ? error : new SessionStorageError(id,
      isUncertainWrite(error) ? "session_storage_uncertain" : "session_storage_corrupt", message, { cause: error });
    this.issues.set(id, issue); this.sealed.set(id, issue); return issue;
  }
  private async serialize<T>(id: string, work: () => Promise<T>, mutation = false, deleting = false): Promise<T> {
    this.sessionDir(id);
    const previous = this.writes.get(id) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      if (mutation && this.sealed.has(id)) throw this.sealed.get(id)!;
      if (mutation && !deleting && await this.deleted(id)) throw new SessionStorageError(id, "session_storage_corrupt", "This conversation was deleted; its identity cannot be reused.");
      try { return await work(); }
      catch (error) {
        if (isUncertainWrite(error)) { const issue = this.problem(id, error, "A source write has an uncertain outcome. Reopen and reconcile this conversation before continuing."); this.sealed.set(id, issue); throw issue; }
        throw error;
      }
    });
    this.writes.set(id, task);
    try { return await task; }
    finally { if (this.writes.get(id) === task) this.writes.delete(id); }
  }
  assertWritable(id: string): void { if (this.sealed.has(id)) throw this.sealed.get(id)!; }
  private async settleSourceDirectory(id: string, target: string): Promise<void> {
    await durableMkdir(path.dirname(target));
    // A reopened partial directory chain must also settle its persisted session boundary.
    try { await syncDirectory(this.sessionDir(id)); }
    catch (error) { throw new DurableWriteError(target, error); }
  }
  /** Reconcile an existing byte publication before acknowledging its retained identity. */
  async settleSourcePublication(id: string, target: string): Promise<void> {
    await this.serialize(id, async () => {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) throw this.problem(id, new Error("invalid retained source publication"));
      await this.settleSourceDirectory(id, target);
    }, true);
  }
  /** Authoritative attachment/upload bytes use the same uncertain-write fence as records. */
  async saveSourceFile(id: string, target: string, content: string | Buffer, create = false): Promise<void> {
    await this.serialize(id, async () => {
      await this.settleSourceDirectory(id, target);
      await (create ? durableCreateFile(target, content) : durableWriteFile(target, content));
    }, true);
  }
  /** Derived failures are diagnostic; they cannot reject an already durable source operation. */
  observeChanges(observer: (id: string) => Promise<void>): () => void { this.observers.add(observer); return () => this.observers.delete(observer); }
  private async changed(id: string): Promise<void> {
    const results = await Promise.allSettled([...this.observers].map(observer => Promise.resolve().then(() => observer(id))));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) this.observerFailures.set(id, "Derived conversation history is unavailable; source data remains committed.");
    else this.observerFailures.delete(id);
  }

  async ensureWorkspace(id: string): Promise<string | null> {
    if (this.workspaceRoot === null) return null;
    const dir = this.workspaceDir(id); await durableMkdir(dir); return dir;
  }
  private workspaceDir(id: string): string { this.sessionDir(id); return path.join(this.workspaceRoot!, "sessions", id, "workspace"); }
  attachmentPath(id: string, name: string): string | null {
    if (this.workspaceRoot === null) return null;
    if (!name || name !== path.basename(name) || name.startsWith(".")) throw new Error(`invalid attachment name: ${name}`);
    return path.join(this.workspaceDir(id), name);
  }
  private async removeWorkspace(id: string): Promise<void> {
    if (this.workspaceRoot !== null) await rm(path.join(this.workspaceRoot, "sessions", id), { recursive: true, force: true });
  }
  private deletionRoot(): string { return path.join(this.dataDir, "session-deletions"); }
  private async deleted(id: string): Promise<boolean> {
    let raw: string;
    try { raw = await readFile(path.join(this.deletionRoot(), id + ".json"), "utf8"); }
    catch (error) { if (absent(error)) return false; throw this.problem(id, error); }
    try {
      const marker = JSON.parse(raw) as { version?: unknown; sessionId?: unknown };
      if (!marker || marker.version !== 1 || marker.sessionId !== id) throw new Error("invalid source deletion marker");
      return true;
    } catch (error) { throw this.problem(id, error, "The source deletion evidence needs recovery. Keep its conversation unavailable."); }
  }
  private sessionDir(id: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error(`invalid session id: ${id}`);
    return path.join(this.sessionsRoot(), id);
  }
  async createSession(record: SessionRecord): Promise<void> {
    const content = JSON.stringify(record, null, 2);
    await this.serialize(record.id, async () => {
      await durableMkdir(this.sessionDir(record.id));
      await durableCreateFile(path.join(this.sessionDir(record.id), "record.json"), content);
    }, true);
    await this.changed(record.id);
  }
  messageQueueDirectory(id: string): string { return path.join(this.sessionDir(id), "message-queue"); }

  async acceptedAttachment(id: string, nameOrId: string, identity?: string): Promise<AcceptedAttachment | null> {
    return this.loadAcceptedAttachment(id, nameOrId, identity, true);
  }
  async acceptedAttachmentMetadata(id: string, nameOrId: string, identity?: string): Promise<AcceptedAttachmentMetadata | null> {
    return this.loadAcceptedAttachment(id, nameOrId, identity, false);
  }
  /** Internal history projection reuses a source record/journal already reconciled by its caller. */
  async acceptedAttachmentMetadataFromSnapshot(record: SessionRecord, nameOrId: string, identity?: string): Promise<AcceptedAttachmentMetadata | null> {
    this.sessionDir(record.id); this.assertWritable(record.id);
    if (record.storageRecovery) throw new SessionStorageError(record.id, record.storageRecovery.code, record.storageRecovery.message);
    if (await this.deleted(record.id)) return null;
    return this.loadAcceptedAttachment(record.id, nameOrId, identity, false, record);
  }
  private loadAcceptedAttachment(id: string, nameOrId: string, identity: string | undefined, content: true): Promise<AcceptedAttachment | null>;
  private loadAcceptedAttachment(id: string, nameOrId: string, identity: string | undefined, content: false, snapshot?: SessionRecord): Promise<AcceptedAttachmentMetadata | null>;
  private async loadAcceptedAttachment(id: string, nameOrId: string, identity: string | undefined, content: boolean, snapshot?: SessionRecord): Promise<AcceptedAttachmentMetadata | AcceptedAttachment | null> {
    const record = snapshot ?? await this.readRecord(id);
    const revision = (digest: string) => /^[a-f0-9]{64}$/.test(digest) ? BigInt("0x" + digest.slice(0, 32)).toString() : "invalid";
    const file = record?.sourceAttachments?.findLast(candidate => (candidate.name === nameOrId || candidate.id === nameOrId)
      && (!identity || candidate.digest === identity || revision(candidate.digest) === identity));
    if (!file) return null;
    if (!/^[a-f0-9]{64}$/.test(file.digest) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 25 * 1024 * 1024)
      throw this.problem(id, new Error("invalid admitted attachment metadata"));
    const target = path.join(this.messageQueueDirectory(id), "files", file.digest), key = `${id}\0${file.digest}`;
    const metadata = { name: file.name, size: file.size, digest: file.digest, revision: revision(file.digest) };
    try {
      const before = await lstat(target, { bigint: true }), generation = attachmentGeneration(before);
      if (!before.isFile() || before.isSymbolicLink() || before.size !== BigInt(file.size)) throw new Error("invalid admitted attachment file");
      if (!content && this.verifiedAttachments.get(key) === generation) {
        this.verifiedAttachments.delete(key); this.verifiedAttachments.set(key, generation);
        return metadata;
      }
      const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let bytes: Buffer;
      try {
        if (attachmentGeneration(await handle.stat({ bigint: true })) !== generation) throw new Error("admitted attachment generation changed");
        bytes = await handle.readFile();
        if (bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.digest
          || attachmentGeneration(await handle.stat({ bigint: true })) !== generation
          || attachmentGeneration(await lstat(target, { bigint: true })) !== generation)
          throw new Error("damaged or changed admitted attachment");
      } finally { await handle.close(); }
      this.verifiedAttachments.delete(key); this.verifiedAttachments.set(key, generation);
      if (this.verifiedAttachments.size > MAX_VERIFIED_ATTACHMENT_GENERATIONS)
        this.verifiedAttachments.delete(this.verifiedAttachments.keys().next().value!);
      return content ? { ...metadata, bytes } : metadata;
    } catch (error) {
      this.verifiedAttachments.delete(key);
      throw this.problem(id, error, "The admitted attachment bytes are unavailable or failed verification. Preserve this conversation for recovery.");
    }
  }

  async saveRecord(record: SessionRecord): Promise<void> {
    // Capture mutable callers before entering the lane; preserve committed journal high water.
    const next = structuredClone(record);
    await this.serialize(record.id, async () => {
      const journal = await this.journalTail(record.id);
      const target = path.join(this.sessionDir(record.id), "record.json");
      let committedHigh = 0;
      try {
        const committed = JSON.parse(await readFile(target, "utf8")) as SessionRecord;
        if (!committed || committed.id !== record.id || typeof committed.createdBy !== "string" || !committed.createdBy
          || !statuses.has(committed.status) || !Number.isSafeInteger(committed.lastEventSeq) || committed.lastEventSeq < 0
          || typeof committed.createdAt !== "string" || typeof committed.updatedAt !== "string") throw new Error("invalid committed record");
        committedHigh = committed.lastEventSeq;
      } catch (error) { if (!absent(error)) throw this.problem(record.id, error); }
      const journalHigh = journal.high;
      if (committedHigh > journalHigh && !(committedHigh === journalHigh + 1 && next.appContextEvent?.seq === committedHigh))
        throw this.problem(record.id, new Error("checkpoint exceeds retained transcript"), "The checkpoint references missing transcript input. Preserve this conversation for recovery.");
      next.lastEventSeq = Math.max(next.lastEventSeq, committedHigh, journal.high);
      await durableWriteFile(path.join(this.sessionDir(record.id), "record.json"), JSON.stringify(next, null, 2));
      record.lastEventSeq = Math.max(record.lastEventSeq, next.lastEventSeq);
    }, true);
    await this.changed(record.id);
  }
  private messageReceiptPath(id: string, requestId: string): string { return path.join(this.sessionDir(id), "message-requests", messageRequestId(requestId) + ".json"); }
  async saveMessageReceipt(id: string, receipt: StoredMessageReceipt): Promise<void> {
    const content = JSON.stringify(receipt), target = this.messageReceiptPath(id, receipt.clientRequestId);
    await this.serialize(id, async () => { await durableMkdir(path.dirname(target)); await durableWriteFile(target, content); }, true);
  }
  async readMessageReceipt(id: string, requestId: string): Promise<StoredMessageReceipt | null> {
    this.sessionDir(id);
    if (await this.deleted(id)) return null;
    let content: string;
    try { content = await readFile(this.messageReceiptPath(id, requestId), "utf8"); }
    catch (error) { if (absent(error)) return null; throw this.problem(id, error); }
    try {
      if (content.length > 4096) throw new Error("invalid message receipt");
      const receipt = JSON.parse(content) as StoredMessageReceipt;
      if (!receipt || receipt.clientRequestId !== messageRequestId(requestId)
        || typeof receipt.actorUserId !== "string" || !receipt.actorUserId || receipt.actorUserId.length > 512
        || typeof receipt.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(receipt.fingerprint)
        || !["unknown", "accepted", "rejected"].includes(receipt.state)
        || (receipt.eventSeq !== undefined && (!Number.isSafeInteger(receipt.eventSeq) || receipt.eventSeq < 1))
        || (receipt.error !== undefined && (typeof receipt.error?.code !== "string" || receipt.error.code.length > 80
          || typeof receipt.error.message !== "string" || receipt.error.message.length > 500))) throw new Error("invalid message receipt");
      return receipt;
    } catch (error) { throw this.problem(id, error, "The saved admission receipt needs recovery; do not submit this request again."); }
  }
  async readRecord(id: string): Promise<SessionRecord | null> {
    return this.serialize(id, async () => {
      if (await this.deleted(id)) return null;
      let raw: string;
      try { raw = await readFile(path.join(this.sessionDir(id), "record.json"), "utf8"); }
      catch (error) {
        if (absent(error)) {
          try { await stat(this.sessionDir(id)); } catch (directoryError) { if (absent(directoryError)) return null; throw this.problem(id, directoryError); }
        }
        throw this.problem(id, error);
      }
      let record: SessionRecord;
      try {
        record = JSON.parse(raw) as SessionRecord;
        if (!record || record.id !== id || typeof record.createdBy !== "string" || !record.createdBy
          || !statuses.has(record.status) || !Number.isSafeInteger(record.lastEventSeq) || record.lastEventSeq < 0
          || typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") throw new Error("invalid session record");
      } catch (error) { throw this.problem(id, error); }
      try {
        const journal = await this.journalTail(id);
        const journalHigh = journal.high;
        if (record.lastEventSeq > journalHigh && !(record.lastEventSeq === journalHigh + 1 && record.appContextEvent?.seq === record.lastEventSeq))
          throw this.problem(id, new Error("checkpoint exceeds retained transcript"), "The checkpoint references missing transcript input. Preserve this conversation for recovery.");
        record.lastEventSeq = Math.max(record.lastEventSeq, journal.high);
        const issue = this.sealed.get(id);
        if (issue) record.storageRecovery = { state: "required", code: issue.code, message: issue.message };
      } catch (error) {
        const issue = this.problem(id, error); record.storageRecovery = { state: "required", code: issue.code, message: issue.message };
      }
      return { ...record, appIds: record.appIds ?? [], appContextRevision: record.appContextRevision ?? 0 };
    });
  }
  async listRecordInventory(): Promise<{ records: SessionRecord[]; unavailableIds: string[] }> {
    const records: SessionRecord[] = [], unavailable = new Set<string>();
    let markers: string[];
    try { markers = await readdir(this.deletionRoot()); }
    catch (error) { if (absent(error)) markers = []; else throw this.problem("inventory", error, "The source deletion inventory is unavailable."); }
    for (const marker of markers) {
      const id = /^([a-zA-Z0-9-]+)\.json$/.exec(marker)?.[1];
      if (id) try { await this.deleted(id); } catch { unavailable.add(id); }
    }
    let entries;
    try { entries = await readdir(this.sessionsRoot(), { withFileTypes: true }); }
    catch (error) {
      if (absent(error)) return { records, unavailableIds: [...unavailable] };
      throw this.problem("inventory", error, "The source conversation inventory is unavailable.");
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9-]+$/.test(entry.name)) continue;
      try {
        const record = await this.readRecord(entry.name);
        if (record) { records.push(record); if (record.storageRecovery) unavailable.add(entry.name); }
      } catch { unavailable.add(entry.name); }
    }
    return { records: records.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), unavailableIds: [...unavailable] };
  }
  async listRecords(): Promise<SessionRecord[]> { return (await this.listRecordInventory()).records; }

  private rememberJournalTail(id: string, tail: JournalTail): void {
    this.journalTails.delete(id);
    if (this.sealed.has(id) || !tail.generation || tail.repair) return;
    this.journalTails.set(id, tail);
    if (this.journalTails.size > MAX_VALIDATED_JOURNAL_TAILS) this.journalTails.delete(this.journalTails.keys().next().value!);
  }
  private async journalTail(id: string): Promise<JournalTail> {
    if (await this.deleted(id)) { this.journalTails.delete(id); return { high: 0, bytes: 0, needsNewline: false }; }
    const target = path.join(this.sessionDir(id), "events.ndjson");
    let before: BigIntStats;
    try { before = await lstat(target, { bigint: true }); }
    catch (error) {
      this.journalTails.delete(id);
      if (absent(error)) return { high: 0, bytes: 0, needsNewline: false };
      throw this.problem(id, error);
    }
    if (!before.isFile() || before.isSymbolicLink()) throw this.problem(id, new Error("invalid transcript source file"));
    const generation = attachmentGeneration(before), cached = this.journalTails.get(id);
    if (cached?.generation === generation) { this.rememberJournalTail(id, cached); return cached; }
    this.journalTails.delete(id);
    const journal = await this.journal(id);
    let after: BigIntStats;
    try { after = await lstat(target, { bigint: true }); }
    catch (error) { throw this.problem(id, error); }
    if (attachmentGeneration(after) !== generation) throw this.problem(id, new Error("transcript changed during reconciliation"));
    const tail: JournalTail = { high: journal.events.at(-1)?.seq ?? 0, bytes: journal.raw.length,
      needsNewline: journal.needsNewline, generation, identity: fileIdentity(after) };
    if (journal.repair) return { ...tail, repair: journal };
    this.rememberJournalTail(id, tail); return tail;
  }
  private async journal(id: string): Promise<JournalRead> {
    if (await this.deleted(id)) return { missing: true, events: [], raw: Buffer.alloc(0), keepBytes: 0, repair: false, needsNewline: false };
    let raw: Buffer;
    try { raw = await readFile(path.join(this.sessionDir(id), "events.ndjson")); }
    catch (error) { if (absent(error)) return { missing: true, events: [], raw: Buffer.alloc(0), keepBytes: 0, repair: false, needsNewline: false }; throw this.problem(id, error); }
    let text: string, partialUtf8 = false;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw); }
    catch (error) {
      const start = utf8TailStart(raw);
      if (start === null) throw this.problem(id, error, "The transcript contains damaged text bytes. Preserve its source for recovery.");
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw.subarray(0, start));
        if (!utf8StringPosition(text)) throw new Error("truncated UTF-8 outside a JSON string");
        partialUtf8 = true;
      }
      catch (prefixError) { throw this.problem(id, prefixError, "The transcript contains damaged interior text bytes. Preserve its source for recovery."); }
    }
    const lines = text.split("\n"), events: StoredEvent[] = [];
    let offset = 0;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!, bytes = Buffer.byteLength(line) + (index < lines.length - 1 ? 1 : 0);
      if (!line.trim()) { offset += bytes; continue; }
      let event: StoredEvent | undefined, tailStart: number | undefined;
      try { event = JSON.parse(line) as StoredEvent; }
      catch (error) {
        if (index === lines.length - 1) {
          const prefix = line.replace(/\0+$/, "");
          if (prefix !== line && prefix.trim()) {
            try { event = JSON.parse(prefix) as StoredEvent; tailStart = offset + Buffer.byteLength(prefix); } catch { /* Only the valid prefix grammar below permits repair. */ }
          }
          if (!event && incompleteTail(line))
            return { events, raw, keepBytes: offset, repair: true, needsNewline: offset > 0 && raw[offset - 1] !== 10 };
        }
        if (!event) throw this.problem(id, error, "This conversation contains an invalid interior or unproven journal record. Preserve its source for recovery.");
      }
      if (partialUtf8 && index === lines.length - 1) throw this.problem(id, new Error("unproven UTF-8 tail"));
      if (!event || !Number.isSafeInteger(event.seq) || event.seq < 1 || typeof event.type !== "string" || !event.type || typeof event.ts !== "string"
        || event.seq <= (events.at(-1)?.seq ?? 0))
        throw this.problem(id, new Error("invalid event sequence"), "This conversation has conflicting or invalid transcript identities. Preserve its source for recovery.");
      events.push(event); offset += bytes;
      if (tailStart !== undefined) return { events, raw, keepBytes: tailStart, repair: true, needsNewline: true };
    }
    if (partialUtf8) throw this.problem(id, new Error("unproven UTF-8 tail"));
    return { events, raw, keepBytes: raw.length, repair: false, needsNewline: raw.length > 0 && raw.at(-1) !== 10 };
  }
  async eventHighWater(id: string): Promise<number> { return this.serialize(id, async () => (await this.journalTail(id)).high); }
  async appendEvent(id: string, event: StoredEvent, allocation?: { after: number }): Promise<void> {
    await this.serialize(id, async () => {
      const journal = await this.journalTail(id), high = journal.high;
      let checkpoint: SessionRecord;
      try {
        checkpoint = JSON.parse(await readFile(path.join(this.sessionDir(id), "record.json"), "utf8")) as SessionRecord;
        if (!checkpoint || checkpoint.id !== id || !Number.isSafeInteger(checkpoint.lastEventSeq) || checkpoint.lastEventSeq < 0) throw new Error("invalid source checkpoint");
      } catch (error) { throw this.problem(id, error); }
      const pendingOutbox = checkpoint.appContextEvent;
      const completingOutbox = !allocation && checkpoint.lastEventSeq === high + 1 && pendingOutbox?.seq === checkpoint.lastEventSeq
        && JSON.stringify(pendingOutbox) === JSON.stringify(event);
      if (checkpoint.lastEventSeq > high && !completingOutbox)
        throw this.problem(id, new Error("checkpoint exceeds retained transcript"), "The checkpoint references missing transcript input. Preserve this conversation for recovery.");
      if (allocation) event.seq = Math.max(high, allocation.after) + 1;
      const encoded = JSON.stringify(event), appended = JSON.parse(encoded) as StoredEvent;
      if (!Number.isSafeInteger(appended.seq) || appended.seq <= high || appended.seq !== event.seq
        || typeof appended.type !== "string" || !appended.type || typeof appended.ts !== "string")
        throw this.problem(id, new Error("event sequence conflict"));
      const target = path.join(this.sessionDir(id), "events.ndjson");
      if (journal.repair) {
        const repair = journal.repair, recovery = path.join(this.sessionDir(id), "recovery"); await durableMkdir(recovery);
        await durableWriteFile(path.join(recovery, `events-tail-${randomUUID()}.bin`), repair.raw.subarray(repair.keepBytes));
        await durableWriteFile(target, repair.raw.subarray(0, repair.keepBytes));
      }
      const content = `${journal.needsNewline ? "\n" : ""}${encoded}\n`;
      await durableAppendFile(target, content);
      try {
        const after = await lstat(target, { bigint: true }), bytes = (journal.repair?.keepBytes ?? journal.bytes) + Buffer.byteLength(content);
        if (!after.isFile() || after.isSymbolicLink() || after.size !== BigInt(bytes)
          || !journal.repair && journal.identity && fileIdentity(after) !== journal.identity)
          throw new Error("transcript changed during durable append");
        this.rememberJournalTail(id, { high: appended.seq, bytes, needsNewline: false, generation: attachmentGeneration(after), identity: fileIdentity(after) });
      } catch (error) { throw new DurableWriteError(target, error); }
    }, true);
    await this.changed(id);
  }
  async readEvents(id: string, afterSeq = 0): Promise<StoredEvent[]> { return this.serialize(id, async () => (await this.journal(id)).events.filter(event => event.seq > afterSeq)); }
  async deleteSession(id: string): Promise<void> {
    await this.serialize(id, async () => {
      this.journalTails.delete(id);
      await durableMkdir(this.deletionRoot());
      if (!await this.deleted(id)) await durableCreateFile(path.join(this.deletionRoot(), id + ".json"), JSON.stringify({ version: 1, sessionId: id }));
      try {
        await this.removeWorkspace(id);
        await rm(this.sessionDir(id), { recursive: true, force: true });
        try { await syncDirectory(this.sessionsRoot()); } catch (error) { if (!absent(error)) throw error; }
        if (this.workspaceRoot) {
          try { await syncDirectory(path.join(this.workspaceRoot, "sessions")); } catch (error) { if (!absent(error)) throw error; }
        }
      } catch (error) { throw new DurableWriteError(this.sessionDir(id), error); }
    }, true, true);
    this.issues.delete(id); await this.changed(id);
  }
}
