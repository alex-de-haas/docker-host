"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CoreRequestError, isAuthRequiredRedirectError, readCoreErrorDetail } from "../core-api";
import { fetchCore } from "../core-transport";
import { useShellActions } from "../shell-context";
import type { CoreApp } from "../types";

type Binding = { manifestUrl: string | null; feedsUrl: string | null; feedId: string | null };
type Suggestion = { migration: { migrationId: string; appId: string; from: Binding; to: Binding }; revision: string };
type Plan = { appId: string; from: Binding; to: Binding; targetVersion: string; ordering: string; planDigest: string };
type Pending = { requestId: string; plan: Plan };
type Operation = { status: string; previous: Binding };

function pendingRequest(value: string | null, appId: string): Pending | null {
  try {
    const saved = value ? JSON.parse(value) as Pending : null;
    return saved && /^[a-f0-9]{32}$/.test(saved.requestId) && saved.plan?.appId === appId
      && /^[a-f0-9]{64}$/.test(saved.plan.planDigest) && saved.plan.from && saved.plan.to ? saved : null;
  } catch { return null; }
}

function sourceLabel(binding: Binding) {
  return binding.feedsUrl ? `${binding.feedsUrl} — ${binding.feedId}` : binding.manifestUrl ?? "Current installation source";
}

// Uses only Core's exact publisher migration suggestions. Opening an app never selects a source.
export function AppFeedSource({ app, coreOrigin, active, unbound, onChanged }: {
  app: CoreApp; coreOrigin: string; active: boolean; unbound: boolean; onChanged: () => void;
}) {
  const { sendCsrfJson, refresh } = useShellActions();
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [previous, setPrevious] = useState<Binding | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [reload, setReload] = useState(0);
  const alive = useRef(true);
  const working = useRef(false);
  const storageKey = `hosty-app-update-source:${coreOrigin}:${app.id}:${app.installationId ?? "legacy"}`;
  const route = `${coreOrigin}/api/apps/${encodeURIComponent(app.id)}/update-source`;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    // Restore browser-only recovery state after hydration, even if the source check fails.
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      try {
        const saved = pendingRequest(sessionStorage.getItem(storageKey), app.id);
        setPending(saved);
        if (saved) setPlan(saved.plan);
      } catch { /* A fresh review still works when browser storage is unavailable. Apply requires it. */ }
    });
    void (async () => {
      try {
        const response = await fetchCore(`${coreOrigin}/api/apps/update-source/suggestions`, { credentials: "include", cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          const detail = await readCoreErrorDetail(response);
          throw new CoreRequestError(detail.message, detail.code, response.status, detail.body);
        }
        const value = await response.json() as { suggestions?: Suggestion[] };
        if (!controller.signal.aborted) {
          setSuggestions((value.suggestions ?? []).filter(item => item.migration.appId === app.id));
          setError(null); setLoaded(true);
        }
      } catch (failure) {
        if (!controller.signal.aborted && !isAuthRequiredRedirectError(failure)) {
          setError(failure instanceof Error ? failure.message : "Could not check update sources."); setLoaded(true);
        }
      }
    })();
    return () => controller.abort();
  }, [active, coreOrigin, app.id, storageKey, reload]);

  async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await sendCsrfJson(path, body);
    if (!response.ok) {
      const detail = await readCoreErrorDetail(response);
      throw new CoreRequestError(detail.message, detail.code, response.status, detail.body);
    }
    return await response.json() as T;
  }

  async function review(body: unknown) {
    if (working.current || pending) return;
    working.current = true; setBusy(true); setError(null); setPlan(null); setNotice(null);
    try {
      const reviewed = await post<Plan>(route + "/plan", body);
      if (reviewed.appId !== app.id) throw new Error("The reviewed source belongs to another application.");
      if (alive.current) setPlan(reviewed);
    } catch (failure) {
      if (alive.current && !isAuthRequiredRedirectError(failure)) setError(failure instanceof Error ? failure.message : "Could not review the update source.");
    } finally { working.current = false; if (alive.current) setBusy(false); }
  }

  async function apply() {
    if (working.current || !plan) return;
    const request = pending ?? { requestId: crypto.randomUUID().replaceAll("-", ""), plan };
    working.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      // Persist before dispatch. An uncertain response must retain the exact request and plan.
      sessionStorage.setItem(storageKey, JSON.stringify(request)); setPending(request);
      const operation = await post<Operation>(route + "/apply", { planDigest: request.plan.planDigest, requestId: request.requestId });
      if (operation.status !== "completed") throw new Error("Source selection is not confirmed. Recover the result before starting another review.");
      sessionStorage.removeItem(storageKey);
      if (!alive.current) return;
      setPending(null); setPlan(null); setPrevious(operation.previous); setSuggestions([]);
      setNotice("Update source saved. The installed version is unchanged; check for updates when ready.");
      onChanged();
      try { await refresh(); }
      catch { if (alive.current) setError("The source was saved, but application details could not be refreshed. Reload this page."); }
    } catch (failure) {
      const code = failure && typeof failure === "object" && "code" in failure ? failure.code : null;
      if (code === "settings_review_not_applied" || failure instanceof CoreRequestError && [400, 403, 404, 409].includes(failure.status)) {
        sessionStorage.removeItem(storageKey);
        if (alive.current) { setPending(null); setPlan(null); setSuggestions([]); }
      }
      if (alive.current && !isAuthRequiredRedirectError(failure)) setError(failure instanceof Error ? failure.message : "Could not confirm the update source.");
    } finally { working.current = false; if (alive.current) setBusy(false); }
  }

  if (loaded && !unbound && !suggestions.length && !plan && !previous && !error && !notice) return null;
  return <div className="space-y-3" aria-label="Update source setup">
    {!loaded && <p role="status" className="text-sm text-muted-foreground">Checking available update sources…</p>}
    {suggestions.map(item => <div key={item.migration.migrationId} className="space-y-2 rounded-lg border p-3">
      <p className="text-sm">A published update source is available for this installation.</p>
      <p className="break-all text-xs text-muted-foreground">{sourceLabel(item.migration.to)}</p>
      <Button type="button" size="sm" variant="outline" disabled={busy || !!pending} onClick={() => void review({
        feedsUrl: item.migration.to.feedsUrl, feedId: item.migration.to.feedId,
        expectedRevision: item.revision, migrationId: item.migration.migrationId,
      })}>Review {item.migration.to.feedId} feed</Button>
    </div>)}
    {plan && <div className="space-y-2 rounded-lg border p-3" aria-label="Update source review">
      <p className="break-all text-sm">Current source: {sourceLabel(plan.from)}</p>
      <p className="break-all text-sm">New source: {sourceLabel(plan.to)}</p>
      <p className="text-sm text-muted-foreground">Available version: {plan.targetVersion}. {plan.ordering === "installed-ahead" ? "The installed version is newer and will be kept." : "This changes future updates only; it does not install or restart the application."}</p>
      <Button type="button" size="sm" disabled={busy} onClick={() => void apply()}>{pending ? "Recover source switch result" : "Use this update source"}</Button>
      {!pending && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setPlan(null)}>Cancel</Button>}
    </div>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {previous && <Button type="button" size="sm" variant="outline" disabled={busy || !!pending} onClick={() => void review(previous.feedsUrl
      ? { feedsUrl: previous.feedsUrl, feedId: previous.feedId } : { manifestUrl: previous.manifestUrl })}>Review previous source</Button>}
    {loaded && !error && !suggestions.length && !plan && !notice && <p className="text-sm text-muted-foreground">No suggested source change is available. The current installation source remains selected.</p>}
    {error && <div className="space-y-2"><p role="alert" className="text-sm text-destructive-foreground">{error}</p>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setReload(value => value + 1)}>Retry source check</Button></div>}
  </div>;
}
