import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DockerCli, type DockerCommands } from "./docker.js";
import { WORKER_IMAGE, WORKER_LIMITS } from "./image.js";
import type { AgentProcessTransport } from "./transport.js";

export interface WorkerBindings {
  instanceId: string; installationId: string; treesRoot: string; repositoriesRoot: string; worktreePaths: string[];
}
export interface WorkerMount { source: string; readonly?: boolean }
export interface WorkerState {
  version: 1; generation: string; sessionId: string; leaseId: string;
  name: string; instanceId: string; installationId: string; imageId: string;
  diskPaths?: string[];
  phase: "preparing" | "running" | "stopped";
}
export class WorkerError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
const LABEL = "hosty.agent-worker";
const hash = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9-]{36}$/;
export function workerEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // The parent may have SSH/GitHub/cloud credentials or a Core service token. None is inherited.
  const env: NodeJS.ProcessEnv = {
    HOME: "/worker/home", XDG_CACHE_HOME: "/worker/cache", TMPDIR: "/tmp",
    GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/worker/home/.gitconfig",
    NPM_CONFIG_CACHE: "/worker/cache/npm", NUGET_PACKAGES: "/worker/cache/nuget",
    DOTNET_CLI_HOME: "/worker/home", DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
  };
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && (["CODEX_HOME", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_SDK_READS_SESSION_STATE"].includes(key)
      || /^HOSTY_MCP_[A-Z0-9_]+$/.test(key))) env[key] = value;
  }
  return env;
}
function validPath(value: string): boolean {
  return path.isAbsolute(value) && !/[\r\n,\0]/.test(value) && path.normalize(value) === value && value !== "/";
}
export async function canonicalMount(source: string): Promise<string> {
  if (!validPath(source) || await realpath(source) !== source) throw new WorkerError("worker_mount_invalid", "A worker mount must be a canonical, non-root directory without symbolic redirects.");
  return source;
}

/** One installation owns one workload, including detached tool processes. No implicit queue. */
export class SharedDockerWorker {
  private state: WorkerState | null = null;
  private loaded = false;
  private claimant: string | null = null;
  private stopping: Promise<void> | null = null;
  private safeDirectories = new Set<string>();
  constructor(private readonly dataDir: string, private readonly cacheDir: string,
    private readonly docker: DockerCommands = new DockerCli()) {}
  private get file(): string { return path.join(this.dataDir, "worker", "state.json"); }
  private get scratch(): string { return path.join(this.cacheDir, "agent-worker", this.state!.generation); }
  private get cache(): string { return path.join(this.cacheDir, "agent-worker", "cache"); }
  get busy(): boolean { return this.claimant !== null; }
  get activeSession(): string | null { return this.claimant ?? this.state?.sessionId ?? null; }
  get current(): Readonly<WorkerState> | null { return this.state; }

  claim(sessionId: string): void {
    if (this.claimant !== null) throw new WorkerError("worker_busy", "The shared Docker agent is busy. Finish or stop its current conversation before sending another turn.");
    this.claimant = sessionId;
  }
  releaseClaim(sessionId: string): void {
    if (this.state) throw new WorkerError("worker_recovery_required", "The worker or its Core lease still requires recovery.");
    if (this.claimant === sessionId) this.claimant = null;
  }
  async load(): Promise<void> {
    if (this.loaded) return;
    const raw = await readFile(this.file, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (raw) {
      const state = JSON.parse(raw) as WorkerState;
      if (state.version !== 1 || !uuid.test(state.generation) || !uuid.test(state.leaseId) || !hash.test(state.instanceId)
        || !hash.test(state.installationId) || !/^[a-zA-Z0-9-]+$/.test(state.sessionId)
        || state.name !== this.name(state) || !/^sha256:[a-f0-9]{64}$/.test(state.imageId)
        || !["preparing", "running", "stopped"].includes(state.phase))
        throw new WorkerError("worker_state_invalid", "The worker ownership record is invalid. Preserve it and recover the owned container before continuing.");
      this.state = state;
    }
    this.loaded = true;
  }
  private name(state: Pick<WorkerState, "instanceId" | "installationId" | "generation">): string {
    return `hosty-agent-${state.instanceId.slice(0, 12)}-${state.installationId.slice(0, 12)}-${state.generation}`;
  }
  private async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = this.file + "." + randomUUID();
    await writeFile(temp, JSON.stringify(this.state), { mode: 0o600 });
    await rename(temp, this.file);
  }
  private async validateDaemon(): Promise<void> {
    const info = JSON.parse(await this.docker.run(["info", "--format", "{{json .}}"]));
    if (info.OSType !== "linux" || !["darwin", "linux"].includes(process.platform))
      throw new WorkerError("worker_host_unsupported", "Docker mode requires a Linux Docker engine on macOS or Linux.", 503);
    const daemon = await this.docker.run(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
    if (!daemon.trim().startsWith("unix://") || process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith("unix://"))
      throw new WorkerError("worker_daemon_unsupported", "Shared source mounts require a local Linux Docker engine.", 503);
  }
  async health(): Promise<{ available: boolean; reason?: string; image: string; state: Readonly<WorkerState> | null }> {
    try {
      await this.load();
      await this.validateDaemon();
      await this.image();
      return { available: !this.state || this.state.phase === "running" && this.claimant !== null,
        ...(this.state && !this.claimant ? { reason: "A previous worker generation requires Stop/recovery before reuse." } : {}), image: WORKER_IMAGE, state: this.state };
    } catch (error) { return { available: false, reason: error instanceof Error ? error.message : "Docker is unavailable.", image: WORKER_IMAGE, state: this.state }; }
  }
  async install(): Promise<void> {
    if (this.activeSession) throw new WorkerError("worker_busy", "Stop the shared worker before installing its image.");
    await this.docker.run(["pull", WORKER_IMAGE], 15 * 60_000);
    await this.image();
  }
  private async image(): Promise<string> {
    let images: Array<{ Id: string }>;
    try { images = JSON.parse(await this.docker.run(["image", "inspect", WORKER_IMAGE])); }
    catch { throw new WorkerError("worker_image_missing", `Install the Harness worker image ${WORKER_IMAGE} before enabling Docker execution.`, 503); }
    if (!images[0] || !/^sha256:[a-f0-9]{64}$/.test(images[0].Id)) throw new Error("Docker returned an invalid worker image identity.");
    return images[0].Id;
  }
  async prepare(sessionId: string, leaseId: string, bindings: WorkerBindings, cwd: string, providerMounts: WorkerMount[], acquireLease: () => Promise<void>): Promise<AgentProcessTransport> {
    await this.load();
    if (this.claimant !== sessionId || this.state) throw new WorkerError("worker_recovery_required", "Reconcile the previous worker generation before launching.");
    if (!hash.test(bindings.instanceId) || !hash.test(bindings.installationId) || !uuid.test(leaseId)) throw new Error("Core returned invalid worker ownership.");
    const trees = await canonicalMount(bindings.treesRoot), repositories = await canonicalMount(bindings.repositoriesRoot);
    if (path.dirname(trees) !== path.dirname(repositories) || path.basename(trees) !== "trees" || path.basename(repositories) !== "repositories") throw new Error("Core returned invalid shared source roots.");
    const sourceMounts = [{ source: trees }, { source: repositories, readonly: true }, { source: await canonicalMount(cwd) }, ...providerMounts];
    for (const mount of sourceMounts) await canonicalMount(mount.source);
    await this.validateDaemon();
    const generation = leaseId, imageId = await this.image();
    this.state = { version: 1, generation, sessionId, leaseId, instanceId: bindings.instanceId,
      installationId: bindings.installationId, name: "", imageId, phase: "preparing",
      diskPaths: [...new Set([trees, cwd, ...providerMounts.filter(m => !m.readonly).map(m => m.source)])] };
    this.state.name = this.name(this.state);
    await this.save(); // Intent precedes both the Core lease and Docker. Retry the same lease after uncertainty.
    await acquireLease();
    await mkdir(path.join(this.scratch, "home"), { recursive: true, mode: 0o700 });
    await mkdir(this.cache, { recursive: true, mode: 0o700 });
    await this.registerTrees(bindings.worktreePaths, bindings);
    const args = ["create", "--name", this.state.name, "--init", "--restart", "no", "--read-only",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--cpus", String(WORKER_LIMITS.cpus),
      "--memory", String(WORKER_LIMITS.memoryBytes), "--memory-swap", String(WORKER_LIMITS.memoryBytes),
      "--pids-limit", String(WORKER_LIMITS.pids), "--tmpfs", "/tmp:rw,nosuid,nodev,size=536870912,mode=1777",
      "--log-driver", "json-file", "--log-opt", "max-size=5m", "--log-opt", "max-file=2",
      "--network", "bridge", "--add-host", "host.docker.internal:host-gateway",
      "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      "--label", `${LABEL}=1`, "--label", `${LABEL}.instance=${bindings.instanceId}`,
      "--label", `${LABEL}.installation=${bindings.installationId}`, "--label", `${LABEL}.generation=${generation}`,
      "--label", "hosty.resource-role=agent",
      "--mount", `type=bind,src=${await canonicalMount(path.join(this.scratch, "home"))},dst=/worker/home`,
      "--mount", `type=bind,src=${await canonicalMount(this.cache)},dst=/worker/cache`];
    for (const mount of sourceMounts) args.push("--mount", `type=bind,src=${mount.source},dst=${mount.source}${mount.readonly ? ",readonly" : ""}`);
    args.push(imageId);
    await this.docker.run(args);
    await this.docker.run(["start", this.state.name]);
    const inspection = await this.inspect();
    if (!inspection?.State.Running) throw new Error("The worker did not start.");
    this.state.phase = "running"; await this.save();
    const current = this.state;
    return { spawn: (provider, providerArgs, options) => {
      if (this.state !== current || current.phase !== "running" || this.stopping) throw new WorkerError("worker_stopped", "The worker generation is no longer running.");
      const env = workerEnvironment(options.env);
      const args = ["exec", "-i", "--workdir", options.cwd];
      // Docker reads values from the exec client's environment. Secret values never enter its argv.
      for (const key of Object.keys(env)) args.push("--env", key);
      args.push(current.name, `/opt/hosty-worker/${provider}`, ...providerArgs);
      return this.docker.spawn(args, { ...process.env, ...env });
    } };
  }
  async registerTrees(paths: string[], bindings: WorkerBindings): Promise<void> {
    if (!this.state) return;
    for (const tree of paths) {
      if (path.dirname(tree) !== bindings.treesRoot || !hash.test(path.basename(tree))) throw new Error("Core returned an invalid worktree path.");
      await canonicalMount(tree); this.safeDirectories.add(tree);
    }
    // Git config string quoting is deliberately independent of shell quoting.
    const config = "[safe]\n" + [...this.safeDirectories].map(tree => `\tdirectory = ${JSON.stringify(tree)}\n`).join("");
    await writeFile(path.join(this.scratch, "home", ".gitconfig"), config, { mode: 0o600 });
  }
  private async inspect(): Promise<{ State: { Running: boolean }; Config: { Labels: Record<string, string> } } | null> {
    const state = this.state!;
    // List succeeds independently of absence. A daemon error must never masquerade as not found.
    const ids = (await this.docker.run(["ps", "-a", "--filter", `name=^/${state.name}$`, "--format", "{{.ID}}"])).split(/\s+/).filter(Boolean);
    if (ids.length === 0) return null;
    if (ids.length !== 1 || !/^[a-f0-9]{12,64}$/.test(ids[0]!)) throw new Error("Worker container inventory is ambiguous.");
    const items = JSON.parse(await this.docker.run(["inspect", ids[0]!])) as Array<{ State: { Running: boolean }; Config: { Labels: Record<string, string> } }>;
    const item = items[0], labels = item?.Config.Labels;
    if (!item || labels?.[LABEL] !== "1" || labels[`${LABEL}.instance`] !== state.instanceId
      || labels[`${LABEL}.installation`] !== state.installationId || labels[`${LABEL}.generation`] !== state.generation)
      throw new WorkerError("worker_ownership_conflict", "The container name is owned by another generation. It was preserved.");
    return item;
  }
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const stop = async () => {
      await this.load(); if (!this.state) return;
      if ((await this.inspect())?.State.Running) await this.docker.run(["stop", "--time", "10", this.state.name]);
      if ((await this.inspect())?.State.Running) throw new Error("Docker has not confirmed worker termination.");
      if (await this.inspect()) await this.docker.run(["rm", this.state.name]);
      if (await this.inspect()) throw new Error("The worker container is still present.");
      this.state.phase = "stopped"; await this.save();
    };
    this.stopping = stop();
    try { await this.stopping; } finally { this.stopping = null; }
  }
  /** Call only after Core acknowledged release of this generation's persistent shared-source lease. */
  async finish(): Promise<void> {
    if (!this.state) return;
    if (this.state.phase !== "stopped") throw new Error("Worker termination has not been verified.");
    await rm(this.scratch, { recursive: true, force: true });
    await rm(this.file, { force: true });
    this.state = null; this.safeDirectories.clear();
  }
  async diskUsage(): Promise<number> {
    if (!this.state || this.state.phase !== "running") throw new Error("No worker is running.");
    const paths = ["/worker/home", "/worker/cache", ...(this.state.diskPaths ?? [])];
    const args = ["exec", this.state.name, "du", "-sk", "--", ...paths];
    // Providers can replace cache files while du walks them. Retry one incomplete observation;
    // persistent failures still stop the workload, and partial output never becomes a quota sample.
    const raw = await this.docker.run(args, 60_000).catch(() => this.docker.run(args, 60_000));
    const lines = raw.split("\n");
    if (lines.length !== paths.length) throw new Error("Worker disk accounting is incomplete.");
    const values = lines.map(line => Number(line.split(/\s+/)[0]) * 1024);
    if (values.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error("Worker disk accounting is unavailable.");
    return values.reduce((sum, value) => sum + value, 0);
  }
  async sample(): Promise<{ memoryBytes: number; peakMemoryBytes: number; pids: number }> {
    if (!this.state || this.state.phase !== "running") throw new Error("No worker is running.");
    if (!(await this.inspect())?.State.Running) throw new Error("The worker stopped unexpectedly.");
    const raw = await this.docker.run(["exec", this.state.name, "cat", "/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/pids.current"]);
    const values = raw.split(/\s+/).map(Number);
    if (values.length !== 3 || values.some(v => !Number.isSafeInteger(v) || v < 0)) throw new Error("Worker cgroup accounting is unavailable.");
    return { memoryBytes: values[0]!, peakMemoryBytes: values[1]!, pids: values[2]! };
  }
}
