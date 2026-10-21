import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, lstat, chown, chmod, rm, copyFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessAdapter, HarnessRun } from "../harness/adapter.js";
import type { AgentProcessTransport } from "../runtime/transport.js";
import { isNodeEntry, resolveCodexCommand } from "../harness/codex-binary.js";

/** Normal Linux credentials separate the control backend from the selected provider CLI.
 * Profiles are staged in the container layer, so NTFS bind permission reporting is not a gate. */
export async function prepareNativeProfile(home: string, kind: "claude" | "codex", uid: number) {
  const parent = "/run/hosty-execution";
  await mkdir(parent, { recursive: true, mode: 0o711 }); await chmod(parent, 0o711);
  const root = await mkdtemp(path.join(parent, "profile-"));
  const histories = kind === "codex" ? ["sessions", "archived_sessions"] : ["projects"];
  try {
    // Only the selected account and its native history cross the control boundary.
    for (const name of ["auth.json", ...histories]) {
      const source = path.join(home, name);
      const info = await lstat(source).catch(() => null);
      if (!info) continue;
      if (name === "auth.json") { if (!info.isFile()) throw new Error("Provider authorization must be a regular file."); await copyFile(source, path.join(root, name)); }
      else {
        const { realpath } = await import("node:fs/promises");
        await copyHistory(await realpath(source), path.join(root, name));
      }
    }
    await own(root, uid);
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  const groups = new Set<number>();
  const transport: AgentProcessTransport = { spawn(provider, args, options) {
    const executable = provider === "codex" ? resolveCodexCommand() : "/opt/hosty-worker/claude";
    const env = Object.fromEntries(Object.entries(options.env).filter(([key]) => !key.startsWith("HOSTY_") && !["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"].includes(key)));
    const child = spawn(isNodeEntry(executable) ? process.execPath : executable, isNodeEntry(executable) ? [executable, ...args] : args,
      { cwd: options.cwd, env: { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: options.cwd, HOME: root, [provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]: root }, uid, gid: uid, detached: true, stdio: "pipe" });
    if (child.pid) groups.add(child.pid);
    return child;
  } };
  let finished = false;
  return { root, transport, close: async () => {
    if (finished) return;
    // These are the process groups created by this transport, never a host-wide UID search.
    for (const group of groups) await stopGroup(group);
    // No arbitrary symlink, profile script or configuration is copied back into trusted storage.
    const auth = path.join(root, "auth.json");
    if ((await lstat(auth).catch(() => null))?.isFile()) {
      if ((await lstat(auth)).size > 64000) throw new Error("Provider authorization exceeds its limit.");
      const value = await readFile(auth, "utf8"); JSON.parse(value);
      const { writeFile } = await import("node:fs/promises"); await writeFile(path.join(home, "auth.json"), value, { mode: 0o600 });
    }
    for (const name of histories) if (await lstat(path.join(root, name)).catch(() => null)) await copyHistory(path.join(root, name), path.join(home, name));
    await rm(root, { recursive: true, force: true }); finished = true;
  } };
}

async function copyHistory(source: string, target: string): Promise<void> {
  const info = await lstat(source);
  if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw new Error("Provider history contains an unsupported link or special file.");
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    for (const name of await readdir(source)) await copyHistory(path.join(source, name), path.join(target, name));
  } else await cp(source, target, { force: true, dereference: false });
}
async function own(root: string, uid: number): Promise<void> {
  await chown(root, uid, uid);
  const info = await lstat(root); await chmod(root, info.isDirectory() ? 0o700 : 0o600);
  if (info.isDirectory()) for (const name of await readdir(root)) await own(path.join(root, name), uid);
}
export function isolatedAdapter(adapter: HarnessAdapter, profile: Awaited<ReturnType<typeof prepareNativeProfile>>): HarnessAdapter {
  return { name: adapter.name, capabilities: adapter.capabilities, probe: async () => ({ available: true }), dispose: profile.close, start: options => {
    let run: HarnessRun;
    try { run = adapter.start({ ...options, processTransport: profile.transport }); }
    catch (error) { void profile.close(); throw error; }
    const stop = async () => { if (run.stopAndWait) await run.stopAndWait(); else await run.stop(); await profile.close(); };
    return { send: text => run.send(text), resolveApproval: (...args) => run.resolveApproval(...args), resolveQuestion: (...args) => run.resolveQuestion(...args),
      setMcpServers: servers => run.setMcpServers(servers), interrupt: () => run.interrupt(), stop, stopAndWait: stop };
  } };
}

async function stopGroup(group: number): Promise<void> {
  const signal = (value: NodeJS.Signals | 0): boolean => {
    try { process.kill(-group, value); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  };
  if (!signal("SIGTERM")) return;
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!signal(0)) return;
    if (attempt === 5) signal("SIGKILL");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (signal(0)) throw new Error("The known agent process group has not exited; retain its execution claim.");
}
