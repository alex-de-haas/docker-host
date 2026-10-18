import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SharedDockerWorker, workerEnvironment, type WorkerBindings } from "./worker.js";
import type { DockerCommands } from "./docker.js";

const fixtures: string[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "hosty-worker-"))); fixtures.push(root);
  const bindings: WorkerBindings = { instanceId: "a".repeat(64), installationId: "b".repeat(64),
    treesRoot: path.join(root, "development/trees"), repositoriesRoot: path.join(root, "development/repositories"), worktreePaths: [] };
  const cwd = path.join(root, "session"), home = path.join(root, "provider");
  bindings.worktreePaths.push(path.join(bindings.treesRoot, "c".repeat(64)));
  for (const dir of [bindings.repositoriesRoot, ...bindings.worktreePaths, cwd, home]) await mkdir(dir, { recursive: true });
  let container: { running: boolean; labels: Record<string, string> } | null = null;
  let failStop = false, lostDaemon = false;
  const commands: string[][] = [];
  const docker: DockerCommands = {
    spawn: vi.fn() as unknown as DockerCommands["spawn"],
    async run(args) {
      commands.push(args);
      if (lostDaemon) throw new Error("daemon lost");
      if (args[0] === "context") return "unix:///docker.sock";
      if (args[0] === "image") return JSON.stringify([{ Id: "sha256:" + "d".repeat(64) }]);
      if (args[0] === "info") return JSON.stringify({ OSType: "linux" });
      if (args[0] === "create") { container = { running: false, labels: {} }; args.forEach((arg, i) => { if (arg === "--label") { const [key, ...value] = args[i + 1]!.split("="); container!.labels[key!] = value.join("="); } }); return "e".repeat(64); }
      if (args[0] === "start") { container!.running = true; return ""; }
      if (args[0] === "ps") return container ? "e".repeat(12) : "";
      if (args[0] === "inspect") return JSON.stringify([{ Config: { Labels: container!.labels }, State: { Running: container!.running } }]);
      if (args[0] === "stop") { if (failStop) throw new Error("stop unknown"); container!.running = false; return ""; }
      if (args[0] === "rm") { container = null; return ""; }
      throw new Error("unexpected Docker command");
    },
  };
  const make = () => new SharedDockerWorker(path.join(root, "data"), path.join(root, "cache"), docker);
  const worker = make(), lease = "11111111-1111-4111-8111-111111111111";
  const acquire = vi.fn(async () => {});
  const launch = async () => { worker.claim("session-one"); return worker.prepare("session-one", lease, bindings, cwd, [{ source: home }], acquire); };
  return { root, bindings, cwd, worker, make, acquire, launch, commands, docker,
    failStop: () => { failStop = true; }, lose: () => { lostDaemon = true; }, recover: () => { failStop = false; lostDaemon = false; },
    steal: () => { container!.labels["hosty.agent-worker.generation"] = "someone-else"; } };
}
describe("shared Docker worker", () => {
  it("owns one workload, freezes image identity and maps only approved roots", async () => {
    const f = await fixture(); const transport = await f.launch();
    expect(f.acquire).toHaveBeenCalledOnce();
    expect(() => f.worker.claim("session-two")).toThrow(/busy/);
    const create = f.commands.find(args => args[0] === "create")!;
    expect(create.at(-1)).toBe("sha256:" + "d".repeat(64));
    expect(create).toContain(`type=bind,src=${f.bindings.repositoriesRoot},dst=${f.bindings.repositoriesRoot},readonly`);
    expect(create.join(" ")).not.toContain("docker.sock");
    expect(create).toContain("4294967296"); expect(create).toContain("512");
    transport.spawn("codex", ["app-server"], { cwd: f.cwd, env: { HOSTY_APP_SERVICE_TOKEN: "private", ANTHROPIC_API_KEY: "selected" } });
    const [args, env] = vi.mocked(f.docker.spawn).mock.calls[0]!;
    expect(args).toContain("ANTHROPIC_API_KEY"); expect(args.join(" ")).not.toContain("selected");
    expect(args).not.toContain("HOSTY_APP_SERVICE_TOKEN"); expect(env.ANTHROPIC_API_KEY).toBe("selected");
    await f.worker.stop(); expect(() => f.worker.releaseClaim("session-one")).toThrow(/lease/);
    await f.worker.finish(); f.worker.releaseClaim("session-one");
    expect(f.worker.activeSession).toBeNull();
    expect(() => transport.spawn("codex", [], { cwd: f.cwd, env: {} })).toThrow(/no longer running/);
  });
  it("retains ownership after uncertain stop and reconciles the same generation after restart", async () => {
    const f = await fixture(); await f.launch(); const original = f.worker.current!;
    f.failStop(); await expect(f.worker.stop()).rejects.toThrow("stop unknown");
    await expect(f.worker.finish()).rejects.toThrow(/not been verified/);
    const restarted = f.make(); await restarted.load(); expect(restarted.current).toEqual(original);
    f.lose(); await expect(restarted.stop()).rejects.toThrow("daemon lost");
    expect(restarted.current?.leaseId).toBe(original.leaseId);
    f.recover(); await restarted.stop(); await restarted.finish();
    expect(restarted.current).toBeNull();
  });
  it("preserves a container with conflicting ownership", async () => {
    const f = await fixture(); await f.launch(); f.steal();
    await expect(f.worker.stop()).rejects.toThrow(/another generation/);
    expect(f.commands.some(args => args[0] === "stop" || args[0] === "rm")).toBe(false);
  });
  it("persists intent before acquiring the Core lease and retains it on an unknown response", async () => {
    const f = await fixture(); f.worker.claim("session-one");
    await expect(f.worker.prepare("session-one", "11111111-1111-4111-8111-111111111111", f.bindings, f.cwd, [], async () => {
      const saved = JSON.parse(await readFile(path.join(f.root, "data/worker/state.json"), "utf8"));
      expect(saved.phase).toBe("preparing"); throw new Error("Core reply lost");
    })).rejects.toThrow("Core reply lost");
    expect(f.commands.some(args => args[0] === "create")).toBe(false);
    expect(f.worker.current?.phase).toBe("preparing");
    await f.worker.stop(); await f.worker.finish();
  });
  it("rejects symbolic root redirects before acquiring a lease", async () => {
    const f = await fixture(); const link = path.join(f.root, "alias"); await symlink(f.cwd, link);
    f.worker.claim("session-one");
    await expect(f.worker.prepare("session-one", "11111111-1111-4111-8111-111111111111", f.bindings, link, [], f.acquire)).rejects.toThrow(/canonical/);
    expect(f.acquire).not.toHaveBeenCalled();
  });
  it("retries an interrupted disk walk once and rejects persistent or incomplete accounting", async () => {
    const f = await fixture(); await f.launch();
    const run = vi.spyOn(f.docker, "run");
    const rows = ["/worker/home", "/worker/cache", ...f.worker.current!.diskPaths!].map(p => `4\t${p}`).join("\n");
    run.mockRejectedValueOnce(new Error("file disappeared")).mockResolvedValueOnce(rows);
    expect(await f.worker.diskUsage()).toBe(5 * 4096);
    expect(run).toHaveBeenCalledTimes(2);
    run.mockRejectedValueOnce(new Error("unavailable")).mockRejectedValueOnce(new Error("still unavailable"));
    await expect(f.worker.diskUsage()).rejects.toThrow("still unavailable");
    run.mockResolvedValueOnce("4\t/worker/home");
    await expect(f.worker.diskUsage()).rejects.toThrow("incomplete");
  });
  it("forwards only selected provider and scoped MCP variables", () => {
    const env = workerEnvironment({ HOME: "/host", HOSTY_APP_SERVICE_TOKEN: "core", GITHUB_TOKEN: "github", SSH_AUTH_SOCK: "/ssh", AWS_ACCESS_KEY_ID: "aws", OPENAI_API_KEY: "unselected", CODEX_HOME: "/managed", HOSTY_MCP_BEARER_A: "session" });
    expect(env).toMatchObject({ HOME: "/worker/home", CODEX_HOME: "/managed", GIT_OPTIONAL_LOCKS: "0", HOSTY_MCP_BEARER_A: "session" });
    for (const key of ["GITHUB_TOKEN", "SSH_AUTH_SOCK", "AWS_ACCESS_KEY_ID", "OPENAI_API_KEY", "HOSTY_APP_SERVICE_TOKEN"]) expect(env[key]).toBeUndefined();
  });
});
