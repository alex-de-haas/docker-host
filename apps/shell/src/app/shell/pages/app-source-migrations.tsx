"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { fetchCore } from "../core-transport";
import { CoreRequestError, readCoreError, readCoreErrorDetail } from "../core-api";
import type { CoreApp } from "../types";

type Binding = { manifestUrl: string | null; feedsUrl: string | null; feedId: string | null };
type Suggestion = { migration: { migrationId: string; appId: string; from: Binding; to: Binding }; revision: string };
type Plan = { appId: string; from: Binding; to: Binding; targetVersion: string; ordering: string; impact: string; planDigest: string };
type Batch = { requestId: string; items: { appId: string; planDigest: string }[] };
type Result = { appId: string; operation?: { status: string; previous: Binding } | null; error?: string | null };

export function AppSourceMigrations({ coreOrigin, apps, sendCsrfJson, onChanged }: {
  coreOrigin: string; apps: CoreApp[]; sendCsrfJson: (url: string, body: unknown, method?: string) => Promise<Response>;
  onChanged: () => Promise<void>;
}) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState<Batch | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const storageKey = `hosty-source-migration:${coreOrigin}`;
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetchCore(`${coreOrigin}/api/apps/update-source/suggestions`, { credentials: "include", cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(await readCoreError(response));
        const value = await response.json() as { suggestions: Suggestion[] };
        if (!controller.signal.aborted) setSuggestions(value.suggestions);
        const saved = sessionStorage.getItem(storageKey);
        if (saved && !controller.signal.aborted) {
          let batch: Batch | null = null;
          try { batch = JSON.parse(saved) as Batch; } catch { sessionStorage.removeItem(storageKey); }
          if (batch && /^[a-f0-9]{32}$/.test(batch.requestId) && Array.isArray(batch.items) && batch.items.length > 0 && batch.items.length <= 100
            && batch.items.every(item => item && typeof item.appId === "string" && /^[a-z0-9][a-z0-9._-]{0,62}$/.test(item.appId) && /^[a-f0-9]{64}$/.test(item.planDigest))
            && new Set(batch.items.map(item => item.appId)).size === batch.items.length) setPending(batch);
          else sessionStorage.removeItem(storageKey);
        }
      } catch (failure) { if (!controller.signal.aborted) setError(message(failure)); }
    })();
    return () => controller.abort();
  }, [coreOrigin, storageKey]);
  async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await sendCsrfJson(coreOrigin + path, body);
    if (!response.ok) {
      const detail = await readCoreErrorDetail(response);
      throw new CoreRequestError(detail.message, detail.code, response.status, detail.body);
    }
    return await response.json() as T;
  }
  async function reviewSuggested() {
    setBusy(true); setError(null); setResults([]);
    const reviewed: Plan[] = [], failures: string[] = [];
    for (const suggestion of suggestions) {
      try { reviewed.push(await post<Plan>(`/api/apps/${encodeURIComponent(suggestion.migration.appId)}/update-source/plan`, {
        feedsUrl: suggestion.migration.to.feedsUrl, feedId: suggestion.migration.to.feedId,
        expectedRevision: suggestion.revision, migrationId: suggestion.migration.migrationId,
      })); } catch (failure) { failures.push(`${suggestion.migration.appId}: ${message(failure)}`); }
    }
    setPlans(reviewed); setSelected(reviewed.map(plan => plan.appId)); setError(failures.join(" ") || null); setBusy(false);
  }
  async function reviewReturn(id: string, binding: Binding) {
    setBusy(true); setError(null);
    try {
      const plan = await post<Plan>(`/api/apps/${encodeURIComponent(id)}/update-source/plan`, binding.feedsUrl
        ? { feedsUrl: binding.feedsUrl, feedId: binding.feedId } : { manifestUrl: binding.manifestUrl });
      setPlans([plan]); setSelected([plan.appId]);
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  async function apply() {
    const batch = pending ?? { requestId: crypto.randomUUID().replaceAll("-", ""), items: plans.filter(plan => selected.includes(plan.appId)).map(plan => ({ appId: plan.appId, planDigest: plan.planDigest })) };
    if (!batch.items.length) return;
    setBusy(true); setError(null);
    try {
      // Persist before dispatch: a lost response is retried with the same exact reviewed batch.
      sessionStorage.setItem(storageKey, JSON.stringify(batch)); setPending(batch);
      const response = await post<{ results: Result[] }>("/api/apps/update-source/apply", batch);
      setResults(response.results); sessionStorage.removeItem(storageKey); setPending(null); setPlans([]); setSelected([]);
      const completed = new Set(response.results.filter(result => result.operation?.status === "completed").map(result => result.appId));
      setSuggestions(previous => previous.filter(item => !completed.has(item.migration.appId)));
      await onChanged();
    } catch (failure) {
      const code = failure && typeof failure === "object" && "code" in failure ? failure.code : null;
      if (code === "settings_review_not_applied" || failure instanceof CoreRequestError && [400, 403, 404, 409].includes(failure.status)) {
        sessionStorage.removeItem(storageKey); setPending(null);
      }
      setError(message(failure));
    }
    finally { setBusy(false); }
  }
  const name = (id: string) => apps.find(app => app.id === id)?.displayName ?? id;
  return <section className="rounded-xl border bg-card">
    <header className="border-b px-4 py-3"><h2 className="text-sm font-medium">Application update sources</h2></header>
    <div className="space-y-4 p-4">
      <p className="text-sm text-muted-foreground">Choose an application’s update channel in its Updates tab. Its publisher provides the update source. Suggested publisher migrations can be reviewed here; applying an update remains a separate action.</p>
      {suggestions.length > 0 && <div className="space-y-2"><p className="text-sm">{suggestions.length} existing sources have a migration available. Review the destination feed and publisher before applying.</p>
        <Button variant="outline" onClick={() => void reviewSuggested()} disabled={busy || !!pending}>Review suggested migrations</Button></div>}
      {plans.map(plan => <div key={plan.appId} className="space-y-2 rounded-lg border p-3 text-sm">
        <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={selected.includes(plan.appId)} disabled={busy || !!pending} onChange={event => setSelected(previous => event.target.checked ? [...previous, plan.appId] : previous.filter(id => id !== plan.appId))} />{name(plan.appId)}</label>
        <p className="break-all text-muted-foreground">Current: {plan.from.feedsUrl ?? plan.from.manifestUrl}{plan.from.feedId ? ` — ${plan.from.feedId}` : ""}</p>
        <p className="break-all">Destination: {plan.to.feedsUrl ?? plan.to.manifestUrl}{plan.to.feedId ? ` — ${plan.to.feedId}` : ""}</p>
        <p>Available version: {plan.targetVersion}. {plan.ordering === "installed-ahead" ? "The installed version is ahead and will be kept." : plan.ordering.includes("unknown") ? "Release ordering needs review before an update." : "The installed version will be kept."}</p>
      </div>)}
      {(plans.length > 0 || pending) && <Button onClick={() => void apply()} disabled={busy || !pending && !selected.length}>{pending ? "Recover source switch result" : `Apply ${selected.length} reviewed source switches`}</Button>}
      {results.map(result => <div key={result.appId}><p role={result.error ? "alert" : "status"} className={`text-sm ${result.error ? "text-destructive" : ""}`}>{name(result.appId)}: {result.error ?? "Future update source changed. Installed application unchanged."}</p>{result.operation?.previous && <Button variant="outline" disabled={busy || !!pending} onClick={() => void reviewReturn(result.appId, result.operation!.previous)}>Review return to previous source</Button>}</div>)}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  </section>;
}
function message(error: unknown) { return error instanceof Error ? error.message : "Could not complete the source-switch request."; }
