import { mkdir, mkdtemp, realpath, rm, symlink, lstat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { HarnessAdapter, HarnessRun, HarnessStartOptions } from "../harness/adapter.js";

/** Resolve only an app-scoped Core export ID, never a caller-provided host path. */
export async function resolveSkillExport(root: string | undefined, id: string | undefined): Promise<string | undefined> {
  if (!id) return undefined;
  if (!root || !/^[a-f0-9]{64}$/.test(id)) throw new Error("The Core skill export collection is unavailable.");
  const parent = await realpath(root), selected = await realpath(path.join(parent, id));
  if (path.dirname(selected) !== parent) throw new Error("The skill export redirects outside its collection.");
  return selected;
}

function skillLink(home: string, relativePath: string): string {
  const target = path.resolve(home, relativePath), relative = path.relative(path.resolve(home), target);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
    throw new Error("Native skill discovery must stay inside its owned directory.");
  return target;
}

export async function linkSkillDirectory(home: string, relativePath: string, selected: string): Promise<void> {
  const target = skillLink(home, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await symlink(selected, target, process.platform === "win32" ? "junction" : "dir");
}

export type SkillAdapterOptions = {
  selected: string;
  relativePath: string;
  /** An application-owned durable directory; omitted for a temporary discovery home. */
  directory?: string;
  canonicalize?: boolean;
  prepare?: (root: string) => Promise<Pick<HarnessStartOptions, "nativeConfigHome" | "nativeHistoryHome">>;
  beforeProbe?: (root: string) => Promise<void>;
  close?: (root: string) => Promise<void>;
};

/** Applications supply native layout and credential/history policy; this helper owns isolation lifetime. */
export async function skillAdapter(adapter: HarnessAdapter, options: SkillAdapterOptions): Promise<HarnessAdapter> {
  const durable = options.directory !== undefined;
  let root = options.directory ?? await mkdtemp(path.join(os.tmpdir(), "hosty-skills-"));
  let nativeOptions: Pick<HarnessStartOptions, "nativeConfigHome" | "nativeHistoryHome"> = {};
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (options.canonicalize) root = await realpath(root);
    const link = skillLink(root, options.relativePath);
    if (durable) {
      const existing = await lstat(link).catch(() => null);
      if (existing && !existing.isSymbolicLink()) throw new Error("Unexpected native skill directory.");
      if (existing) await rm(link);
    }
    await linkSkillDirectory(root, options.relativePath, options.selected);
    nativeOptions = await options.prepare?.(root) ?? {};
  } catch (error) { if (!durable) await rm(root, { recursive: true, force: true }); throw error; }
  let closed = false;
  const close = async () => {
    if (closed) return;
    await options.close?.(root);
    if (!durable) await rm(root, { recursive: true, force: true });
    closed = true;
  };
  return {
    name: adapter.name, capabilities: adapter.capabilities,
    probe: async () => { const health = await adapter.probe(); if (health.available) await options.beforeProbe?.(root); return health; },
    dispose: async () => { try { await adapter.dispose?.(); } finally { await close(); } },
    start: input => {
      let run: HarnessRun;
      try { run = adapter.start({ ...input, nativeHome: root, ...nativeOptions }); }
      catch (error) { void close(); throw error; }
      const stop = async () => { if (run.stopAndWait) await run.stopAndWait(); else await run.stop(); await close(); };
      return { send: text => run.send(text), resolveApproval: (...args) => run.resolveApproval(...args),
        resolveQuestion: (...args) => run.resolveQuestion(...args), setMcpServers: value => run.setMcpServers(value),
        interrupt: () => run.interrupt(), stop, ...(run.stopAndWait ? { stopAndWait: stop } : {}),
        disableSuggestions: run.disableSuggestions ? () => run.disableSuggestions!() : undefined,
        finishSuggestions: run.finishSuggestions ? () => run.finishSuggestions!() : undefined,
        readUsage: run.readUsage ? () => run.readUsage!() : undefined };
    },
  };
}
