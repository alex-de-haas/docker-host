"use client";

import { useState } from "react";
import { CircleCheck, CircleSlash, LoaderCircle, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { CoreBootstrapApp, CoreBootstrapState } from "../types";
import { InlineError } from "../ui";

// The platform panel opened from the sidebar version block. Today it carries the Extensions
// section (which distribution-list apps Core preinstalls, docs/ideas/generic-bootstrap.md
// Phase 3); the core-dev-target runtime controls (release/dev switch, update, restart) join it
// later. Admin-only: the sidebar only makes the version block clickable for host admins.
export function PlatformDialog({
  open,
  coreVersion,
  shellVersion,
  state,
  loading,
  error,
  onToggle,
  onClose,
}: {
  open: boolean;
  coreVersion: string | null;
  shellVersion: string;
  state: CoreBootstrapState | null;
  loading: boolean;
  error: string | null;
  onToggle: (appId: string, enabled: boolean) => Promise<void>;
  onClose: () => void;
}) {
  // Two-step toggle: the first click arms a per-row confirmation (with the strongest wording for
  // disabling the Shell from inside the Shell), the second click applies it.
  const [pending, setPending] = useState<{ appId: string; enabled: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const close = () => {
    setPending(null);
    setToggleError(null);
    onClose();
  };

  const applyPending = async () => {
    if (!pending) {
      return;
    }

    setBusy(pending.appId);
    setToggleError(null);
    try {
      await onToggle(pending.appId, pending.enabled);
      setPending(null);
    } catch (error) {
      setToggleError(error instanceof Error ? error.message : "The change could not be applied.");
    } finally {
      setBusy(null);
    }
  };

  const versionLine = [coreVersion ? `Core/CLI v${coreVersion}` : "Core/CLI version unknown", `Shell v${shellVersion}`].join(" · ");

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Platform</DialogTitle>
          <DialogDescription>{versionLine}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div>
            <h3 className="text-sm font-medium">Extensions</h3>
            <p className="text-xs text-muted-foreground">
              First-party apps this release can preinstall. Changes take effect immediately when enabling; disabling stops future
              installs but keeps the app until you uninstall it.
            </p>
          </div>

          {error && <InlineError message={error} />}
          {toggleError && <InlineError message={toggleError} />}
          {state?.actionError && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              The choice was saved, but the immediate install did not complete: {state.actionError} Core retries it on the next
              start.
            </p>
          )}
          {(state?.problems.length ?? 0) > 0 && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              Distribution list problems: {state?.problems.join(" ")}
            </p>
          )}

          {loading && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" aria-hidden /> Loading the distribution list…
            </p>
          )}

          {!loading && state && (
            <ul className="space-y-2">
              {state.apps.map((app) => (
                <ExtensionRow
                  key={app.id}
                  app={app}
                  busy={busy === app.id}
                  pending={pending?.appId === app.id ? pending.enabled : null}
                  onRequestToggle={(enabled) => {
                    setToggleError(null);
                    setPending({ appId: app.id, enabled });
                  }}
                  onCancel={() => setPending(null)}
                  onConfirm={applyPending}
                />
              ))}
            </ul>
          )}

          {!loading && state && (
            <p className="text-xs text-muted-foreground">Distribution list: {state.source}</p>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function ExtensionRow({
  app,
  busy,
  pending,
  onRequestToggle,
  onCancel,
  onConfirm,
}: {
  app: CoreBootstrapApp;
  busy: boolean;
  pending: boolean | null;
  onRequestToggle: (enabled: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isShellSelf = app.id === "hosty.shell";
  const statusBadge = app.installed ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">
      <CircleCheck className="size-3" aria-hidden />
      {app.runtimeState === "running" ? "Running" : "Installed"}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
      <CircleSlash className="size-3" aria-hidden />
      Not installed
    </span>
  );

  return (
    <li className="rounded-lg border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {app.title}
            {statusBadge}
          </p>
          {app.description && <p className="text-xs text-muted-foreground">{app.description}</p>}
          <p className="text-[11px] text-muted-foreground">
            {app.id} · {app.enabled ? "enabled" : "disabled"}
            {app.choice === null && ` (release default${app.defaultEnabled ? ": enabled" : ": disabled"})`}
          </p>
        </div>
        {pending === null && (
          <Button
            size="sm"
            variant={app.enabled ? "outline" : "default"}
            disabled={busy}
            onClick={() => onRequestToggle(!app.enabled)}
          >
            {app.enabled ? "Disable" : "Enable"}
          </Button>
        )}
      </div>

      {pending !== null && (
        <div className="mt-3 space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
          <p className="flex items-start gap-2 text-amber-700 dark:text-amber-400">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              {pending ? (
                <>Enable {app.title}? Core installs and starts it now.</>
              ) : isShellSelf ? (
                <>
                  Disable the Hosty Shell — the app you are using right now? It stays installed and running for now, but Core will
                  no longer reinstall it, and if it is ever uninstalled this web UI is gone. Recover from a terminal with{" "}
                  <code className="rounded bg-muted px-1">hosty setup --with hosty.shell</code>.
                </>
              ) : (
                <>
                  Disable {app.title}? Core stops reinstalling it at boot. {app.installed && "The installed app keeps running until you uninstall it from Apps."}
                </>
              )}
            </span>
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant={pending ? "default" : "destructive"} disabled={busy} onClick={onConfirm}>
              {busy && <LoaderCircle className="size-3.5 animate-spin" aria-hidden />}
              {pending ? "Enable" : "Disable"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
