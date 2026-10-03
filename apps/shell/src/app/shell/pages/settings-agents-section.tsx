"use client";

import { fetchCore } from "../core-transport.js";


import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { isAuthRequiredRedirectError, redirectToCoreLoginIfAuthRequired } from "../core-api";

type Skill = { key: string; digest: string | null; approvedDigest: string | null; markdown: string | null };
type Target = { id: string; displayName: string; offered: boolean; runtimeState: string;
  interfaces: { key: string; readiness: string }[]; skills: Skill[]; assistantIds?: string[] };
type Directory = { revision: string; targets: Target[]; assistants?: { id: string; displayName: string }[] };

export function SettingsAgentsSection({ coreOrigin, sendCsrfJson }: {
  coreOrigin: string;
  sendCsrfJson: (url: string, body: unknown, method?: string) => Promise<Response>;
}) {
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const url = coreOrigin + "/api/core/agents";
  const load = useCallback(async () => {
    const response = await fetchCore(url, { credentials: "include" });
    redirectToCoreLoginIfAuthRequired(response, coreOrigin);
    if (!response.ok) throw new Error("Could not load the agent directory.");
    setDirectory(await response.json() as Directory);
  }, [url, coreOrigin]);
  const showLoadError = (reason: unknown) => {
    if (!isAuthRequiredRedirectError(reason)) setError(String(reason));
  };
  useEffect(() => { void load().catch(showLoadError); }, [load]);
  const change = async (target: Target, offered: boolean, skill?: Skill, assistantIds?: string[]) => {
    if (!directory) return;
    setBusy(true); setError(null);
    try {
      const response = await sendCsrfJson(url + "/" + encodeURIComponent(target.id), {
        revision: directory.revision, offered,
        ...(assistantIds ? { assistantIds } : {}),
        ...(skill?.digest ? { approveSkills: { [skill.key]: skill.digest } } : {}),
      }, "PUT");
      if (!response.ok) throw new Error("The directory changed or the update was refused. Review the current state and retry.");
      setDirectory(await response.json() as Directory);
    } catch (reason) {
      if (isAuthRequiredRedirectError(reason)) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      await load().catch(() => undefined);
    } finally { setBusy(false); }
  };
  return <section className="max-w-4xl space-y-5">
    <div className="flex items-start justify-between gap-4">
      <div><h2 className="text-lg font-medium">Agents</h2>
        <p className="text-sm text-muted-foreground">Choose available MCP applications and grant access to individual assistants. Tool approval rules stay with each assistant.</p></div>
      <Button variant="outline" disabled={busy} onClick={() => void load().catch(showLoadError)}>Refresh</Button>
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
      <fieldset className="space-y-2" disabled={busy}>
        <legend className="text-sm font-medium">Allowed assistants</legend>
        <p className="text-sm text-muted-foreground">Access uses the current user’s permissions and covers MCP only. The offer switch above must also be enabled.</p>
        {!directory.assistants?.length && <p className="text-sm text-muted-foreground">No confirmed assistant is installed.</p>}
        {directory.assistants?.map(assistant => <label key={assistant.id} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={target.assistantIds?.includes(assistant.id) ?? false}
            aria-label={`Allow ${assistant.displayName} to use ${target.displayName} MCP`}
            onChange={event => void change(target, target.offered, undefined, event.target.checked
              ? [...(target.assistantIds ?? []), assistant.id]
              : (target.assistantIds ?? []).filter(id => id !== assistant.id))} />{assistant.displayName}
        </label>)}
      </fieldset>
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
