import type { AgentRunControlInput } from "@hosty-sdk/app/agent";
import type { ConnectionModelCatalog } from "../connections/types.js";
import type { HarnessEvent } from "../harness/adapter.js";

/** Display/settings types retained while old stored records are rejected by the cutover guard. */
export type ExecutionSelection = { model: string | null; reasoningEffort: string | null };
export type ModelCatalog = ConnectionModelCatalog;
export type ModelChoice = ModelCatalog["models"][number];
export type ResourceReference = { kind: "conversation"; id: string } | { kind: "worktree"; id: string; revision: string; path?: string };
export type BarrierKind = Extract<AgentRunControlInput, { command: "barrier" }>["kind"];
export type ExecutionUsage = { sequence: number; activeMs: number; unknown: boolean };
export type WorkerBarrier = { controlId: string; expectedRevision: number; kind: BarrierKind; barrierId: string; generation: number; acknowledgedSequence: number; origin?: "coordinator" };
export type WorkerRecovery = { requestId: string; generation: string; expectedRevision: number; consumerExitConfirmed: true; actorId: string; conversationId?: string };
export type WorkerEvent = { runId: string; generation: string; sequence: number; event: HarnessEvent };
export type WorkerReceipt = { usage?: ExecutionUsage };
