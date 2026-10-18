"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { workspaceAction } from "@/lib/assistant-api";
import type { Worktree } from "@/lib/development-api";

type RemoteStatus = { acceptedHead?: string; remote?: { repository: string; targetBranch: string; grant: { connectionId: string } };
  observation?: { at: string; state: string; head?: string; ahead?: number; behind?: number; related: boolean } };
type Connection = { id: string; label: string; accountName: string };
type Pending = { action: string; input: Record<string, unknown> };
type Receipt = { operation?: { id: string; state: string; error?: string }; operations?: { id: string; state: string; error?: string }[] };
const field = "w-full rounded border bg-background p-2 text-sm";
const labels: Record<string, string> = { "merge-upstream": "Integrate upstream", "abort-merge": "Abort upstream integration", "remote-connect": "Connect repository", "remote-fetch": "Fetch upstream", "remote-push-base": "Publish accepted base", commit: "Commit selected changes", "pr-configure": "Configure publication", "pr-push": "Push branch", "pr-publish": "Create / update PR" };

export function LocalRepositoryActions({ sessionId, appId, tree, disabled, refresh }: {
  sessionId: string; appId: string; tree: Worktree; disabled: boolean; refresh: () => void;
}) {
  const key = `hosty.local-remote.${sessionId}.${tree.id}.${appId}`;
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const executing = useRef(false);
  const [action, setAction] = useState<string | null>(null);
  const [repository, setRepository] = useState("");
  const [targetBranch, setTargetBranch] = useState("main");
  const [connectionId, setConnectionId] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [authorEmail, setAuthorEmail] = useState("");
  const [message, setMessage] = useState("");
  const [allowUnrelatedHistories, setAllowUnrelatedHistories] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [configured, setConfigured] = useState(false);
  const [pending, setPending] = useState<Pending | null>(() => {
    try { const value = JSON.parse(localStorage.getItem(key) ?? "null"); return value && labels[value.action] && typeof value.input?.requestId === "string" && value.input?.workspaceId === tree.id && value.input?.appId === appId ? value : null; } catch { return null; }
  });
  useEffect(() => {
    let cancelled = false;
    void workspaceAction<RemoteStatus>(sessionId, "remote-status", { appId, workspaceId: tree.id }).then(value => { if (!cancelled) setStatus(value); })
      .catch(e => { if (!cancelled) { setStatus(null); setError(e.message); } });
    void workspaceAction<{ publications: { workspaceId: string }[] }>(sessionId, "pr-list", {}).then(value => {
      if (!cancelled) setConfigured(value.publications.some(p => p.workspaceId === tree.id));
    }).catch(() => { if (!cancelled) setConfigured(false); });
    return () => { cancelled = true; };
  }, [sessionId, appId, tree.id, tree.observation?.at]);
  async function open(next: string) {
    setError(""); setAction(next);
    try {
      if (next === "remote-connect") {
        const result = await workspaceAction<{ connections: Connection[] }>(sessionId, "pr-connections", {});
        setConnections(result.connections); setConnectionId(current => current || result.connections[0]?.id || "");
      }
      if (next === "commit" || next === "merge-upstream") {
        const result = await workspaceAction<{ gitIdentity?: { name: string; email: string } }>(sessionId, "app-creation-capabilities", {});
        if (result.gitIdentity) { setAuthorName(result.gitIdentity.name); setAuthorEmail(result.gitIdentity.email); }
        setPaths([]);
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  async function run(retry?: Pending) {
    if (executing.current || disabled || (!retry && (!action || pending))) return;
    const selectedAction = retry?.action ?? action!;
    const input = retry?.input ?? { appId, workspaceId: tree.id, requestId: crypto.randomUUID(),
      ...(selectedAction === "remote-connect" ? { repository, targetBranch, connectionId } : {}),
      ...(selectedAction === "remote-push-base" ? { expectedTargetHead: status?.acceptedHead } : {}),
      ...(selectedAction === "merge-upstream" ? { expectedHead: tree.observation?.head, expectedRemoteHead: status?.observation?.head, message, authorName, authorEmail, allowUnrelatedHistories } : {}),
      ...(selectedAction === "abort-merge" ? { expectedHead: tree.observation?.head } : {}),
      ...(selectedAction === "commit" ? { expectedHead: tree.observation?.head, paths, message, authorName, authorEmail } : {}),
      ...(selectedAction === "pr-configure" ? { connectionId: status?.remote?.grant.connectionId, policy: { requiredChecks: [], requiredWorkflows: [], artifacts: [] } } : {}),
      ...(selectedAction === "pr-push" || selectedAction === "pr-publish" ? { expectedHead: tree.observation?.head } : {}),
      ...(selectedAction === "pr-publish" ? { title, body, draft: true } : {}),
    };
    const request = { action: selectedAction, input };
    executing.current = true; setBusy(true); setError("");
    try {
      localStorage.setItem(key, JSON.stringify(request)); setPending(request);
      const result = await workspaceAction<Receipt>(sessionId, selectedAction, input);
      const receipt = result.operation ?? result.operations?.find(o => o.id === input.requestId);
      if (receipt?.state !== "succeeded") throw new Error(receipt?.error ?? "Outcome is unconfirmed. Inspect the result and retry the original request.");
      localStorage.removeItem(key); setPending(null); setAction(null);
      if (selectedAction.startsWith("remote-")) setStatus(result as RemoteStatus);
      if (selectedAction === "pr-configure") setConfigured(true);
      refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { executing.current = false; setBusy(false); }
  }
  async function inspectPending() {
    if (!pending || executing.current) return;
    executing.current = true; setBusy(true);
    try {
      let result: Receipt;
      if (pending.action.startsWith("pr-")) {
        const list = await workspaceAction<{ publications: (Receipt & { workspaceId: string })[] }>(sessionId, "pr-list", {});
        result = list.publications.find(p => p.workspaceId === tree.id) ?? {};
      } else result = await workspaceAction<Receipt>(sessionId, pending.action.startsWith("remote-") ? "remote-status" : "status", { appId, workspaceId: tree.id });
      const receipt = result.operation?.id === pending.input.requestId ? result.operation : result.operations?.find(o => o.id === pending.input.requestId);
      if (receipt && ["succeeded", "failed", "conflict"].includes(receipt.state)) {
        localStorage.removeItem(key); setPending(null); setAction(null); setError(receipt.state === "succeeded" ? "" : receipt.error ?? "The operation did not succeed. Review current state before trying again."); refresh();
      } else setError("The outcome is still unconfirmed. Keep the original request and retry it; no source was removed.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { executing.current = false; setBusy(false); }
  }
  const locked = disabled || busy || !!pending;
  const files = tree.observation?.local?.files ?? [];
  const clean = tree.observation?.state === "ok" && files.length === 0 && !tree.observation?.local?.truncated;
  const observed = status?.observation;
  return <section className="flex flex-col gap-2 rounded border p-3 text-xs" aria-label={`Repository actions for ${appId}`}>
    <p className="font-medium">Repository · {appId}</p>
    {status && !status.remote && <p>Local only · no remote connected</p>}
    {status?.remote && <><p className="break-all">{status.remote.repository}<br />Target: {status.remote.targetBranch}</p>
      <p>{observed ? `${observed.state === "missing" ? "Remote target does not exist" : `${observed.ahead} ahead · ${observed.behind} behind${observed.related ? "" : " · unrelated history"}`} · observed ${new Date(observed.at).toLocaleString()}` : "Upstream not observed"}</p></>}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={locked || !files.length} onClick={() => void open("commit")}>Commit…</Button>
      {!status?.remote && <Button size="sm" variant="outline" disabled={locked || !status} onClick={() => void open("remote-connect")}>Connect repository…</Button>}
      {status?.remote && <>
        <Button size="sm" variant="outline" disabled={locked} onClick={() => void open("remote-fetch")}>Fetch upstream…</Button>
        {observed?.head && <Button size="sm" variant="outline" disabled={locked || !clean} onClick={() => void open("merge-upstream")}>Integrate upstream…</Button>}
        {tree.observation?.conflict && <Button size="sm" variant="outline" disabled={locked} onClick={() => void open("abort-merge")}>Abort integration…</Button>}
        {observed?.state === "missing" && <Button size="sm" variant="outline" disabled={locked} onClick={() => void open("remote-push-base")}>Publish accepted base…</Button>}
        {!configured ? <Button size="sm" variant="outline" disabled={locked} onClick={() => void open("pr-configure")}>Configure publication…</Button> : <>
          <Button size="sm" variant="outline" disabled={locked || !clean} onClick={() => void open("pr-push")}>Push branch…</Button>
          <Button size="sm" variant="outline" disabled={locked || !clean} onClick={() => void open("pr-publish")}>Pull request…</Button>
        </>}
      </>}
    </div>
    {pending && <div><p>Unconfirmed: {labels[pending.action]}. Retry retains the original arguments and request ID.</p>
      <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => void run(pending)}>Retry repository action</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void inspectPending()}>Check last action</Button></div>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <Dialog open={!!action} onOpenChange={open => { if (!open) setAction(null); }}><DialogContent className="max-h-[85vh] overflow-y-auto">
      <DialogTitle>{action ? labels[action] : "Repository"}</DialogTitle>
      <DialogDescription>{action === "remote-connect" ? "Connect an existing repository. This preserves local source and worktree identity and sends no source."
        : action === "merge-upstream" ? "Merge the reviewed upstream commit into this worktree. Local main stays unchanged. Conflicts remain visible for resolution or Abort integration."
          : action === "abort-merge" ? "Abort the current merge using Git and return to the pre-merge worktree."
          : action === "remote-fetch" ? "Refresh upstream evidence without pulling or changing local files."
          : action === "commit" ? "Review the selected paths in Changes before committing. This action creates a local commit only."
            : action === "remote-push-base" ? "Send the accepted local main to the selected missing remote branch. An existing different branch will not be overwritten."
              : action === "pr-configure" ? "Bind publication to the selected source connection. CI and reviews are reported by the provider; no additional release evidence is required."
                : action === "pr-push" ? "Send the exact clean workspace commit to its remote branch. No pull request is created."
                  : "Send the reviewed workspace commit and create or update its draft pull request."}</DialogDescription>
      <p className="break-all text-sm">{appId}<br />Workspace branch: {tree.branch}<br />Commit: {tree.observation?.head}
        {status?.remote && <><br />Remote: {status.remote.repository}<br />Target branch: {status.remote.targetBranch}</>}
        {action === "remote-push-base" && <><br />Accepted base to publish: {status?.acceptedHead}</>}</p>
      {action === "remote-connect" && <>
        <label>Repository URL<input className={field} value={repository} onChange={e => setRepository(e.target.value)} /></label>
        <label>Target branch<input className={field} value={targetBranch} onChange={e => setTargetBranch(e.target.value)} /></label>
        <label>Source connection<select className={field} value={connectionId} onChange={e => setConnectionId(e.target.value)}><option value="">Choose a connection</option>{connections.map(c => <option key={c.id} value={c.id}>{c.label} · {c.accountName}</option>)}</select></label>
      </>}
      {(action === "commit" || action === "merge-upstream") && <>
        {action === "commit" && <fieldset><legend>Selected changes</legend>{files.map(file => <label key={file.path} className="flex items-center gap-2 break-all"><input type="checkbox" checked={paths.includes(file.path)} onChange={e => setPaths(current => e.target.checked ? [...current, file.path] : current.filter(p => p !== file.path))} />{file.path}</label>)}</fieldset>}
        {action === "merge-upstream" && <><p className="break-all">Upstream commit: {observed?.head}</p>{!observed?.related && <label><input type="checkbox" checked={allowUnrelatedHistories} onChange={e => setAllowUnrelatedHistories(e.target.checked)} /> I reviewed both histories and allow merging unrelated histories.</label>}</>}
        <label>Commit message<textarea className={field} value={message} onChange={e => setMessage(e.target.value)} /></label>
        <label>Author name<input className={field} value={authorName} onChange={e => setAuthorName(e.target.value)} /></label>
        <label>Author email<input className={field} value={authorEmail} onChange={e => setAuthorEmail(e.target.value)} /></label>
      </>}
      {action === "pr-publish" && <><label>PR title<input className={field} value={title} onChange={e => setTitle(e.target.value)} /></label><label>PR description<textarea className={field} value={body} onChange={e => setBody(e.target.value)} /></label></>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" onClick={() => setAction(null)}>Cancel</Button><Button disabled={locked || (action === "remote-connect" && (!repository.trim() || !targetBranch.trim() || !connectionId)) || (action === "commit" && (!paths.length || !message.trim() || !authorName.trim() || !authorEmail.trim())) || (action === "merge-upstream" && (!message.trim() || !authorName.trim() || !authorEmail.trim() || (!observed?.related && !allowUnrelatedHistories))) || (action === "pr-publish" && !title.trim())} onClick={() => void run()}>{busy ? "Working…" : "Confirm " + (action ? labels[action].toLowerCase() : "action")}</Button></DialogFooter>
    </DialogContent></Dialog>
  </section>;
}
