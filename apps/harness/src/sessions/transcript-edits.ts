import path from "node:path";
import type { DevelopmentWorkspace } from "./development.js";

import type { TranscriptFileEdit } from "./transcript-edit-types.js";
const MAX_FILES = 200;
const MAX_PATH = 4_096;
const fields = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const lines = (value: string): number => value ? value.split("\n").length - (value.endsWith("\n") ? 1 : 0) : 0;

/** Bounded display metadata, never a filesystem probe or an authority to inspect another source. */
export function transcriptFileEdits(toolName: string, input: unknown, sessionId: string,
  workspaces: readonly DevelopmentWorkspace[], cwd?: string): TranscriptFileEdit[] {
  const source = fields(input);
  const changes: { path?: string; kind: string; before?: string; after?: string; diff?: string; stats?: { additions: number; deletions: number } }[] = [];
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(toolName)) {
    const file = text(source.file_path) ?? text(source.notebook_path);
    if (toolName === "MultiEdit" && Array.isArray(source.edits)) {
      // One transcript entry per file; repeated replacements contribute their own supplied counts.
      const edits = source.edits.slice(0, MAX_FILES).map(fields);
      changes.push({ path: file, kind: "edit", stats: edits.every(e => typeof e.old_string === "string" && typeof e.new_string === "string") ? edits.reduce<{ additions: number; deletions: number }>((total, e) => ({ additions: total.additions + lines(text(e.new_string) ?? ""), deletions: total.deletions + lines(text(e.old_string) ?? "") }), { additions: 0, deletions: 0 }) : undefined });
    } else changes.push({ path: file, kind: toolName === "Write" ? "write" : "edit",
      before: text(source.old_string), after: text(source.new_string) ?? text(source.content), });
  } else if (toolName === "FileChange" && Array.isArray(source.changes)) {
    for (const entry of source.changes.slice(0, MAX_FILES)) {
      const change = fields(entry);
      changes.push({ path: text(change.path), kind: text(change.kind) ?? text(fields(change.kind).type) ?? "edit",
        diff: text(change.diff) ?? text(change.unified_diff) });
    }
  }
  return changes.map(change => {
    const file = change.path;
    const display = file && !/[\0\r\n]/.test(file) ? file.slice(0, MAX_PATH) : "Unknown file";
    const stats = change.stats ?? (change.diff && change.diff.length <= 1_000_000 ? patchStats(change.diff)
      : change.before !== undefined && change.after !== undefined ? { additions: lines(change.after), deletions: lines(change.before) }
      : {});
    const unresolved = { path: display, kind: change.kind.slice(0, 64), ...stats,
      unavailable: "The transcript does not identify a registered worktree for this file." };
    if (!file || file.length > MAX_PATH || /[\0\r\n]/.test(file)) return unresolved;
    const flavor = /^[A-Za-z]:[\\/]/.test(file) || cwd && /^[A-Za-z]:[\\/]/.test(cwd) ? path.win32 : path.posix;
    // The adapter supplies its factual execution cwd. Never treat a current UI selection as cwd.
    if (!flavor.isAbsolute(file) && (!cwd || !flavor.isAbsolute(cwd))) return unresolved;
    const absolute = flavor.resolve(cwd ?? "/", file);
    const matches = workspaces.filter(tree => tree && tree.state !== "deleted" && typeof tree.path === "string" && flavor.isAbsolute(tree.path)).flatMap(tree => {
      const relative = flavor.relative(flavor.resolve(tree.path), absolute);
      return relative && relative !== ".." && !relative.startsWith(`..${flavor.sep}`) && !flavor.isAbsolute(relative)
        ? [{ tree, relative: relative.split(flavor.sep).join("/") }] : [];
    });
    const match = matches.length === 1 ? matches[0] : undefined;
    if (!match || !match.tree.workspaceId || !match.tree.repository) return unresolved;
    return { path: match.relative, kind: change.kind.slice(0, 64), ...stats, review: {
      sessionId, workspaceId: match.tree.workspaceId, worktreeId: match.tree.id,
      repository: match.tree.repository, path: match.relative,
    } };
  });
}
function patchStats(diff: string): { additions?: number; deletions?: number } {
  let additions = 0, deletions = 0, hunk = false, hasHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) { hunk = false; continue; }
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) { hunk = true; hasHunk = true; continue; }
    if (hunk && line.startsWith("+")) additions++;
    if (hunk && line.startsWith("-")) deletions++;
  }
  return hasHunk ? { additions, deletions } : {};
}
