"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { redirectToCoreLoginIfAuthRequired } from "../core-api";

type Skill = { key: string; digest: string | null; approvedDigest: string | null; markdown: string | null };
type Target = { id: string; displayName: string; offered: boolean; runtimeState: string;
  interfaces: { key: string; readiness: string }[]; skills: Skill[] };
type Directory = { revision: string; targets: Target[] };

export function SettingsAgentsSection({ coreOrigin, sendCsrfJson }: {
  coreOrigin: string;
  sendCsrfJson: (url: string, body: unknown, method?: string) => Promise<Response>;
}) {
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const url = coreOrigin + "/api/core/agents";
  const load = useCallback(async () => {
    const response = await fetch(url, { credentials: "include" });
    redirectToCoreLoginIfAuthRequired(response, coreOrigin);
    if (!response.ok) throw new Error("Could not load the agent directory.");
    setDirectory(await response.json() as Directory);
  }, [url, coreOrigin]);
  useEffect(() => { void load().catch(reason => setError(String(reason))); }, [load]);
  const change = async (target: Target, offered: boolean, skill?: Skill) => {
    if (!directory) return;
    setBusy(true); setError(null);
    try {
      const response = await sendCsrfJson(url + "/" + encodeURIComponent(target.id), {
        revision: directory.revision, offered,
        ...(skill?.digest ? { approveSkills: { [skill.key]: skill.digest } } : {}),
      }, "PUT");
      if (!response.ok) throw new Error("The directory changed or the update was refused. Review the current state and retry.");
      setDirectory(await response.json() as Directory);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      await load().catch(() => undefined);
    } finally { setBusy(false); }
  };
  return <section className="max-w-4xl space-y-5">
    <div className="flex items-start justify-between gap-4">
      <div><h2 className="text-lg font-medium">Agents</h2>
        <p className="text-sm text-muted-foreground">Choose which tools Hosty offers to agents. Approval rules stay with each assistant.</p></div>
      <Button variant="outline" disabled={busy} onClick={() => void load().catch(reason => setError(String(reason)))}>Refresh</Button>
    </div>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {!directory && !error && <p>Loading agent directory…</p>}
    {directory?.targets.map(target => <article key={target.id} className="space-y-4 rounded-lg border p-4">
      <div className="flex items-start justify-between gap-4">
        <div><h3 className="font-medium">{target.displayName}</h3>
          <p className="text-sm text-muted-foreground">{target.id} · {target.interfaces.map(item => item.key + ": " + item.readiness).join(", ")}</p></div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={target.offered} disabled={busy}
            aria-label={"Offer " + target.displayName + " to agents"}
            onChange={event => void change(target, event.target.checked)} />Offer to agents
        </label>
      </div>
      {target.skills.map(skill => <details key={skill.key} className="rounded border p-3">
        <summary className="cursor-pointer text-sm">Application instructions — {skill.digest === null ? "unavailable" : skill.digest === skill.approvedDigest ? "approved" : "review required"}</summary>
        <p className="my-3 text-sm text-muted-foreground">Only approved text is delivered. Changed instructions are withheld until you approve them; the tool offer is unchanged.</p>
        {skill.markdown && <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{skill.markdown}</pre>}
        {skill.digest && skill.digest !== skill.approvedDigest && <Button className="mt-3" disabled={busy}
          onClick={() => void change(target, target.offered, skill)}>Approve these instructions</Button>}
      </details>)}
    </article>)}
  </section>;
}
