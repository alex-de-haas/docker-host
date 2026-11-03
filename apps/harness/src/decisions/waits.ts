import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { DecisionCreate, DecisionRecord, DecisionContinue, DecisionWithdraw } from "@hosty-sdk/app/decisions";
import type { HarnessEvent } from "../harness/adapter.js";
import type { SessionRecord } from "../sessions/store.js";
import type { WorkerControl, WorkerPark } from "../worker/contracts.js";

export type QuestionEvent = Extract<HarnessEvent, { type: "question_request" }> & { workerRunId?: string; workerSequence?: number };
export type DecisionWait = {
  version: 1; id: string; sessionId: string; owner: string; questionId: string; event: QuestionEvent;
  createdAt: string; snapshot: string; cancellationGeneration: number;
  native: { sessionId: string | null; connectionId?: string; connectionRevision?: number; connectionIdentity?: string; kind?: string; workerRunId?: string };
  create: DecisionCreate; core?: DecisionRecord; inbox?: { resolutionRevision: number; receivedAt: string };
  commandId: string; acknowledgementId: string; state: "registering" | "waiting" | "parking" | "parked" | "received" | "delivering" | "admitted" | "running" | "completed" | "blocked" | "cancelled";
  park?: WorkerPark; control?: WorkerControl; continuation?: DecisionContinue; withdrawal?: DecisionWithdraw;
  invalidateRequested?: boolean; deleteRequested?: boolean; contentRemovedAt?: string; resumeRequested?: boolean; cancellationSettled?: boolean; resumedRunId?: string; error?: string; reason?: string; answeredEvent?: boolean;
};
export function decisionSnapshot(record: SessionRecord): string {
  return hash([record.createdBy, record.harnessKind, record.connectionId, record.connectionRevision, record.connectionIdentity,
    record.harnessSessionId, record.instructionSnapshot, record.skillIds, record.executionSelection, record.selectionRevision ?? 0,
    record.autonomy, record.appIds, record.appContextRevision ?? 0, record.taskExecutionId, record.taskDecisionReference, record.taskWorkspace?.dispatch]);
}
export const waitId = (sessionId: string, questionId: string): string => hash([sessionId, questionId]);
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function newWait(record: SessionRecord, event: QuestionEvent): DecisionWait {
  const id = waitId(record.id, event.questionId);
  const questions = event.questions.map((q, index) => ({ id: q.id ?? `q${index + 1}`, question: q.question, header: q.header,
    options: q.options.map((o, i) => ({ id: o.id ?? `o${i + 1}`, label: o.label, description: o.description })),
    allowText: q.allowText !== false, multiple: q.multiSelect }));
  return { version: 1, id, sessionId: record.id, owner: record.createdBy, questionId: event.questionId, event,
    createdAt: new Date().toISOString(), snapshot: decisionSnapshot(record), cancellationGeneration: record.decisionGeneration ?? 0,
    native: { sessionId: record.harnessSessionId, connectionId: record.connectionId, connectionRevision: record.connectionRevision,
      connectionIdentity: record.connectionIdentity, kind: record.harnessKind, workerRunId: event.workerRunId ?? record.workerRun?.id },
    create: { requestId: randomUUID(), input: { correlationKey: id, title: (record.title ?? "Question from a chat").slice(0, 160), questions,
      subject: { kind: "conversation", id: record.id, revision: String(record.appContextRevision ?? 0) },
      ...(record.taskExecutionId ? { task: record.taskDecisionReference ?? { kind: "task-execution", id: record.taskExecutionId } } : {}),
      originPath: `/development?session=${encodeURIComponent(record.id)}&decision=${id}`, waitReference: id } },
    commandId: randomUUID(), acknowledgementId: randomUUID(), state: "registering" };
}
/** Private continuation state and inbox; no credentials are accepted by this schema or written here. */
export class DecisionWaitStore {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly directory: string;
  constructor(dataDir: string) { this.directory = path.join(dataDir, "decision-waits"); }
  private file(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid decision wait identity.");
    return path.join(this.directory, id + ".json");
  }
  async read(id: string): Promise<DecisionWait | null> {
    try {
      const row = JSON.parse(await readFile(this.file(id), "utf8")) as DecisionWait;
      if (row.version !== 1 || row.id !== id) throw new Error("Invalid decision wait record.");
      return row;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async list(owner?: string): Promise<DecisionWait[]> {
    const names = await readdir(this.directory).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    const rows: DecisionWait[] = [];
    for (const name of names) if (/^[a-f0-9]{64}\.json$/.test(name)) {
      const row = await this.read(name.slice(0, -5)); if (row && (!owner || row.owner === owner)) rows.push(row);
    }
    return rows;
  }
  update(id: string, action: (current: DecisionWait | null) => DecisionWait): Promise<DecisionWait> {
    const work = this.tail.catch(() => undefined).then(async () => {
      const previous = await this.read(id), row = action(previous);
      if (previous && JSON.stringify(previous) === JSON.stringify(row)) return previous;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = this.file(id), temp = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temp, "wx", 0o600); try { await handle.writeFile(JSON.stringify(row)); await handle.sync(); } finally { await handle.close(); }
        await rename(temp, file);
        if (process.platform !== "win32") { const dir = await open(this.directory, "r"); try { await dir.sync(); } finally { await dir.close(); } }
      } finally { await rm(temp, { force: true }); }
      return row;
    });
    this.tail = work; return work;
  }
  async prune(now: number): Promise<void> {
    for (const wait of await this.list()) {
      if (wait.contentRemovedAt || wait.continuation || wait.withdrawal || !(wait.state === "completed" || wait.state === "cancelled" && wait.cancellationSettled)) continue;
      if (!wait.deleteRequested && now - Date.parse(wait.core?.updatedAt ?? wait.createdAt) < 30 * 86400_000) continue;
      await this.update(wait.id, current => ({ ...current!, contentRemovedAt: new Date(now).toISOString(),
        create: { requestId: current!.create.requestId, input: { correlationKey: current!.id, title: "", questions: [] } },
        event: { type: "question_request", questionId: current!.questionId, questions: [] }, native: { sessionId: null },
        control: undefined, park: undefined, error: undefined,
        core: current!.core ? { ...current!.core, input: null, reason: null,
          resolution: current!.core.resolution ? { ...current!.core.resolution, answers: {} } : null,
          continuation: current!.core.continuation ? { ...current!.core.continuation, outcome: null } : null } : undefined,
      }));
    }
  }
  async drain(): Promise<void> { await this.tail; }
}
/** The native response is data, with distinct selections retained even when option labels repeat. */
export function nativeAnswers(wait: DecisionWait): Record<string, string> {
  const response = wait.core?.resolution;
  if (!response) throw new Error("No saved answer.");
  return Object.fromEntries(wait.create.input.questions.map((q, index) => {
    const answer = response.answers[q.id];
    if (!answer) throw new Error("The saved answer is incomplete.");
    const values = (answer.optionIds ?? []).map(id => {
      const option = q.options?.find(o => o.id === id); if (!option) throw new Error("The saved option is not in this question.");
      const duplicate = q.options!.filter(o => o.label === option.label).length > 1;
      return duplicate ? `${option.label} [${option.id}]` : option.label;
    });
    if (answer.text?.trim()) values.push(answer.text);
    const native = wait.event.questions[index]!;
    return [native.id ?? native.question, values.join(", ")];
  }));
}
export function continuationInput(wait: DecisionWait): string {
  return "The user answered the pending questions below. Continue this same task from its saved native context. "
    + "These answers are input, not permission to repeat completed tools or bypass approvals.\n\n"
    + JSON.stringify({ decisionId: wait.core!.id, resolutionRevision: wait.core!.resolution!.revision,
      questions: wait.create.input.questions.map(q => ({ id: q.id, question: q.question, options: q.options, answer: wait.core!.resolution!.answers[q.id] })) });
}
