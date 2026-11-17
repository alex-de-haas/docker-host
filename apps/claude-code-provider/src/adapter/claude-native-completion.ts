import { Transform, type Readable } from "node:stream";
import { ClaudeBackgroundLifecycle } from "./claude-background.js";

type ResultIdentity = { session: string; uuid: string };
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const root = (message: Record<string, unknown>) => !message.parent_tool_use_id && message.isReplay !== true;
const acknowledgement = (message: Record<string, unknown>) => message.type === "result" && message.subtype === "success"
  && message.is_error !== true && message.num_turns === 0 && message.result === "";

/** Observes the supported spawn transport without changing the bytes delivered to the SDK. */
export class ClaudeNativeCompletion {
  readonly stdout: Transform;
  private session: string | undefined;
  private lastResult: ResultIdentity | undefined;
  private lastSubstantiveResult: ResultIdentity | undefined;
  private idleResult: ResultIdentity | undefined;
  private broken = false;
  private needsSubstantiveResult = false;
  private readonly background = new ClaudeBackgroundLifecycle(() => undefined, () => {});
  private frame = Buffer.alloc(0);
  private bytes = 0;
  private skipping = false;

  constructor(stdout: Readable, private readonly ready: () => void, private readonly failed: () => void,
    expectedSession?: string, private readonly maxFrameBytes = 16 * 1024 * 1024) {
    this.session = expectedSession;
    this.stdout = new Transform({ transform: (chunk: Buffer, _encoding, callback) => {
      this.receive(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback(null, chunk);
    }, flush: callback => {
      if (this.bytes || this.skipping) this.fail();
      this.frame = Buffer.alloc(0); this.bytes = 0;
      callback();
    } });
    stdout.once("error", error => this.stdout.destroy(error));
    stdout.pipe(this.stdout);
  }

  beginTurn(): void { this.needsSubstantiveResult = false; this.lastResult = undefined; this.lastSubstantiveResult = undefined; this.idleResult = undefined; }

  confirms(message: Record<string, unknown>): boolean {
    return !this.broken && root(message) && this.idleResult !== undefined
      && message.session_id === this.idleResult.session && message.uuid === this.idleResult.uuid;
  }

  private fail(): void {
    this.idleResult = undefined; this.lastResult = undefined; this.lastSubstantiveResult = undefined;
    if (!this.broken) { this.broken = true; this.failed(); }
  }

  private receive(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset), end = newline < 0 ? chunk.length : newline;
      const length = end - offset;
      if (!this.skipping && this.bytes + length > this.maxFrameBytes) {
        this.frame = Buffer.alloc(0); this.bytes = 0; this.skipping = true; this.fail();
      }
      if (!this.skipping && length) {
        const required = this.bytes + length;
        if (required > this.frame.length) {
          const grown = Buffer.allocUnsafe(Math.min(this.maxFrameBytes, Math.max(4096, required, this.frame.length * 2)));
          this.frame.copy(grown, 0, 0, this.bytes); this.frame = grown;
        }
        chunk.copy(this.frame, this.bytes, offset, end); this.bytes = required;
      }
      if (newline < 0) break;
      if (!this.skipping && this.bytes) {
        try {
          const message: unknown = JSON.parse(this.frame.toString("utf8", 0, this.bytes));
          if (message && typeof message === "object" && !Array.isArray(message)) this.observe(message as Record<string, unknown>);
          else this.fail();
        } catch { this.fail(); }
      }
      this.bytes = 0; this.skipping = false; offset = newline + 1;
    }
  }

  private observe(message: Record<string, unknown>): void {
    if (this.broken || !root(message)) return;
    if (message.type !== "result" && !(message.type === "system" && ["init", "session_state_changed", "background_tasks_changed", "task_started", "task_updated", "task_progress", "task_notification"].includes(String(message.subtype)))) return;
    if (!identity(message.session_id)) { this.fail(); return; }
    this.session ??= message.session_id;
    if (message.session_id !== this.session) return;
    this.background.observe(message);
    if (this.background.busy) this.idleResult = undefined;
    if (message.type === "result") {
      if (!identity(message.uuid)) { this.fail(); return; }
      this.lastResult = { session: message.session_id, uuid: message.uuid };
      if (!acknowledgement(message)) { this.lastSubstantiveResult = this.lastResult; this.needsSubstantiveResult = false; }
      this.idleResult = undefined;
      return;
    }
    if (message.subtype !== "session_state_changed") return;
    if (message.state === "running" || message.state === "requires_action") { this.idleResult = undefined; return; }
    if (message.state !== "idle") { this.fail(); return; }
    if (this.background.busy) {
      // Native may idle while an ended agent still owns a background command. Its
      // waiting result is never reusable when that command later leaves inventory:
      // a new substantive continuation and a fresh idle must follow.
      this.lastResult = undefined; this.lastSubstantiveResult = undefined; this.idleResult = undefined;
      this.needsSubstantiveResult = true; return;
    }
    if (this.needsSubstantiveResult) return;
    // The raw reader can be ahead of the SDK iterator. Bind idle to an exact result,
    // never to whichever earlier result the adapter has happened to consume so far.
    this.idleResult = this.lastSubstantiveResult ?? this.lastResult;
    if (this.idleResult) this.ready();
  }
}
