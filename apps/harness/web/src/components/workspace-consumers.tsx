"use client";
import { repositoryName, type Worktree } from "@/lib/development-api";

export function WorkspaceConsumers({ trees }: { trees: Worktree[] }) {
  if (!trees.some(tree => tree.leases.length > 0 || tree.consumers?.length)) return null;
  return <details aria-label="Workspace activity diagnostics" className="rounded-lg border bg-muted/30 p-2 text-xs text-muted-foreground">
    <summary className="cursor-pointer">Activity diagnostics</summary>
    <p>Activity protections do not expire and do not prove that an external agent is running. Use Pause workspace to recover abandoned activity.</p>
    {trees.some(tree => tree.consumers?.length) && <p>Stop or return active runtimes and release source selections before removing this workspace.</p>}
    {trees.map(tree => <div key={tree.id} className="flex flex-col gap-1 py-2"><p>{repositoryName(tree.repository)}</p>
      <p className="break-all font-mono">{tree.path}</p>{tree.leases.map(id => <p key={id} className="break-all font-mono">Lease: {id}</p>)}
      {tree.consumers?.map(consumer => <p key={`${consumer.kind}:${consumer.reference}`} className="break-all font-mono">{consumer.name && `${consumer.name} · `}{consumer.kind} · {consumer.reference}</p>)}
    </div>)}
  </details>;
}
