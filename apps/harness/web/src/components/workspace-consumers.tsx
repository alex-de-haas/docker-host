"use client";
import { Shield } from "lucide-react";
import { type Worktree } from "@/lib/development-api";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export function WorkspaceActivity({ trees }: { trees: Worktree[] }) {
  if (!trees.some(tree => tree.leases.length > 0)) return null;
  return <TooltipProvider delayDuration={250}><Tooltip>
    <TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-sm" className="size-6 text-muted-foreground" aria-label="Workspace activity registered"><Shield className="size-3.5" aria-hidden="true" /></Button></TooltipTrigger>
    <TooltipContent className="max-w-xs">An agent or tool has registered work in this workspace. Other sessions can still use it. This does not confirm that the agent is still running. Use Pause workspace if that work was abandoned.</TooltipContent>
  </Tooltip></TooltipProvider>;
}

/** Services and selected source are separate Core records for the same application. */
export function WorkspaceConsumers({ trees }: { trees: Worktree[] }) {
  const applications = new Map<string, { name: string; running: boolean; selected: boolean }>();
  for (const tree of trees) for (const consumer of tree.consumers ?? []) {
    const id = consumer.kind === "local-service" ? consumer.reference.split("/")[0] : consumer.reference;
    const existing = applications.get(id);
    applications.set(id, {
      name: consumer.name || existing?.name || tree.apps.find(app => app.appId === id)?.name || "An application",
      running: !!existing?.running || ["local-service", "dev-runtime", "core-runtime"].includes(consumer.kind),
      selected: !!existing?.selected || consumer.kind === "source-selection",
    });
  }
  return <div className="space-y-2">
    <p>Switch applications to this workspace or return them to packages. Their ordinary data is kept.</p>
    {applications.size > 0 && <div className="space-y-1">
      <p className="font-medium">Source usage</p>
      <ul className="space-y-1">{[...applications].map(([id, app]) => <li key={id}>
        <span className="font-medium">{app.name}</span>: {app.running ? "Running from these source files." : app.selected ? "These source files are selected for this app." : "Uses these source files."}
      </li>)}</ul>
    </div>}
  </div>;
}
