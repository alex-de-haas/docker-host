"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { HostyNextOverlay } from "@hosty-sdk/app/next";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HostyLoader } from "../../../../../shared/web/hosty-states";

export function SettingsForm() {
  const [source, setSource] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [conflict, setConflict] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [reviewedSource, setReviewedSource] = useState<string | null>(null);
  const preserveDraftOnLoad = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    const preserveDraft = preserveDraftOnLoad.current;
    void appFetch("/api/settings", { signal: controller.signal }).then(async response => {
      const value = await response.json();
      if (!response.ok) throw new Error(value.message || "Marketplace settings could not be loaded.");
      if (typeof value.sourceUrl !== "string") throw new Error("The catalog source response is incomplete. Retry to load the settings.");
      if (!controller.signal.aborted) {
        // A conflict reread updates the comparison baseline, never the operator's attempted value.
        if (!preserveDraft) setSource(value.sourceUrl);
        setSaved(value.sourceUrl); setReviewedSource(preserveDraft ? value.sourceUrl : null); setConflict(false); setError("");
      }
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Marketplace settings could not be loaded."); })
      .finally(() => { if (!controller.signal.aborted) setReloading(false); });
    return () => controller.abort();
  }, [loadAttempt]);
  return <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-5 sm:px-6">
    <header className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
      <div className="min-w-0"><h1 className="text-xl font-semibold">Marketplace settings</h1><p className="mt-1 text-sm text-muted-foreground">Choose the catalog used to discover apps.</p></div>
      <Button asChild variant="outline"><Link href="/">Back to catalog</Link></Button>
    </header>
    {saved === null && !error && <div role="status" className="flex items-center gap-3 rounded-xl border bg-card p-4 text-sm text-muted-foreground"><HostyLoader label={null} /><span>Loading catalog settings…</span></div>}
    <form className="flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4 sm:p-5" onSubmit={async event => {
      event.preventDefault(); if (saved === null || busy || reloading || conflict || saved === source) return;
      setBusy(true); setError("");
      try {
        const response = await appFetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceUrl: source, expectedSourceUrl: saved }) });
        const value = await response.json();
        if (!response.ok) {
          if (response.status === 409 && value.code === "settings_conflict") { setConflict(true); setReviewedSource(null); }
          throw new Error(value.message || "Marketplace settings could not be saved.");
        }
        if (typeof value.sourceUrl !== "string") throw new Error("The settings save response is incomplete. Check the catalog source before retrying.");
        setSaved(value.sourceUrl); setSource(value.sourceUrl); setReviewedSource(null);
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Marketplace settings could not be saved."); }
      finally { setBusy(false); }
    }}>
      <label className="flex min-w-0 flex-col gap-2 text-sm" htmlFor="catalog-source">Catalog source
        <Input id="catalog-source" type="url" required value={source} disabled={saved === null || busy} aria-describedby="catalog-source-note" onChange={event => setSource(event.target.value)} />
      </label>
      <p id="catalog-source-note" className="text-xs text-muted-foreground">Use the HTTP or HTTPS address of a Hosty catalog.</p>
      {error && <p role="alert" className="min-w-0 break-words rounded-md border border-destructive/40 bg-destructive-soft p-3 text-sm text-destructive-foreground [overflow-wrap:anywhere]">{error}</p>}
      {conflict && <div className="flex min-w-0 flex-col items-start gap-2">
        <p className="text-sm text-muted-foreground">Your draft is kept. Load the current catalog source, then review it before saving your change.</p>
        <Button type="button" variant="outline" disabled={reloading} onClick={() => {
          preserveDraftOnLoad.current = true; setReloading(true); setError(""); setLoadAttempt(value => value + 1);
        }}>{reloading ? "Loading current settings…" : "Reload current settings"}</Button>
      </div>}
      {reviewedSource !== null && <p className="min-w-0 break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">Current saved catalog: <span className="font-mono">{reviewedSource}</span></p>}
      {saved === null && error ? <Button type="button" variant="outline" className="self-start" onClick={() => { setError(""); setLoadAttempt(value => value + 1); }}>Retry settings</Button>
        : <div className="flex flex-wrap items-center gap-3"><Button type="submit" disabled={saved === null || saved === source || busy || conflict || reloading}>{busy ? "Saving…" : "Save settings"}</Button>
          {saved !== null && <p role="status" className="text-xs text-muted-foreground">{busy ? "Saving catalog source…" : saved === source ? "Catalog settings are saved." : "You have unsaved changes."}</p>}</div>}
    </form>
  </main>;
}

export default function SettingsPage() { return <HostyNextOverlay chrome={{ navigation: "hide" }}><SettingsForm /></HostyNextOverlay>; }
