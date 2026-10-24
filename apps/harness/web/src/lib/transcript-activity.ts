import type { AssistantEvent } from "./assistant-api";
import { transcriptEdits, type TranscriptFileEdit } from "./transcript-edits";
export type ActivityKind = "reads" | "edits" | "command" | "other";
export type ActivityRun = { kind: ActivityKind; key: string; events: AssistantEvent[] };
export type CommandOutcome = { status: "completed" | "failed" | "cancelled" | "unknown"; exitCode?: number; durationMs?: number; summary?: string; conflict?: boolean };
const readTools = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch"]);
const editTools = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "FileChange"]);
export const isCommandTool = (event: AssistantEvent) => event.type === "tool_use" && ["Bash", "Command"].includes(String(event.toolName));
export function activityKind(event: AssistantEvent): ActivityKind {
  const tool = String(event.toolName ?? "");
  return isCommandTool(event) ? "command" : readTools.has(tool) ? "reads" : editTools.has(tool) ? "edits" : "other";
}
/** Consecutive compatible calls share a row while retaining their individual identities. */
export function activityRuns(events: readonly AssistantEvent[]): ActivityRun[] {
  const runs: ActivityRun[] = [];
  for (const event of events) {
    const kind = activityKind(event), last = runs.at(-1);
    if (last?.kind === kind) last.events.push(event);
    else runs.push({ kind, key: `${kind}-${event.seq}`, events: [event] });
  }
  return runs;
}
export function readActivityLabel(events: readonly AssistantEvent[]): string {
  const files = events.filter(e => e.toolName === "Read").length;
  const searches = events.filter(e => ["Glob", "Grep"].includes(String(e.toolName))).length;
  const web = events.filter(e => ["WebFetch", "WebSearch"].includes(String(e.toolName))).length;
  const parts = [files ? `${files} ${files === 1 ? "file" : "files"}` : "", searches ? `${searches} ${searches === 1 ? "search" : "searches"}` : "", web ? `${web} web ${web === 1 ? "request" : "requests"}` : ""].filter(Boolean);
  return `Read ${parts.join(" and ")}`;
}
export type RecordedFileEdit = TranscriptFileEdit & { key: string; calls: number };
export function recordedFileEdits(events: readonly AssistantEvent[]): RecordedFileEdit[] {
  const edits = new Map<string, RecordedFileEdit>();
  for (const event of events) transcriptEdits(event).forEach((edit, index) => {
    const ref = edit.review;
    const key = ref ? JSON.stringify([ref.sessionId, ref.workspaceId, ref.worktreeId, ref.repository, ref.path]) : JSON.stringify([event.seq, index]);
    const prior = edits.get(key);
    if (!prior) edits.set(key, { ...edit, key, calls: 1 });
    else edits.set(key, { ...prior, calls: prior.calls + 1,
      additions: safeSum(prior.additions, edit.additions), deletions: safeSum(prior.deletions, edit.deletions) });
  });
  return [...edits.values()];
}
export type RecordedEditGroup = { key: string; repository?: string; edits: RecordedFileEdit[] };
/** Repository labels decorate groups; only the complete recorded source identity joins entries. */
export function recordedEditGroups(edits: readonly RecordedFileEdit[]): RecordedEditGroup[] {
  const groups = new Map<string, RecordedEditGroup>();
  for (const edit of edits) {
    const ref = edit.review;
    const key = ref ? JSON.stringify([ref.sessionId, ref.workspaceId, ref.worktreeId, ref.repository]) : JSON.stringify(["unbound", edit.key]);
    const group = groups.get(key);
    if (group) group.edits.push(edit);
    else groups.set(key, { key, repository: ref?.repository, edits: [edit] });
  }
  return [...groups.values()];
}
/** A direction is known only when every recorded entry supplies a safe count. */
export function recordedEditTotals(edits: readonly RecordedFileEdit[]) {
  return {
    additions: edits.reduce<number | undefined>((total, edit) => safeSum(total, edit.additions), 0),
    deletions: edits.reduce<number | undefined>((total, edit) => safeSum(total, edit.deletions), 0),
  };
}
function safeSum(a?: number, b?: number): number | undefined {
  return a !== undefined && b !== undefined && Number.isSafeInteger(a + b) ? a + b : undefined;
}
export function commandResultId(event: AssistantEvent): string | null {
  return typeof event.toolUseId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(event.toolUseId) ? event.toolUseId : null;
}
/** A second allowlist protects restored logs too; stdout/output are never presentation fields. */
export function commandOutcome(event: AssistantEvent): CommandOutcome {
  if (event.type !== "command_result" || !commandResultId(event) || typeof event.status !== "string"
    || !["completed", "failed", "cancelled", "unknown"].includes(event.status)) return { status: "unknown" };
  const code = event.exitCode, duration = event.durationMs;
  if (code !== undefined && (!Number.isSafeInteger(code) || Number(code) < -2_147_483_648 || Number(code) > 2_147_483_647)
    || duration !== undefined && (!Number.isSafeInteger(duration) || Number(duration) < 0 || Number(duration) > 604_800_000)
    || event.status === "completed" && code !== undefined && code !== 0) return { status: "unknown" };
  const status = event.status as CommandOutcome["status"];
  const summary = (status === "completed" || status === "failed") && typeof event.summary === "string" && /^(?:[0-9]{1,7} passed|[0-9]{1,7} failed|[0-9]{1,7} passed · [0-9]{1,7} failed)$/.test(event.summary) && event.summary.length <= 64 ? event.summary : undefined;
  return { status, ...(code !== undefined ? { exitCode: Number(code) } : {}),
    ...(duration !== undefined ? { durationMs: Number(duration) } : {}), ...(summary ? { summary } : {}) };
}
export function commandDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${milliseconds} ms` : `${Number((milliseconds / 1_000).toFixed(1))} s`;
}
