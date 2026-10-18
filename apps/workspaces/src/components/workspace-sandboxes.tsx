"use client";
import { useEffect, useState } from "react";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import type { SandboxInstance } from "@hosty-sdk/app/sandbox/server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
export function WorkspaceSandboxes({ workspaceId }: { workspaceId: string }) {
  const [instances, setInstances] = useState<SandboxInstance[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await appFetch("/api/sandboxes", { cache: "no-store", signal: controller.signal });
        const body = await response.json(); if (!response.ok) throw new Error(body.message ?? "Sandbox inspection unavailable.");
        if (!controller.signal.aborted) { setInstances(body.instances.filter((item: SandboxInstance) => item.context?.workspaceId === workspaceId)); setError(""); }
      } catch (cause) { if (!controller.signal.aborted) { setInstances([]); setError(cause instanceof Error ? cause.message : "Sandbox inspection unavailable."); } }
    };
    void load(); const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 10000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [workspaceId]);
  return <section className="space-y-2 rounded-lg border p-4" aria-label="Workspace sandboxes"><h3 className="font-medium">Individual app sandboxes</h3>
    {error ? <p role="status" className="text-xs text-muted-foreground">{error}</p> : !instances.length && <p className="text-xs text-muted-foreground">No sandbox instances attached to this workspace.</p>}
    {instances.map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-2"><p>{item.appId} <Badge variant="outline">{item.state}</Badge></p>
      {item.state === "ready" && item.previewUrl && <Button asChild variant="outline" size="sm"><a href={`${item.previewUrl}?hosty_sandbox_persona=core`} target="_blank" rel="noreferrer">Open preview</a></Button>}
      {item.errorCode && <p className="w-full text-xs text-destructive">{item.errorCode}</p>}</div>)}
    <p className="text-xs text-muted-foreground">Manage these instances in Harness or the Shell dashboard.</p>
  </section>;
}
