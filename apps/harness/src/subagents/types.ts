import type { AgentRunSnapshot } from "@hosty-sdk/app/agent";

export interface SessionSubagent {
  id: string;
  profileId: string;
  profileName: string;
  prompt: string;
  status: "starting" | "running" | "awaiting_approval" | "awaiting_question" | "completed" | "failed" | "cancelled" | "unknown";
  result?: string;
  detail?: string;
  chatAvailable?: boolean;
}

export interface ChildLaunch {
  child: SessionSubagent;
  requestId: string;
  runId: string;
  profileRevision: number;
  title?: string;
  workspace?: { id: string; revision: number };
  workspaceResolved?: boolean;
  appIds: string[];
  autonomy: "normal" | "autonomous";
  dispatched: boolean;
  workspaceCheck?: "pending" | "complete";
}

export interface ChildWait {
  requestId: string;
  childSessionIds: string[];
  mode: "any" | "all";
  runId: string;
  state: "pending" | "ready" | "returned" | "delivered" | "cancelled" | "failed";
  outcomes?: SessionSubagent[];
  error?: string;
}

export interface SessionFamily {
  launches: ChildLaunch[];
  waits: ChildWait[];
}

export function childFinished(child: SessionSubagent): boolean {
  return ["completed", "failed", "cancelled"].includes(child.status);
}

export function observeChild(child: SessionSubagent, run: AgentRunSnapshot, stateOnly: boolean): SessionSubagent {
  const { result: _result, detail: _detail, ...progress } = child;
  if (run.stopConfirmed && ["succeeded", "failed", "cancelled"].includes(run.state)) {
    if (stateOnly && !run.result && run.state === "succeeded") return child;
    const message = run.messages?.find(message => message.id === run.result?.messageId && !message.source?.parentAgentId
      && message.role === "assistant" && message.state === "complete");
    const result = message?.text ?? run.result?.text ?? run.result?.error?.message ?? (childFinished(child) ? child.result : undefined);
    return { ...progress, status: run.state === "succeeded" ? "completed" : run.state === "failed" ? "failed" : "cancelled",
      ...(result ? { result } : {}) };
  }
  if (childFinished(child)) return child;
  const status = run.state === "unknown" || run.phase === "interrupted" ? "unknown"
    : run.state === "waiting_for_input" ? (run.pending.some(request => request.kind === "approval") ? "awaiting_approval" : "awaiting_question")
    : "running";
  return { ...progress, status };
}

export function completedChildren(family: SessionFamily, wait: Pick<ChildWait, "childSessionIds" | "mode">): SessionSubagent[] | undefined {
  const answers = wait.childSessionIds.flatMap(id => {
    const child = family.launches.find(launch => launch.child.id === id)?.child;
    return child && childFinished(child) ? [structuredClone(child)] : [];
  });
  return answers.length && (wait.mode === "any" || answers.length === wait.childSessionIds.length) ? answers : undefined;
}
