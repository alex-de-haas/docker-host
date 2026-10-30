"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { GitMerge, GitPullRequestArrow, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { prPath, prRequest, PrError, type PrActions, type PrAction, type PrCommand, type PrCommandResult, type PrSummary } from "@/lib/pull-requests-api";

export function PullRequestActions({ pr, onChanged }: { pr: PrSummary; onChanged: () => void }) {
  const [available, setAvailable] = useState<PrActions | null>(null), [error, setError] = useState("");
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ action: PrAction; head: string; base: string } | null>(null), [command, setCommand] = useState<PrCommand | null>(null);
  const [result, setResult] = useState<PrCommandResult | null>(null);
  const alive = useRef(true), sending = useRef(false), commandGeneration = useRef(0);
  const path = prPath(pr) + "/actions";
  const refresh = useCallback((signal?: AbortSignal) => {
    const generation = commandGeneration.current;
    return prRequest<PrActions>(path, undefined, signal)
    .then(value => { if (!signal?.aborted && alive.current) { setAvailable(value); setError(""); if (value.pendingCommand && !sending.current && generation === commandGeneration.current) { setCommand(value.pendingCommand); setResult(value.pendingResult ?? null); } } })
    .catch(e => { if (!signal?.aborted && alive.current) { setAvailable(null); setError(e instanceof Error ? e.message : "Actions unavailable."); } })
    .finally(() => { if (!signal?.aborted && alive.current) setLoading(false); });
  }, [path]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { const abort = new AbortController(); void refresh(abort.signal); return () => abort.abort(); }, [refresh, pr.head, pr.base, pr.state, pr.mergeState]);
  const matches = available?.head === pr.head && available?.base === pr.base;
  const currentResult = result?.requestId === command?.requestId ? result : null;
  const unresolved = command !== null && (!currentResult || currentResult.state === "pending" || currentResult.state === "unknown");
  async function send(action?: PrAction) {
    if (sending.current) return;
    const input = action ? { requestId: crypto.randomUUID(), action, head: pr.head, base: pr.base } : command;
    if (!input) return;
    if (action) { commandGeneration.current++; setResult(null); }
    sending.current = true; setBusy(true); setCommand(input); setConfirm(null); setError("");
    try {
      const value = await prRequest<PrCommandResult>(path + (action ? "" : "/recover"), input);
      if (value.requestId !== input.requestId) throw new Error("The action result could not be matched. Check this request again.");
      if (alive.current) { setResult(value); onChanged(); void refresh(); }
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : "Delivery could not be confirmed.");
        // Only definitive local validation failures clear the recovery control. Network/5xx must keep the UUID.
        if (e instanceof PrError && e.code && ["pr_changed", "pr_action_blocked", "pr_request_invalid", "pr_request_conflict", "pr_action_exists", "pr_action_capacity"].includes(e.code)) {
          setCommand(null); setResult(null); onChanged(); void refresh();
        }
      }
    } finally { sending.current = false; if (alive.current) setBusy(false); }
  }
  const blocked = busy || loading || !matches || unresolved || (command?.head === pr.head && (currentResult?.state === "merged" || currentResult?.state === "updated"));
  return <section className="space-y-2" aria-label="Pull request actions">
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={blocked || !available?.merge.enabled} title={available?.merge.reason} onClick={() => setConfirm({ action: "merge", head: pr.head, base: pr.base })}><GitMerge className="size-3.5" />Merge</Button>
      <Button size="sm" variant="outline" disabled={blocked || !available?.updateBranch.enabled} title={available?.updateBranch.reason} onClick={() => setConfirm({ action: "update-branch", head: pr.head, base: pr.base })}><GitPullRequestArrow className="size-3.5" />Update branch</Button>
      <Button size="icon-sm" variant="ghost" disabled={busy || loading} aria-label="Refresh action status" onClick={() => { setConfirm(null); setLoading(true); void refresh(); }}><RefreshCw className="size-3.5" /></Button>
      <span className="text-xs text-muted-foreground">Auto-merge: {available ? available.autoMerge + (available.autoMerge === "enabled" && available.autoMergeMethod ? ` (${available.autoMergeMethod})` : "") : "unknown"}</span>
    </div>
    {available && !matches && <p className="text-xs text-muted-foreground">The PR changed. Refresh its details before confirming an action.</p>}
    {available?.merge.reason && <p className="text-xs text-muted-foreground">{available.merge.reason}</p>}
    {available?.updateBranch.reason && available.mergeState === "behind" && <p className="text-xs text-muted-foreground">{available.updateBranch.reason}</p>}
    {confirm && confirm.head === pr.head && confirm.base === pr.base && <div className="space-y-3 rounded-lg border bg-muted/40 p-3" role="group" aria-label="Confirm PR action">
      <p className="text-sm">{confirm.action === "merge" ? `Merge #${pr.number} into ${pr.baseBranch} with a merge commit?` : `Update #${pr.number} with ${pr.baseBranch}? This can start new CI checks.`}</p>
      <p className="font-mono text-xs text-muted-foreground">Head {pr.head.slice(0, 12)}</p>
      <div className="flex gap-2"><Button size="sm" disabled={blocked} onClick={() => void send(confirm.action)}>{confirm.action === "merge" ? "Confirm merge" : "Confirm update"}</Button><Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button></div>
    </div>}
    {currentResult && <p role="status" className="text-xs">{currentResult.message}</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {unresolved && <div className="space-y-1"><Button size="sm" variant="outline" disabled={busy} onClick={() => void send()}>{busy ? "Checking…" : "Check result"}</Button><p className="text-xs text-muted-foreground">Checking does not resend the action.</p></div>}
  </section>;
}
