"use client";

import { useState } from "react";
import { LoaderCircle, Shuffle, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { isAuthRequiredRedirectError } from "../core-api";
import { useShellActions, useShellState } from "../shell-context";
import type { CoreApp, CoreEndpoint, CoreReassignPlan, CoreReassignResult } from "../types";
import { FactCard, IconButton, InlineError } from "../ui";

// Read-only badge for an endpoint's install-time reservation state. Absent on older Core builds → nothing.
export function EndpointAvailabilityBadge({ availability }: { availability?: CoreEndpoint["availability"] }) {
  if (!availability) {
    return null;
  }

  if (availability === "running") {
    return <Badge variant="outline" title="The owning service is running">Running</Badge>;
  }

  if (availability === "unavailable") {
    return <Badge variant="destructive" title="The reserved port failed to bind — reassign or free it">Port unavailable</Badge>;
  }

  return <Badge variant="secondary" title="A host port is reserved but the app is stopped">Assigned · app stopped</Badge>;
}

// Impact-aware reassignment of one endpoint's automatic host port. Self-contained: it reads sendCsrfJson /
// refresh / coreOrigin from context, so it needs no prop threading. Opening the dialog loads the plan
// (POST …/ports/reassign/plan); confirming applies it (POST …/ports/reassign) and reports which apps must
// be restarted. Core rejects a non-automatic (manifest/operator/host-network) port, surfaced inline.
export function PortReassignControl({ app, endpoint }: { app: CoreApp; endpoint: CoreEndpoint }) {
  const { canManageApps } = useShellState();
  const { coreOrigin, sendCsrfJson, refresh } = useShellActions();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [plan, setPlan] = useState<CoreReassignPlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  const service = endpoint.service;
  const portKey = endpoint.port;
  // Only a host-admin can reassign, and only an endpoint with a resolved service/port key is a target.
  if (!canManageApps || !service || !portKey) {
    return null;
  }

  const base = `${coreOrigin}/api/apps/${encodeURIComponent(app.id)}/ports/reassign`;

  const openDialog = async () => {
    setOpen(true);
    setPlan(null);
    setError(null);
    setLoading(true);
    try {
      const response = await sendCsrfJson(`${base}/plan`, { service, portKey });
      setPlan((await response.json()) as CoreReassignPlan);
    } catch (err) {
      if (isAuthRequiredRedirectError(err)) {
        return;
      }

      setError(err instanceof Error ? err.message : "Could not load the reassignment plan.");
    } finally {
      setLoading(false);
    }
  };

  const apply = async () => {
    if (!plan) {
      return;
    }

    setApplying(true);
    setError(null);
    try {
      const response = await sendCsrfJson(base, { service, portKey, digest: plan.digest });
      const result = (await response.json()) as CoreReassignResult;
      setOpen(false);
      await refresh();
      toast.success(`Port reassigned to ${result.newPort}`, {
        description: result.restartRequiredAppIds.length > 0
          ? `Restart to apply: ${result.restartRequiredAppIds.join(", ")}.`
          : `${service}.${portKey} now uses ${result.newUrl ?? `port ${result.newPort}`}.`,
      });
    } catch (err) {
      if (isAuthRequiredRedirectError(err)) {
        return;
      }

      setError(err instanceof Error ? err.message : "Reassignment failed.");
    } finally {
      setApplying(false);
    }
  };

  return (
    <>
      <IconButton title="Reassign local port" onClick={() => void openDialog()}>
        <Shuffle className="h-4 w-4" />
      </IconButton>
      <Dialog open={open} onOpenChange={(next) => { if (!applying) setOpen(next); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reassign {service}.{portKey}</DialogTitle>
            <DialogDescription>Pick a new local host port for this endpoint, then restart the affected apps to bind it.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="h-4 w-4 animate-spin" /> Loading plan…
              </div>
            ) : plan ? (
              <div className="grid gap-3">
                <FactCard label="Current port" value={String(plan.currentPort)} />
                {plan.ownerRunning && (
                  <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                    <span>{app.displayName} is running on the current port; restart it after reassigning.</span>
                  </div>
                )}
                <div className="text-xs">
                  <div className="mb-1 font-medium">Dependent apps</div>
                  {plan.affectedDependents.length === 0 ? (
                    <div className="text-muted-foreground">None depend on this app.</div>
                  ) : (
                    <ul className="grid gap-1">
                      {plan.affectedDependents.map((dependent) => (
                        <li key={dependent.appId} className="flex items-center gap-2">
                          <span className="truncate font-mono">{dependent.appId}</span>
                          {dependent.running && <Badge variant="secondary">restart required</Badge>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {error && <InlineError message={error} />}
              </div>
            ) : (
              error && <InlineError message={error} />
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={applying}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void apply()} disabled={!plan || applying}>
              {applying && <LoaderCircle className="mr-1 h-4 w-4 animate-spin" />}
              Reassign port
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
