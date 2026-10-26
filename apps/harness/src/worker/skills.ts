import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { HarnessAdapter, HarnessRun } from "../harness/adapter.js";

/** Resolve only an app-scoped Core export ID, never a caller-provided host path. */
export async function resolveSkillExport(root: string | undefined, id: string | undefined): Promise<string | undefined> {
  if (!id) return undefined;
  if (!root || !/^[a-f0-9]{64}$/.test(id)) throw new Error("The Core skill export collection is unavailable.");
  const parent = await realpath(root), selected = await realpath(path.join(parent, id));
  if (path.dirname(selected) !== parent) throw new Error("The skill export redirects outside its collection.");
  return selected;
}

export async function linkSkillDirectory(home: string, kind: "codex" | "claude", selected: string): Promise<void> {
  const target = kind === "codex" ? path.join(home, ".agents", "skills") : path.join(home, "skills");
  await mkdir(path.dirname(target), { recursive: true });
  await symlink(selected, target, process.platform === "win32" ? "junction" : "dir");
}

/** Only discovery HOME is per run. Codex retains the selected connection's CODEX_HOME/auth/history. */
export async function skillAdapter(adapter: HarnessAdapter, home: string, kind: "codex" | "claude", selected: string): Promise<HarnessAdapter> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-skills-"));
  try {
    await linkSkillDirectory(root, kind, selected);
    if (kind === "claude") {
      const history = path.join(home, "projects");
      await mkdir(history, { recursive: true });
      await symlink(history, path.join(root, "projects"), process.platform === "win32" ? "junction" : "dir");
    }
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  let closed = false;
  const close = async () => { if (closed) return; await rm(root, { recursive: true, force: true }); closed = true; };
  return {
    name: adapter.name, capabilities: adapter.capabilities, probe: () => adapter.probe(), dispose: async () => { await adapter.dispose?.(); await close(); },
    start: options => {
      let run: HarnessRun;
      try { run = adapter.start({ ...options, nativeHome: root }); }
      catch (error) { void close(); throw error; }
      const stop = async () => { if (run.stopAndWait) await run.stopAndWait(); else await run.stop(); await close(); };
      return { send: text => run.send(text), resolveApproval: (...args) => run.resolveApproval(...args),
        resolveQuestion: (...args) => run.resolveQuestion(...args), setMcpServers: value => run.setMcpServers(value),
        interrupt: () => run.interrupt(), stop, stopAndWait: stop };
    },
  };
}
