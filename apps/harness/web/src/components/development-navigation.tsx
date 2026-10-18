"use client";
import { useState } from "react";
import { Folder, Loader2, MessageSquarePlus } from "lucide-react";
import type { AssistantSession } from "@/lib/assistant-api";
import type { DevelopmentWorkspace } from "@/lib/development-api";
import { orderSessions, isWaiting } from "@/lib/attention";
import { Button } from "@/components/ui/button";
import { ContinueBuilding } from "@/components/continue-building";

export function DevelopmentNavigation({ sessions, activeId, workspaces, onPick, onNew }: {
  sessions: AssistantSession[]; activeId?: string; workspaces: DevelopmentWorkspace[];
  onPick: (session: AssistantSession) => void; onNew: () => void;
}) {
  const [filter, setFilter] = useState("");
  const names = new Map<string, string>();
  const appNames = new Map(workspaces.flatMap(w => w.worktrees.flatMap(t => t.apps.map(app => [app.appId, app.name] as const))));
  for (const session of sessions) for (const id of session.appIds ?? [])
    names.set(id, session.contextApps?.find(app => app.id === id)?.displayName ?? appNames.get(id) ?? names.get(id) ?? id);
  const groups = [...names].sort((a,b) => a[1].localeCompare(b[1]));
  const renderGroup = (id: string, name: string, rows: AssistantSession[]) => <section key={id || "unassigned"} className="py-2">
    <h2 className="flex items-center gap-2 px-3 pb-1 text-xs font-medium text-muted-foreground"><Folder className="size-3.5" />{name}</h2>
    {orderSessions(rows).map(session => {
      const workspace = workspaces.find(w => w.owner.kind === "assistant" && w.owner.reference === session.id && w.owner.appId === "hosty.harness" && w.workflow.state !== "deleted");
      const prs = workspace?.worktrees.flatMap(t => t.pullRequests).length ?? 0;
      return <button key={session.id} type="button" aria-current={activeId === session.id ? "page" : undefined}
        onClick={() => onPick(session)} className={`mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring ${activeId === session.id ? "bg-muted" : ""}`}>
        <span className="min-w-0 flex-1"><span className="block truncate text-sm">{session.title || "Untitled session"}</span>
          <span className="block truncate text-xs text-muted-foreground">{isWaiting(session.status) ? "Waiting for you" : session.status}{workspace ? ` · Workspace${prs ? ` · ${prs} PR` : ""}` : ""}</span></span>
        {session.status === "running" && <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-label="Agent running" />}
        {isWaiting(session.status) && <span className="size-2 shrink-0 rounded-full bg-amber-500" aria-label="Waiting for you" />}
      </button>;
    })}
  </section>;
  return <nav aria-label="Sessions by application" className="flex h-full min-h-0 flex-col">
    <div className="space-y-2 border-b p-3"><Button className="w-full justify-start" variant="outline" onClick={onNew}><MessageSquarePlus />New session</Button>
      <ContinueBuilding sessions={sessions} onPick={onPick} />
      <select aria-label="Filter sessions by application" value={filter} onChange={e => setFilter(e.target.value)} className="w-full rounded-md border bg-background px-2 py-1.5 text-sm">
        <option value="">All applications</option>{groups.map(([id,name]) => <option key={id} value={id}>{name}</option>)}<option value="unassigned">Unassigned chats</option>
      </select></div>
    <div className="min-h-0 flex-1 overflow-y-auto py-2">
      {groups.filter(([id]) => !filter || filter === id).map(([id,name]) => renderGroup(id,name,sessions.filter(s => s.appIds?.includes(id))))}
      {(!filter || filter === "unassigned") && renderGroup("", "Unassigned chats", sessions.filter(s => !s.appIds?.length))}
      {!sessions.length && <p className="p-3 text-sm text-muted-foreground">Start a session to ask a question or work on an application.</p>}
    </div>
  </nav>;
}
