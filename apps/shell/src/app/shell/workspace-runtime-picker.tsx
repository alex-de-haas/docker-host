"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useShellActions } from "./shell-context";
import { fetchCore } from "./core-transport";
import { readCoreError } from "./core-api";
import { WorkspaceActivationPanel } from "../../../../../shared/web/workspace-activation";
type Workspace = { id: string; owner: { userId: string }; worktrees: { apps: { appId: string }[]; repository: string; branch: string }[] };
export function WorkspaceRuntimePicker({ appId }: { appId: string }) {
  const { coreOrigin, sendCsrfJson } = useShellActions();
  const [open, setOpen] = useState(false); const [rows, setRows] = useState<Workspace[]>([]); const [selected, setSelected] = useState(""); const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return; const abort = new AbortController();
    void fetchCore(`${coreOrigin}/api/development/activation-workspaces`, { credentials: "include", signal: abort.signal }).then(async response => {
      if (!response.ok) throw new Error(await readCoreError(response));
      const value = await response.json() as { workspaces: Workspace[] };
      if (!abort.signal.aborted) { const available = value.workspaces.filter(w => w.worktrees.some(t => t.apps.some(a => a.appId === appId))); setRows(available); setSelected(old => available.some(w => w.id === old) ? old : available[0]?.id ?? ""); }
    }).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [open, coreOrigin, appId]);
  const request = useCallback(async (kind: string, body: Record<string, unknown>) => {
    const response = await sendCsrfJson(`${coreOrigin}/api/development/workspaces/${selected}/activation/${kind}`, body);
    if (!response.ok) {
      const problem = await response.json().catch(() => ({})) as { code?: string; message?: string };
      throw Object.assign(new Error(problem.message ?? `Core request failed (${response.status})`), { code: problem.code });
    }
    return response.json();
  }, [coreOrigin, selected, sendCsrfJson]);
  return <><Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Workspace…</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>Workspace runtime</DialogTitle><DialogDescription>Select a registered workspace explicitly bound to this application.</DialogDescription></DialogHeader>
      {error && <p role="alert">{error}</p>}{rows.length === 0 && <p>No eligible workspace is registered for this app.</p>}
      {rows.length > 0 && <label>Workspace <select className="w-full border bg-background p-2" value={selected} onChange={e => setSelected(e.target.value)}>{rows.map(w => <option key={w.id} value={w.id}>{w.worktrees.map(t => t.branch).join(", ")}</option>)}</select></label>}
      {open && selected && <WorkspaceActivationPanel key={selected} workspaceId={selected} onlyApp={appId} request={request} storageKey={`hosty.activation:${coreOrigin}:${selected}`} />}
    </DialogContent></Dialog></>;
}
