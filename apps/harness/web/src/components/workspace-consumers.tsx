"use client";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { repositoryName, type Worktree } from "@/lib/development-api";
function safeLink(value?: string) { try { const u = new URL(value ?? ""); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password ? u.href : undefined; } catch { return undefined; } }
export function WorkspaceConsumers({ trees }: { trees: Worktree[] }) {
  const consumers = [...new Map(trees.flatMap(t => (t.consumers ?? []).map(c => [c.reference.split("/")[0], c] as const))).values()];
  return <>
    {consumers.length > 0 && <section aria-label="Applications using source" className="flex flex-col gap-3">
      <h3 className="text-sm text-muted-foreground">Applications using this workspace</h3>
      {consumers.map(c => <Alert key={c.reference}><AlertTitle>{c.name ?? c.reference.split("/")[0]}</AlertTitle><AlertDescription>
        <p>{c.kind === "local-service" ? "Runs from this workspace." : c.kind === "core-runtime" ? "Core uses this workspace. Open Use workspace on this Core to Return its retained activation." : c.kind === "dev-runtime" ? "Uses these sources in dev mode with ordinary application data." : "Selects this workspace as its source."} Stop the runtime and return or change its source before removing this workspace.</p>
        {safeLink(c.managementUrl) && <Button asChild size="sm" variant="outline"><a href={safeLink(c.managementUrl)} target="_blank" rel="noreferrer">Manage application</a></Button>}
      </AlertDescription></Alert>)}
    </section>}
    {trees.some(t => t.leases.length > 0 || t.consumers?.length) && <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">Activity diagnostics</summary>
      <p>Activity protections do not expire and do not prove that an external agent is running. Use Close workspace to recover abandoned activity.</p>
      {trees.map(t => <div key={t.id} className="flex flex-col gap-1 py-2"><p>{repositoryName(t.repository)}</p>
        <p className="break-all">{t.path}</p>{t.leases.map(id => <p key={id} className="break-all font-mono">Lease: {id}</p>)}
        {t.consumers?.map(c => <p key={`${c.kind}:${c.reference}`}>{c.kind} · {c.reference}</p>)}
      </div>)}
    </details>}
  </>;
}
