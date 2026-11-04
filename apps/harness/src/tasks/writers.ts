import path from "node:path";
import { realpath } from "node:fs/promises";
import type { TaskExecutionReceipt } from "@hosty-sdk/app/tasks";
import type { DevelopmentWorkspace } from "../sessions/development.js";
import { TaskStore, taskError, type TaskState } from "./store.js";

export type WriteScope = { mode: "read" | "write" | "exclusive"; paths: string[] };
type Claim = { executionId: string; rootId: string; workspaceId: string; repositories: string[]; scope: WriteScope; held: boolean };
export function writeScope(value: unknown): WriteScope {
  if (value === undefined) return { mode: "exclusive", paths: [] };
  const input = value as WriteScope;
  if (!input || !["read", "write", "exclusive"].includes(input.mode) || !Array.isArray(input.paths) || input.paths.length > 100
    || Object.keys(input).some(key => !["mode", "paths"].includes(key))) return taskError("write_scope_invalid", "Declare read, write or exclusive repository-relative prefixes.", 400);
  const paths = [...new Set(input.paths.map(item => {
    if (typeof item !== "string" || !item || item.length > 2000 || /[\\\x00-\x1f\x7f]/.test(item) || path.posix.isAbsolute(item)
      || item.split("/").some(part => part === ".." || !part) || /^[a-z]:/i.test(item)) return taskError("write_scope_invalid", "Use normalized repository-relative paths without traversal.", 400);
    return path.posix.normalize(item);
  }))].sort();
  const broad = !paths.length || paths.includes(".") || input.mode !== "read" && paths.some(item => /(^|\/)(\.git|[^/]*\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum)(\/|$)/.test(item));
  return { mode: broad ? "exclusive" : input.mode, paths: broad ? [] : paths };
}
function overlap(a: string, b: string) { return a === b || a.startsWith(b + "/") || b.startsWith(a + "/"); }
export function writerConflict(a: WriteScope, b: WriteScope): boolean {
  return a.mode === "exclusive" || b.mode === "exclusive" || !(a.mode === "read" && b.mode === "read") && a.paths.some(x => b.paths.some(y => overlap(x, y)));
}
/** Cooperative source ownership, shared by all roots in the same logical workspace. */
export class TaskWriters {
  constructor(private readonly store: TaskStore) {}
  private async checkedScope(scope: WriteScope, sources: DevelopmentWorkspace[]): Promise<WriteScope> {
    if (scope.mode === "exclusive") return scope;
    for (const source of sources) {
      let root: string;
      try { root = await realpath(source.path); } catch { return { mode: "exclusive", paths: [] }; }
      for (const prefix of scope.paths) {
        let candidate = path.resolve(root, prefix);
        while (candidate !== root) {
          try {
            const resolved = await realpath(candidate);
            if (resolved !== root && !resolved.startsWith(root + path.sep)) return taskError("write_scope_escape", "A declared prefix resolves outside its repository.", 400);
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            candidate = path.dirname(candidate);
          }
        }
      }
    }
    return scope;
  }
  async reserve(rootId: string, taskId: string, executionId: string, workspaceId: string, sources: DevelopmentWorkspace[], admit?: (state: TaskState) => boolean): Promise<boolean> {
    const declared = await this.store.readJournal<WriteScope>("write-scope:" + taskId);
    const scope = await this.checkedScope(writeScope(declared), sources), repositories = sources.map(source => source.id).sort();
    if (!repositories.length) return taskError("workspace_unavailable", "No source repository is available for this execution.");
    return this.store.transaction(s => {
      const claims = Object.entries(s.journal ?? {}).filter(([key]) => key.startsWith("writer:")).map(([, row]) => row as Claim);
      if (claims.some(claim => claim.executionId !== executionId && claim.held && claim.workspaceId === workspaceId
        && claim.repositories.some(id => repositories.includes(id)) && writerConflict(claim.scope, scope))) return false;
      if (admit && !admit(s)) return false;
      (s.journal ??= {})["writer:" + executionId] = { executionId, rootId, workspaceId, repositories, scope, held: true } satisfies Claim; return true;
    });
  }
  observe(executionId: string, receipt: TaskExecutionReceipt): Promise<void> {
    return this.store.transaction(s => {
      const claim = s.journal?.["writer:" + executionId] as Claim | undefined;
      if (claim && (receipt.stopConfirmed || receipt.nativeStopConfirmed)) claim.held = false;
    });
  }
}
