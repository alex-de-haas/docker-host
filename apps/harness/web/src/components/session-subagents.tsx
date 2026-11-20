"use client";

import type { ReactNode } from "react";
import { MessageSquare } from "lucide-react";
import type { SessionSubagent } from "../../../src/subagents/types";
import { Button } from "@/components/ui/button";
import { SubagentExchange, SubagentGroup, SubagentRow, type SubagentStatus } from "./subagent-disclosure";

const statuses = {
  starting: { label: "Starting" },
  running: { label: "Running" },
  awaiting_approval: { label: "Waiting for input", detail: "Approval" },
  awaiting_question: { label: "Waiting for input", detail: "Question" },
  completed: { label: "Completed" },
  failed: { label: "Failed", failed: true },
  cancelled: { label: "Cancelled" },
  unknown: { label: "Unknown" },
} satisfies Record<SessionSubagent["status"], SubagentStatus>;

function observedStatus(child: SessionSubagent, connected: boolean): SubagentStatus {
  const status = statuses[child.status] ?? statuses.unknown;
  if (!connected && ["starting", "running", "awaiting_approval", "awaiting_question"].includes(child.status)) {
    return { label: "Unknown", detail: `Last known: ${status.label.toLowerCase()}` };
  }
  return child.detail ? { ...status, detail: child.detail } : status;
}

export function ChatLink({ id, onOpen, children }: { id: string; onOpen: (id: string) => void; children: ReactNode }) {
  return <Button asChild variant="link" size="sm" className="h-auto w-fit px-0 text-xs">
    <a href={`?session=${encodeURIComponent(id)}`} onClick={event => {
      if (event.button || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      event.preventDefault();
      onOpen(id);
    }}>{children}</a>
  </Button>;
}

export function SessionSubagents({ agents, connected, onOpen }: { agents: SessionSubagent[]; connected: boolean; onOpen: (id: string) => void }) {
  const rows = agents.map(child => ({ child, status: observedStatus(child, connected) }));
  return <SubagentGroup label="Harness subagents" statuses={rows.map(row => row.status)}>
    {rows.map(({ child, status }) => <SubagentRow key={child.id} label={child.profileName} status={status}>
      <div className="flex min-w-0 flex-col gap-3">
        <SubagentExchange prompt={child.prompt} result={child.result} />
        {child.chatAvailable !== false && <ChatLink id={child.id} onOpen={onOpen}><MessageSquare aria-hidden />Open chat</ChatLink>}
      </div>
    </SubagentRow>)}
  </SubagentGroup>;
}
