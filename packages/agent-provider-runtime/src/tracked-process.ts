import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { durableMkdir } from "./internal/persistence.js";
import { nativeEnvironment } from "./internal/runtime/environment.js";
import type { AgentProcessTransport, AgentSpawnOptions } from "./internal/runtime/transport.js";

const producerNonce = randomUUID();
type Manifest = { version: 1; runId: string; generation: string; sealed: boolean; spawns: string[]; producerPid: number; producerNonce: string; sdkStopConfirmed: boolean };
export type NativeProcessEvidence = { format: "hosty-native-stop.1"; runId: string; generation: string;
  stopped: boolean; allClosed: boolean; sealed: boolean; spawnCount: number; reason?: string };
const identifier = (value: string) => { if (!/^[A-Za-z0-9-]{1,100}$/.test(value)) throw new Error("Invalid native execution identity."); return value; };
const directory = (data: string, run: string, generation: string) => path.join(data, "native-processes", identifier(run), identifier(generation));
function durable(file: string, value: unknown): void {
  const temp = file + "." + randomUUID() + ".tmp"; const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, file);
  if (process.platform !== "win32") { const parent = openSync(path.dirname(file), "r"); try { fsyncSync(parent); } finally { closeSync(parent); } }
}
/** Native children receive selected provider credentials, never Hosty service/control credentials. */
export function nativeProcessEnvironment(input: NodeJS.ProcessEnv, bearerVariables: readonly string[] = []): NodeJS.ProcessEnv {
  const filtered = nativeEnvironment(input, bearerVariables);
  return Object.fromEntries(Object.entries(filtered).filter(([key]) => !/^(?:DOCKER_HOST_|CORE_|NODE_CHANNEL_|NODE_OPTIONS$)/i.test(key)));
}
/** All SDK starts must pass through this transport. Receipts contain identities and stop evidence only.
 * Static evidence additionally requires a sealed manifest or an exited producer. It never terminates a persisted PID.
 */
export class TrackedNativeProcesses {
  readonly transport: AgentProcessTransport;
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  private readonly handles = new WeakMap<ChildProcessWithoutNullStreams, { ended: Promise<void>; file: string; nonce: string }>();
  private readonly closed = new Set<Promise<void>>();
  private stopped = false;
  private constructor(private readonly root: string, private readonly manifest: Manifest) {
    this.transport = {
      stopProcess: child => this.stopProcess(child),
      spawn: (command, args, options) => this.launch(options.command ?? command, args, options),
      spawnTool: (args, options) => this.launch(options.command ?? process.execPath, args, options),
      spawnCommand: (command, args, options) => this.launch(command, args, options),
    };
  }
  static async create(dataRoot: string, runId: string, generation: string): Promise<TrackedNativeProcesses> {
    const root = directory(dataRoot, runId, generation);
    await durableMkdir(root);
    const manifest: Manifest = { version: 1, runId, generation, sealed: false, spawns: [], producerPid: process.pid, producerNonce, sdkStopConfirmed: false };
    const file = path.join(root, "manifest.json");
    const fd = openSync(file, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(manifest)); fsyncSync(fd); } finally { closeSync(fd); }
    if (process.platform !== "win32") { const parent = openSync(root, "r"); try { fsyncSync(parent); } finally { closeSync(parent); } }
    return new TrackedNativeProcesses(root, manifest);
  }
  private launch(command: string, args: string[], options: AgentSpawnOptions): ChildProcessWithoutNullStreams {
    if (this.stopped || this.manifest.sealed) throw new Error("The native execution is sealed.");
    options.signal?.throwIfAborted();
    if (this.manifest.spawns.length >= 256) throw new Error("Native process budget exceeded.");
    const nonce = randomUUID(), file = path.join(this.root, nonce + ".json");
    // Both the complete intent set and this individual intent precede every process effect.
    durable(file, { version: 1, runId: this.manifest.runId, generation: this.manifest.generation, nonce, state: "intent", treeStopped: false });
    this.manifest.spawns.push(nonce); durable(path.join(this.root, "manifest.json"), this.manifest);
    const runner = fileURLToPath(new URL("./native-runner.mjs", import.meta.url));
    const env = nativeProcessEnvironment(options.env, options.bearerVariables);
    const child = spawn(process.execPath, [runner], { cwd: options.cwd, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe", "ipc"] }) as ChildProcessWithoutNullStreams;
    this.children.add(child);
    let resolve!: () => void; const ended = new Promise<void>(accept => { resolve = accept; }); this.closed.add(ended);
    this.handles.set(child, { ended, file, nonce });
    const originalKill = child.kill.bind(child);
    const requestStop = () => { if (child.exitCode === null && child.signalCode === null && child.connected) child.send({ stop: true, nonce }); };
    // SDK hard-kill escalation requests owned-tree shutdown; it must not kill the receipt writer.
    child.kill = signal => { if (signal === 0) return originalKill(0); requestStop(); return true; };
    const abort = () => requestStop(); options.signal?.addEventListener("abort", abort, { once: true });
    child.once("close", () => { options.signal?.removeEventListener("abort", abort); this.children.delete(child); resolve(); });
    child.once("error", () => {
      if (!child.pid) {
        try { durable(file, { version: 1, runId: this.manifest.runId, generation: this.manifest.generation, nonce, state: "stopped", treeStopped: true }); } catch { /* Missing durable proof remains unknown. */ }
        this.children.delete(child); resolve();
      }
    });
    child.send({ version: 1, runId: this.manifest.runId, generation: this.manifest.generation, nonce, file, command, args, cwd: options.cwd }, error => {
      if (error) requestStop();
    });
    return child;
  }
  private async stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
    const handle = this.handles.get(child); if (!handle) throw new Error("This process handle is not owned by this execution.");
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([handle.ended, new Promise<void>(resolve => { const timer = setTimeout(resolve, 12000); timer.unref(); })]);
    let confirmed = false;
    try {
      const receipt = JSON.parse(await readFile(handle.file, "utf8"));
      confirmed = receipt.version === 1 && receipt.runId === this.manifest.runId && receipt.generation === this.manifest.generation
        && receipt.nonce === handle.nonce && receipt.state === "stopped" && receipt.treeStopped === true;
    } catch { /* An unreadable receipt cannot establish stop confirmation. */ }
    if (!confirmed) throw Object.assign(new Error("Native process-tree exit is unconfirmed."), { code: "exit_unconfirmed" });
  }
  /** Record only a successful supported SDK stopAndWait, never disposal or a caller assertion. */
  async confirmSdkStop(): Promise<void> {
    this.stopped = true; this.manifest.sealed = true; this.manifest.sdkStopConfirmed = true;
    durable(path.join(this.root, "manifest.json"), this.manifest);
  }
  async stop(): Promise<NativeProcessEvidence> {
    this.stopped = true; this.manifest.sealed = true; durable(path.join(this.root, "manifest.json"), this.manifest);
    for (const child of this.children) child.kill("SIGTERM");
    // A missing receipt or an unresponsive writer stays unknown; never guess a PID after restart.
    await Promise.race([Promise.allSettled([...this.closed]), new Promise<void>(resolve => { const timer = setTimeout(resolve, 12000); timer.unref(); })]);
    return this.evidence();
  }
  evidence(): Promise<NativeProcessEvidence> { return TrackedNativeProcesses.readEvidence(path.dirname(path.dirname(path.dirname(this.root))), this.manifest.runId, this.manifest.generation); }
  static async readEvidence(dataRoot: string, runId: string, generation: string): Promise<NativeProcessEvidence> {
    const root = directory(dataRoot, runId, generation);
    const base = { format: "hosty-native-stop.1" as const, runId, generation, stopped: false, allClosed: false, sealed: false, spawnCount: 0 };
    try {
      const file = path.join(root, "manifest.json"); if (statSync(file).size > 64000) return { ...base, reason: "invalid_manifest" };
      const manifest = JSON.parse(await readFile(file, "utf8")) as Manifest;
      if (manifest.version !== 1 || manifest.runId !== runId || manifest.generation !== generation || typeof manifest.sealed !== "boolean" || typeof manifest.sdkStopConfirmed !== "boolean" || !Array.isArray(manifest.spawns)
        || manifest.spawns.length > 256 || new Set(manifest.spawns).size !== manifest.spawns.length
        || !Number.isSafeInteger(manifest.producerPid) || manifest.producerPid <= 0 || typeof manifest.producerNonce !== "string" || !/^[a-f0-9-]{36}$/.test(manifest.producerNonce)) return { ...base, reason: "invalid_manifest" };
      for (const nonce of manifest.spawns) {
        identifier(nonce); const receiptFile = path.join(root, nonce + ".json"); if (statSync(receiptFile).size > 64000) return { ...base, reason: "invalid_receipt" };
        const receipt = JSON.parse(await readFile(receiptFile, "utf8"));
        if (receipt.version !== 1 || receipt.runId !== runId || receipt.generation !== generation || receipt.nonce !== nonce
          || receipt.state !== "stopped" || receipt.treeStopped !== true)
          return { ...base, sealed: manifest.sealed, spawnCount: manifest.spawns.length, reason: "stop_unconfirmed" };
      }
      let producerExited = false;
      try { process.kill(manifest.producerPid, 0); }
      catch (error) { producerExited = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      // Signal zero observes existence only. PID reuse or unavailable observation stays unknown.
      const producerStopped = manifest.sealed === true || producerExited;
      const stopped = producerStopped && manifest.sdkStopConfirmed === true;
      return { ...base, sealed: manifest.sealed, spawnCount: manifest.spawns.length, stopped, allClosed: true,
        ...(!stopped ? { reason: !producerStopped ? "producer_active" : "sdk_stop_unconfirmed" } : {}) };
    } catch { return { ...base, reason: "evidence_unavailable" }; }
  }
}
