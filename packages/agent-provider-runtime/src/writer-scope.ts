import { spawnSync } from "node:child_process";
import { constants, accessSync, mkdirSync, readFileSync, realpathSync, rmdirSync, statfsSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";

export const writerCapability = "scope.workspace-writers";
export type WriterScope = { kind: "windows-job" } | { kind: "linux-cgroup"; directory: string };

/** Only an already delegated cgroup may be used. The provider never changes host delegation. */
export function linuxWriterScope(): WriterScope | undefined {
  if (process.platform !== "linux") return;
  let probe: string | undefined;
  try {
    const membership = readFileSync("/proc/self/cgroup", "utf8").split("\n").find(line => line.startsWith("0::/"))?.slice(3);
    if (!membership || membership.split("/").includes("..")) return;
    const mount = "/sys/fs/cgroup";
    const directory = realpathSync(path.join(mount, membership));
    if (directory !== mount && !directory.startsWith(mount + "/") || statfsSync(directory).type !== 0x63677270) return;
    const candidate = path.join(directory, "hosty-probe-" + randomUUID());
    mkdirSync(candidate); probe = candidate;
    accessSync(path.join(candidate, "cgroup.procs"), constants.W_OK);
    writeFileSync(path.join(candidate, "cgroup.kill"), "1");
    if (!/^populated 0$/m.test(readFileSync(path.join(candidate, "cgroup.events"), "utf8"))) return;
    // Namespace init confines detached descendants. Hide host /proc and make delegation controls read-only to the native user.
    const check = spawnSync("/usr/bin/bwrap", [...linuxWriterArgs, "--", "/bin/true"], { timeout: 4000, stdio: "ignore" });
    if (check.status === 0) return { kind: "linux-cgroup", directory };
  } catch { /* Unsupported, inaccessible or read-only delegation cannot admit a workspace writer. */ }
  finally { if (probe) try { rmdirSync(probe); } catch { /* Empty probe directory may be reclaimed by the delegated host. */ } }
  return undefined;
}
export const linuxWriterArgs = ["--die-with-parent", "--unshare-pid", "--bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--ro-bind", "/sys/fs/cgroup", "/sys/fs/cgroup", "--cap-drop", "ALL"];

export async function probeWriterScope(data: string, diagnostic?: (message: string) => void): Promise<WriterScope | undefined> {
  if (process.platform !== "win32") return linuxWriterScope();
  const trial = await mkdtemp(path.join(data, "job-probe-"));
  const { TrackedNativeProcesses } = await import("./tracked-process.js");
  const processes = await TrackedNativeProcesses.create(trial, randomUUID(), randomUUID());
  try {
    const system = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!system || !path.isAbsolute(system)) return;
    // Stock PowerShell compiles the private bridge in the writable per-probe temporary directory.
    const env = { SystemRoot: system, WINDIR: system, TEMP: trial, TMP: trial, USERPROFILE: trial,
      PATH: path.join(system, "System32"), ComSpec: path.join(system, "System32", "cmd.exe") };
    const child = processes.transport.spawn(process.execPath, ["-e", "process.exit(0)"], { cwd: trial, env });
    let stderr = "";
    child.stderr.on("data", chunk => { if (diagnostic && stderr.length < 2048) stderr += String(chunk).slice(0, 2048 - stderr.length); });
    child.stdout.resume();
    child.stdin.end();
    const [exit, signal] = await once(child, "close", { signal: AbortSignal.timeout(45000) });
    if (exit !== 0) { diagnostic?.(`Windows no-op exited ${exit ?? signal}. ${stderr.trim()}`); return; }
    await processes.confirmSdkStop();
    const proof = await processes.stop();
    if (proof.allClosed && proof.stopped && proof.spawnCount === 1) return { kind: "windows-job" };
    diagnostic?.(`Windows no-op has no physical receipt (${proof.reason ?? "invalid proof"}).`);
  } catch (error) { diagnostic?.(`Windows no-op probe failed (${(error as Error).name}).`); }
  finally { await processes.stop(); await rm(trial, { recursive: true, force: true }); }
  return undefined;
}
