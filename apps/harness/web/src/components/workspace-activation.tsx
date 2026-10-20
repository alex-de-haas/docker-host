"use client";

import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openInstallationConfirmation, showInstallationConfirmation } from "@hosty-sdk/app/install";
import { approveWorkspaceAccess, type WorkspaceAccessReview } from "@/lib/workspace-access-review";
import { developmentRequest, DevelopmentRequestError } from "@/lib/development-api";

type Selection = { requestId: string; kind: "workspace" | "package" };
type Result = { requestId: string; state: string; error?: string; apps: { appId: string; state: string; error?: string; code?: string; review?: WorkspaceAccessReview }[] };
const terminalCode = (code?: string) => ["dev_selection_changed", "dev_installation_changed", "execution_request_conflict"].includes(code || "");
const terminalStale = (result: Result) => result.apps?.some(app => terminalCode(app.code));
function savedSelection(key: string): Selection | null {
  try { const value = JSON.parse(localStorage.getItem(key) ?? "null");
    return value && typeof value.requestId === "string" && ["workspace", "package"].includes(value.kind) ? value : null;
  } catch { return null; }
}

export function WorkspaceActivation({ workspaceId, apps, disabled, canUse = true, refresh }: {
  workspaceId: string; apps: { appId: string; name: string }[]; disabled?: boolean; canUse?: boolean; refresh: () => void;
}) {
  const storageKey = `hosty.workspace.execution:${location.origin}:${workspaceId}`;
  const [pending, setPending] = useState<Selection | null>(() => savedSelection(storageKey));
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [approvalLink, setApprovalLink] = useState<string | null>(null);
  const [error, setError] = useState("");
  const executing = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const record = (value: Selection | null) => {
    setPending(value);
    try { if (value) localStorage.setItem(storageKey, JSON.stringify(value)); else localStorage.removeItem(storageKey); }
    catch { /* Core retains the original request. */ }
  };
  const run = async (kind: Selection["kind"]) => {
    if (executing.current || disabled) return;
    executing.current = true; setBusy(true); setError("");
    const selection = pending?.kind === kind ? pending : { kind, requestId: crypto.randomUUID() };
    record(selection);
    try {
      let next = await developmentRequest<Result>(`/${workspaceId}/execution-target`, selection);
      setResult(next);
      while (next.state === "running" && alive.current) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        if (!alive.current) return;
        next = await developmentRequest<Result>(`/${workspaceId}/execution-target/${selection.requestId}`);
        if (alive.current) setResult(next);
      }
      if (!alive.current) return;
      if (next.state === "completed" || terminalStale(next)) record(null);
      refresh();
    } catch (e) { if (alive.current) {
      setError(e instanceof Error ? e.message : String(e));
      if (e instanceof DevelopmentRequestError && terminalCode(e.code)) record(null);
    } }
    finally { executing.current = false; if (alive.current) setBusy(false); }
  };
  const reviewAccess = async (review: WorkspaceAccessReview) => {
    if (reviewing || busy) return;
    const popup = openInstallationConfirmation();
    setReviewing(true); setError("");
    try {
      const approval = await approveWorkspaceAccess(review, request => {
        showInstallationConfirmation(popup, request);
        setApprovalLink(request.status === "pending" ? request.approvalUrl : null);
      });
      setApprovalLink(null);
      if (approval.status === "succeeded" && pending) await run(pending.kind);
      else if (approval.status === "denied") setError("The additional access was not approved.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setReviewing(false); }
  };
  useEffect(() => {
    const saved = savedSelection(storageKey);
    if (!saved) return;
    const abort = new AbortController();
    void developmentRequest<Result>(`/${workspaceId}/execution-target/${saved.requestId}`, undefined, abort.signal)
      .then(value => {
        if (abort.signal.aborted) return;
        setResult(value);
        if (value.state === "completed" || terminalStale(value)) {
          setPending(null);
          try { localStorage.removeItem(storageKey); } catch { /* Optional local journal. */ }
        }
      }).catch(() => { /* Retry preserves the exact request if its receipt is temporarily unavailable. */ });
    return () => abort.abort();
  }, [storageKey, workspaceId]);
  if (!apps.length) return null;
  const unsettled = !!pending && !["failed", "review-required"].includes(result?.state || "");
  const problems = result?.apps?.filter(app => !["completed", "skipped"].includes(app.state)) ?? [];
  return <section aria-label="Workspace applications" className="space-y-2 rounded border p-3">
    <p className="text-sm font-medium">Applications on this Core</p>
    <p className="text-xs text-muted-foreground">{apps.map(app => app.name).join(" · ")}</p>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" disabled={disabled || busy || reviewing || unsettled || !canUse} onClick={() => void run("workspace")}>Use this workspace</Button>
      <Button variant="outline" size="sm" disabled={disabled || busy || reviewing || unsettled} onClick={() => void run("package")}>Return to package</Button>
      {pending && <Button variant="outline" size="sm" disabled={disabled || busy || reviewing} onClick={() => void run(pending.kind)}>Retry runtime switch</Button>}
    </div>
    {busy && <p role="status" className="flex items-center gap-2 text-xs"><LoaderCircle className="size-3 animate-spin" />Switching applications…</p>}
    {result?.state === "completed" && <p role="status" className="text-xs text-muted-foreground">Applications switched.</p>}
    {approvalLink && <a className="block text-xs underline" href={approvalLink} target="_blank" rel="noreferrer">Open Core access confirmation</a>}
    {(error || result?.error) && <p role="alert" className="text-xs text-destructive">{error || result?.error}</p>}
    {problems.length > 0 && <ul className="space-y-1 text-xs">{problems.map(app => <li key={app.appId}>
      {apps.find(item => item.appId === app.appId)?.name || app.appId}: {app.error || (app.state === "review-required" ? "Additional access requires approval in Core." : app.state)}
      {app.state === "review-required" && app.review && <Button size="sm" variant="link" disabled={reviewing || busy} onClick={() => void reviewAccess(app.review!)}>Review access</Button>}
    </li>)}</ul>}
  </section>;
}
