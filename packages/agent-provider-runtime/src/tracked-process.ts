import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { linuxWriterArgs, type WriterScope } from "./writer-scope.js";
import { prepareWindowsJob } from "./windows-job-cache.mjs";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, mkdirSync, statSync, statfsSync, realpathSync, rmdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { durableMkdir } from "./internal/persistence.js";
import { nativeEnvironment } from "./internal/runtime/environment.js";
import type { AgentProcessTransport, AgentSpawnOptions } from "./internal/runtime/transport.js";

const producerNonce = randomUUID();
type Manifest = { version: 1; runId: string; generation: string; sealed: boolean; targetsSealed?: true; spawns: string[]; targets?: string[]; producerPid: number; producerNonce: string; sdkStopConfirmed: boolean; restrictedHost?: true; cgroups?: Record<string, { path: string; dev: string; ino: string }> };
export type NativeProcessEvidence = { format: "hosty-native-stop.1"; runId: string; generation: string;
  stopped: boolean; allClosed: boolean; targetStopped?: boolean; writerScopeClosed?: boolean; sealed: boolean; spawnCount: number; reason?: string };
const identifier = (value: string) => { if (!/^[A-Za-z0-9-]{1,100}$/.test(value)) throw new Error("Invalid native execution identity."); return value; };
const receiptLimit = 64000;
async function receiptAt(file: string) {
  if (statSync(file).size > receiptLimit) throw new Error("Native receipt exceeds its size bound.");
  return JSON.parse(await readFile(file, "utf8"));
}
function matches(receipt: Record<string, unknown>, runId: string, generation: string, nonce: string) {
  return receipt.version === 1 && receipt.runId === runId && receipt.generation === generation && receipt.nonce === nonce;
}
async function targetExited(file: string, runId: string, generation: string, nonce: string): Promise<boolean> {
  try {
    const target = await receiptAt(file + ".target");
    if (matches(target, runId, generation, nonce) && target.targetExited === true) return true;
  } catch { /* A prior helper or forced group stop may only have a complete scope receipt. */ }
  try {
    const receipt = await receiptAt(file);
    return matches(receipt, runId, generation, nonce) && receipt.state === "stopped" && receipt.treeStopped === true;
  } catch { return false; }
}
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
  private readonly handles = new WeakMap<ChildProcessWithoutNullStreams, { ended: Promise<void>; exited: Promise<void>; file: string; nonce: string }>();
  private readonly closed = new Set<Promise<void>>();
  private stopped = false;
  private cleanupTask?: Promise<NativeProcessEvidence>;
  private constructor(private readonly root: string, private readonly manifest: Manifest, private readonly scope?: WriterScope, private readonly jobHelper?: string) {
    this.transport = {
      stopProcess: child => this.stopProcess(child),
      waitForTargetExit: child => this.waitForTargetExit(child),
      spawn: (command, args, options) => this.launch(options.command ?? command, args, options, true),
      spawnTool: (args, options) => this.launch(options.command ?? process.execPath, args, options, false, true),
      spawnCommand: (command, args, options) => this.launch(command, args, options),
    };
  }
  static async create(dataRoot: string, runId: string, generation: string, scope?: WriterScope, restrictedHost?: true): Promise<TrackedNativeProcesses> {
    const root = directory(dataRoot, runId, generation);
    const jobHelper = process.platform === "win32"
      ? scope?.kind === "windows-job" && scope.helper ? scope.helper : await prepareWindowsJob(dataRoot)
      : undefined;
    await durableMkdir(root);
    const manifest: Manifest = { version: 1, runId, generation, sealed: false, spawns: [], targets: [], producerPid: process.pid, producerNonce, sdkStopConfirmed: false, ...(restrictedHost ? { restrictedHost } : {}) };
    const file = path.join(root, "manifest.json");
    const fd = openSync(file, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(manifest)); fsyncSync(fd); } finally { closeSync(fd); }
    if (process.platform !== "win32") { const parent = openSync(root, "r"); try { fsyncSync(parent); } finally { closeSync(parent); } }
    return new TrackedNativeProcesses(root, manifest, scope, jobHelper);
  }
  private launch(command: string, args: string[], options: AgentSpawnOptions, target = false, helper = false): ChildProcessWithoutNullStreams {
    if (this.stopped || this.manifest.sealed || this.manifest.targetsSealed && !helper)
      throw new Error("The native execution is sealed.");
    options.signal?.throwIfAborted();
    if (this.manifest.spawns.length >= 256) throw new Error("Native process budget exceeded.");
    const nonce = randomUUID(), file = path.join(this.root, nonce + ".json");
    // Both the complete intent set and this individual intent precede every process effect.
    durable(file, { version: 1, runId: this.manifest.runId, generation: this.manifest.generation, nonce, state: "intent", treeStopped: false });
    let cgroup: string | undefined;
    if (this.scope?.kind === "linux-cgroup") {
      cgroup = path.join(this.scope.directory, "hosty-" + nonce);
      mkdirSync(cgroup);
      const identity = statSync(cgroup, { bigint: true });
      (this.manifest.cgroups ??= {})[nonce] = { path: cgroup, dev: String(identity.dev), ino: String(identity.ino) };
    }
    this.manifest.spawns.push(nonce);
    if (target) this.manifest.targets!.push(nonce);
    durable(path.join(this.root, "manifest.json"), this.manifest);
    const runner = fileURLToPath(new URL("./native-runner.mjs", import.meta.url));
    const env = nativeProcessEnvironment(options.env, options.bearerVariables);
    const child = spawn(process.execPath, [runner], { cwd: options.cwd, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe", "ipc"] }) as ChildProcessWithoutNullStreams;
    this.children.add(child);
    let resolve!: () => void; const ended = new Promise<void>(accept => { resolve = accept; }); this.closed.add(ended);
    let markTargetExited!: () => void;
    const exited = new Promise<void>(accept => { markTargetExited = accept; });
    child.on("message", message => {
      const event = message as { targetExited?: boolean; nonce?: string } | null;
      if (event?.targetExited === true && event.nonce === nonce) markTargetExited();
    });
    this.handles.set(child, { ended, exited, file, nonce });
    const originalKill = child.kill.bind(child);
    const requestStop = () => { if (child.exitCode === null && child.signalCode === null && child.connected) child.send({ stop: true, nonce }); };
    // SDK hard-kill escalation requests owned-tree shutdown; it must not kill the receipt writer.
    child.kill = signal => { if (signal === 0) return originalKill(0); requestStop(); return true; };
    const abort = () => requestStop(); options.signal?.addEventListener("abort", abort, { once: true });
    child.once("close", () => { options.signal?.removeEventListener("abort", abort); this.children.delete(child); resolve(); });
    child.once("error", () => {
      if (!child.pid) {
        try { durable(file, { version: 1, runId: this.manifest.runId, generation: this.manifest.generation, nonce, state: "stopped", treeStopped: true,
          ...(process.platform === "win32" ? { mechanism: "windows-not-started.1" } : {}) }); } catch { /* Missing durable proof remains unknown. */ }
        this.children.delete(child); resolve();
      }
    });
    child.send({ version: 1, runId: this.manifest.runId, generation: this.manifest.generation, nonce, file, command: cgroup ? "/usr/bin/bwrap" : command, args: cgroup ? [...linuxWriterArgs, "--", command, ...args] : args, cwd: options.cwd, cgroup, jobHelper: this.jobHelper }, error => {
      if (error) requestStop();
    });
    return child;
  }
  private async waitForTargetExit(child: ChildProcessWithoutNullStreams): Promise<void> {
    const handle = this.handles.get(child);
    if (!handle) throw new Error("This process handle is not owned by this execution.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([handle.exited, handle.ended, new Promise<void>(resolve => {
        timer = setTimeout(resolve, 10000); timer.unref();
      })]);
      if (await targetExited(handle.file, this.manifest.runId, this.manifest.generation, handle.nonce)) return;
      throw Object.assign(new Error("The native target has not confirmed exit."), { code: "exit_unconfirmed" });
    } finally { clearTimeout(timer); }
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
  async confirmSdkStop(drainOutput = false): Promise<void> {
    this.manifest.targetsSealed = true;
    const targets = this.manifest.targets!;
    const exited = await Promise.all(targets.map(nonce => targetExited(path.join(this.root, nonce + ".json"), this.manifest.runId, this.manifest.generation, nonce)));
    if (!exited.every(Boolean)) throw new Error("The SDK ended without proof of the owned native target's exit.");
    this.manifest.sdkStopConfirmed = true;
    if (!drainOutput) { this.stopped = true; this.manifest.sealed = true; }
    durable(path.join(this.root, "manifest.json"), this.manifest);
  }
  get drainingOutput(): boolean {
    return this.cleanupTask !== undefined || this.manifest.targetsSealed === true && !this.manifest.sealed;
  }
  stop(): Promise<NativeProcessEvidence> {
    return this.cleanupTask ??= this.closeScopes().finally(() => { this.cleanupTask = undefined; });
  }
  private async closeScopes(): Promise<NativeProcessEvidence> {
    this.stopped = true; this.manifest.sealed = true;
    try { durable(path.join(this.root, "manifest.json"), this.manifest); }
    finally { for (const child of this.children) child.kill("SIGTERM"); }
    // A missing receipt or an unresponsive writer stays unknown; never guess a PID after restart.
    await Promise.race([Promise.allSettled([...this.closed]), new Promise<void>(resolve => { const timer = setTimeout(resolve, 12000); timer.unref(); })]);
    return this.evidence();
  }
  evidence(): Promise<NativeProcessEvidence> { return TrackedNativeProcesses.readEvidence(path.dirname(path.dirname(path.dirname(this.root))), this.manifest.runId, this.manifest.generation); }
  static async readEvidence(dataRoot: string, runId: string, generation: string, exclusiveSuccessor = false, preferTarget = false): Promise<NativeProcessEvidence> {
    const root = directory(dataRoot, runId, generation);
    const base: NativeProcessEvidence = { format: "hosty-native-stop.1", runId, generation, stopped: false, allClosed: false, sealed: false, spawnCount: 0 };
    try {
      const file = path.join(root, "manifest.json");
      try { statSync(file); } catch (error) {
        // The manifest is fsynced before any spawn. The exclusive successor owns the gate.
        if (exclusiveSuccessor && (error as NodeJS.ErrnoException).code === "ENOENT")
          return { ...base, allClosed: true, stopped: true, targetStopped: true, writerScopeClosed: true, sealed: true };
        throw error;
      }
      const manifest = await receiptAt(file) as Manifest;
      if (manifest.version !== 1 || manifest.runId !== runId || manifest.generation !== generation || typeof manifest.sealed !== "boolean" || typeof manifest.sdkStopConfirmed !== "boolean" || !Array.isArray(manifest.spawns)
        || manifest.spawns.length > 256 || new Set(manifest.spawns).size !== manifest.spawns.length
        || manifest.targets !== undefined && (!Array.isArray(manifest.targets)
          || new Set(manifest.targets).size !== manifest.targets.length || manifest.targets.some(nonce => !manifest.spawns.includes(nonce)))
        || !Number.isSafeInteger(manifest.producerPid) || manifest.producerPid <= 0 || typeof manifest.producerNonce !== "string" || !/^[a-f0-9-]{36}$/.test(manifest.producerNonce)) return { ...base, reason: "invalid_manifest" };
      for (const nonce of manifest.spawns) identifier(nonce);
      base.sealed = manifest.sealed;
      base.spawnCount = manifest.spawns.length;
      let producerExited = false;
      try { process.kill(manifest.producerPid, 0); }
      catch (error) { producerExited = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      // The exclusive successor holds the attempt lock. A sealed producer cannot register more targets.
      const successor = exclusiveSuccessor && manifest.producerNonce !== producerNonce;
      const producerStopped = manifest.sealed || producerExited || successor;
      const targets = manifest.targets ?? manifest.spawns;
      if ((producerStopped || manifest.targetsSealed === true) && (targets.length
        ? (await Promise.all(targets.map(nonce => targetExited(path.join(root, nonce + ".json"), runId, generation, nonce)))).every(Boolean)
        : manifest.sdkStopConfirmed || successor)) base.targetStopped = true;
      if (preferTarget && base.targetStopped) return base;
      const qualified = manifest.spawns.every(nonce => !!manifest.cgroups?.[nonce] || process.platform === "win32");
      if (qualified && manifest.spawns.length) base.writerScopeClosed = false;
      for (const nonce of manifest.spawns) {
        const receiptFile = path.join(root, nonce + ".json");
        const receipt = await receiptAt(receiptFile);
        if (!matches(receipt, runId, generation, nonce)) return { ...base, reason: "invalid_receipt" };
        const scope = manifest.cgroups?.[nonce];
        if (scope && successor) {
          // Only the successor owning the attempt lock may finish a crashed writer's exact cgroup.
          if (process.platform !== "linux" || !scope.path.startsWith("/sys/fs/cgroup/") || path.basename(scope.path) !== "hosty-" + nonce)
            return { ...base, reason: "invalid_cgroup" };
          try {
            const current = statSync(scope.path, { bigint: true });
            if (realpathSync(scope.path) !== scope.path || String(current.dev) !== scope.dev || String(current.ino) !== scope.ino || statfsSync(scope.path).type !== 0x63677270)
              return { ...base, reason: "invalid_cgroup" };
            writeFileSync(path.join(scope.path, "cgroup.kill"), "1");
            if (!/^populated 0$/m.test(readFileSync(path.join(scope.path, "cgroup.events"), "utf8"))) return { ...base, reason: "scope_closing" };
            rmdirSync(scope.path);
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          durable(path.join(root, nonce + ".closed.json"), { version: 1, runId, generation, nonce, state: "stopped", treeStopped: true, mechanism: "linux-cgroup-successor.2" });
          continue;
        }
        if (process.platform === "win32" && successor &&
          (receipt.state !== "stopped" || receipt.treeStopped !== true)) {
          const recoveredFile = path.join(root, nonce + ".closed.json");
          try {
            const previous = JSON.parse(await readFile(recoveredFile, "utf8"));
            if (previous.runId === runId && previous.generation === generation && previous.nonce === nonce && previous.treeStopped === true) continue;
          } catch { /* Incomplete or missing proof requires kernel verification. */ }
          const helper = await prepareWindowsJob(dataRoot);
          await promisify(execFile)(helper, ["hosty-native-" + nonce, receiptFile], { windowsHide: true, timeout: 15000 });
          durable(recoveredFile, { version: 1, runId, generation, nonce, state: "stopped", treeStopped: true, mechanism: "windows-job-successor.2" });
          continue;
        }
        if (receipt.state !== "stopped" || receipt.treeStopped !== true)
          return { ...base, reason: "stop_unconfirmed" };
        if (process.platform === "win32" && receipt.mechanism !== "windows-not-started.1"
          && !(receipt.mechanism === "windows-job.1" && receipt.activeProcesses === 0 && receipt.knownHandlesClosed === true))
          return { ...base, reason: "invalid_job_receipt" };
      }
      // A previous unrestricted POSIX process could change its process group. Receipts for
      // the original group cannot prove closure of its independently detached descendants.
      if (exclusiveSuccessor && !qualified && !manifest.restrictedHost)
        return { ...base, ...(producerStopped ? { targetStopped: true } : {}), reason: "unqualified_descendants" };
      const stopped = producerStopped && manifest.sdkStopConfirmed || successor;
      return { ...base, stopped, allClosed: true, ...(stopped ? { targetStopped: true } : {}),
        ...(qualified && producerStopped ? { writerScopeClosed: true } : {}),
        ...(!stopped ? { reason: !producerStopped ? "producer_active" : "sdk_stop_unconfirmed" } : {}) };
    } catch { return { ...base, reason: "evidence_unavailable" }; }
  }
}
