"use client";

import { useState } from "react";
import { LoaderCircle, Shuffle, TriangleAlert, Unplug } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { isAuthRequiredRedirectError } from "../core-api";
import { useShellActions, useShellState } from "../shell-context";
import type { CoreApp, CoreEndpoint, CoreReassignPlan, CoreReassignResult } from "../types";
import { BusyButton, FactCard, IconButton, InlineError } from "../ui";

// Highest TCP port; the floor is per-plan (Core reports it) since it depends on what Core may bind.
const MaxPort = 65535;

// Read-only marker for an endpoint's install-time port reservation. Only the failure case earns a
// marker: "running" duplicates the service status badge above it, and "assigned" duplicates the
// endpoint URL block below (Core reserves the port at install time, so even a stopped app has one).
// An "unavailable" reservation — the reserved port failed preflight/binding — is a real problem, shown
// here as a red icon and mirrored onto the collapsed app row so it is visible without expanding.
export function EndpointAvailabilityMarker({ availability }: { availability?: CoreEndpoint["availability"] }) {
  if (availability !== "unavailable") {
    return null;
  }

  return (
    <span title="The reserved port failed to bind — reassign or free it" className="inline-flex shrink-0">
      <Unplug className="h-4 w-4 text-destructive" aria-label="Reserved port unavailable" />
    </span>
  );
}

// Impact-aware assignment of one endpoint's host port. Self-contained: it reads sendCsrfJson / refresh /
// coreOrigin from context, so it needs no prop threading. Opening the dialog loads the plan
// (POST …/ports/reassign/plan); confirming applies it (POST …/ports/reassign) and reports which apps must
// be restarted. Two modes: automatic (Core allocates, and may move it later) or manual (the operator pins
// an exact port, which Core then never moves on its own). Core rejects a manifest/host-network port and
// every invalid manual port with a message shown inline.
export function PortReassignControl({ app, endpoint }: { app: CoreApp; endpoint: CoreEndpoint }) {
  const { canManageApps } = useShellState();
  const { coreOrigin, sendCsrfJson, refresh } = useShellActions();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [plan, setPlan] = useState<CoreReassignPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [port, setPort] = useState("");

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
      const loaded = (await response.json()) as CoreReassignPlan;
      setPlan(loaded);
      // Open in the mode the endpoint is already in, prefilled with its current port, so re-pinning or
      // nudging an existing pin does not start from a blank field.
      setManual(loaded.pinned);
      setPort(String(loaded.currentPort));
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

    // Check the obvious locally so a typo answers instantly; Core still re-validates against the live
    // reservation view, which is the only place conflicts can be judged.
    const desired = Number(port.trim());
    if (manual && (!Number.isInteger(desired) || desired < plan.minManualPort || desired > MaxPort)) {
      setError(`Enter a port between ${plan.minManualPort} and ${MaxPort}.`);
      return;
    }

    setApplying(true);
    setError(null);
    try {
      const response = await sendCsrfJson(base, {
        service,
        portKey,
        digest: plan.digest,
        mode: manual ? "manual" : "automatic",
        ...(manual ? { port: desired } : {}),
      });
      const result = (await response.json()) as CoreReassignResult;
      setOpen(false);
      await refresh();
      toast.success(manual ? `Port pinned to ${result.newPort}` : `Port reassigned to ${result.newPort}`, {
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
            <DialogTitle>Local port — {service}.{portKey}</DialogTitle>
            <DialogDescription>Let Core assign a free port, or pin an exact one. Restart the affected apps afterwards to bind it.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="h-4 w-4 animate-spin" /> Loading plan…
              </div>
            ) : plan ? (
              <div className="grid gap-3">
                <FactCard label="Current port" value={plan.pinned ? `${plan.currentPort} (pinned)` : String(plan.currentPort)} />
                <div className="grid gap-2">
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant={manual ? "outline" : "default"}
                      disabled={applying}
                      onClick={() => { setManual(false); setError(null); }}
                    >
                      Automatic
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={manual ? "default" : "outline"}
                      disabled={applying}
                      onClick={() => { setManual(true); setError(null); }}
                    >
                      Manual
                    </Button>
                  </div>
                  {manual && (
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={plan.minManualPort}
                      max={MaxPort}
                      value={port}
                      disabled={applying}
                      onChange={(event) => setPort(event.target.value)}
                      className="h-8 w-40 text-sm"
                      aria-label="Host port"
                    />
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    {manual
                      ? `Core keeps this exact port and will not move it. ${plan.minManualPort}–${MaxPort}.`
                      : "Core picks a free port, and may move it later to resolve a conflict."}
                  </p>
                </div>
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
            <BusyButton type="button" onClick={() => void apply()} busy={applying} disabled={!plan}>
              {manual ? "Pin port" : "Reassign port"}
            </BusyButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
