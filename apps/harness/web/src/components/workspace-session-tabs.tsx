"use client";
import { useRef } from "react";
import { Loader2, Plus } from "lucide-react";
import { Button } from "./ui/button";
import { WorkspaceActivityCounts } from "./workspace-activity-counts";
import { countStatus, emptyCounts, workspaceSessionIds } from "@/lib/workspace-navigation";
import { workflowIsActive, type DevelopmentWorkspace } from "@/lib/development-api";
import type { AssistantSession } from "@/lib/assistant-api";
import type { WorkspaceSessionActions } from "@/lib/use-workspace-session-actions";
export function WorkspaceSessionTabs({ workspace, sessions, activeId, onPick, actions }: {
  workspace: DevelopmentWorkspace; sessions: AssistantSession[]; activeId?: string;
  onPick: (session: AssistantSession) => void; actions: WorkspaceSessionActions;
}) {
  const tabList = useRef<HTMLDivElement>(null);
  if (workspace.owner.kind === "external") return null;
  const chats = workspaceSessionIds(workspace).flatMap(id => sessions.find(s => s.id === id) ?? []);
  return <div className="shrink-0 border-b">
    <div className="flex min-w-0 items-center gap-1 px-2 pt-2">
      <div ref={tabList} role="tablist" aria-label="Workspace sessions" className="flex min-w-0 items-center gap-1 overflow-x-auto pb-2" onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        const tabs = [...tabList.current!.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
        const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
        if (index < 0 || !tabs.length) return;
        event.preventDefault();
        const target = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        tabs[target].focus(); tabs[target].click();
      }}>
        {chats.map((chat, index) => { const counts = emptyCounts(); countStatus(counts, chat.status); return <Button key={chat.id}
          id={`workspace-tab-${chat.id}`} role="tab" aria-selected={chat.id === activeId} aria-controls="workspace-chat" tabIndex={chat.id === activeId || !activeId && index === 0 ? 0 : -1}
          size="sm" variant={chat.id === activeId ? "secondary" : "ghost"} className="max-w-56 shrink-0 gap-2" onClick={() => onPick(chat)} title={chat.title || "Untitled session"}>
          <span className="truncate">{chat.title || "Untitled session"}</span><WorkspaceActivityCounts counts={counts} />
        </Button>; })}
      </div>
      {workspace.participation && <Button size="icon-sm" variant="ghost" className="mb-2 shrink-0" aria-label="New session in workspace" title="New session in workspace"
        disabled={actions.busy || actions.retry || !workflowIsActive(workspace.workflow)} onClick={() => void actions.command("new")}>
        {actions.busy ? <Loader2 className="motion-safe:animate-spin" /> : <Plus />}
      </Button>}
    </div>
    {actions.error && <p role="alert" className="px-3 pb-2 text-xs text-destructive-foreground">{actions.error}</p>}
    {actions.retry && !actions.busy && actions.pending && <Button size="sm" variant="outline" className="m-2" onClick={() => void actions.run(actions.pending!)}>Retry same request</Button>}
  </div>;
}
