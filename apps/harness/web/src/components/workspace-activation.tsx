"use client";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { developmentRequest } from "@/lib/development-api";
import { WorkspaceActivationPanel } from "../../../../../shared/web/workspace-activation";
export function WorkspaceActivation({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const request = useCallback((kind: string, body: Record<string, unknown>, signal?: AbortSignal) => developmentRequest(`/${workspaceId}/activation/${kind}`, body, signal), [workspaceId]);
  return <><Button variant="outline" size="sm" onClick={() => setOpen(true)}>Use workspace on this Core</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl"><DialogTitle>Workspace runtimes</DialogTitle><DialogDescription>Review activation, recovery and Return on the current host.</DialogDescription>
      {open && <WorkspaceActivationPanel workspaceId={workspaceId} request={request} storageKey={`hosty.activation:${location.origin}:${workspaceId}`} />}
    </DialogContent></Dialog></>;
}
