"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchCore } from "../core-transport";
import { readCoreError } from "../core-api";

type FeedState = {
  source: { indexRef: string; feedId: string; revision: string } | null;
  indexRef: string;
  index: { feeds: { id: string; label?: string; default?: boolean }[] };
};

export function PlatformFeedSettings({ coreOrigin, sendCsrfJson }: {
  coreOrigin: string;
  sendCsrfJson: (url: string, body: unknown, method?: string) => Promise<Response>;
}) {
  const [state, setState] = useState<FeedState | null>(null);
  const [indexRef, setIndexRef] = useState("");
  const [feedId, setFeedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetchCore(`${coreOrigin}/api/core/update-feed`, { credentials: "include", cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(await readCoreError(response));
        const value = await response.json() as FeedState;
        if (controller.signal.aborted) return;
        setState(value); setIndexRef(value.indexRef); setFeedId(value.source?.feedId ?? "");
      } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load update feeds."); }
    })();
    return () => controller.abort();
  }, [coreOrigin]);

  async function preview() {
    setBusy(true); setError(null); setSaved(false);
    try {
      const response = await fetchCore(`${coreOrigin}/api/core/update-feed?index=${encodeURIComponent(indexRef)}`, { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error(await readCoreError(response));
      const value = await response.json() as FeedState;
      setState(value);
      if (!value.index.feeds.some(feed => feed.id === feedId)) setFeedId("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not read feeds."); }
    finally { setBusy(false); }
  }

  async function save() {
    setBusy(true); setError(null); setSaved(false);
    try {
      const response = await sendCsrfJson(`${coreOrigin}/api/core/update-feed`, { indexRef, feedId, expectedRevision: state?.source?.revision ?? null }, "PUT");
      if (!response.ok) throw new Error(await readCoreError(response));
      const source = await response.json() as NonNullable<FeedState["source"]>;
      setState(previous => previous ? { ...previous, source } : previous); setSaved(true);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not select the feed."); }
    finally { setBusy(false); }
  }

  return <section className="rounded-xl border bg-card">
    <header className="border-b px-4 py-3"><h2 className="text-sm font-medium">Core and CLI update feed</h2></header>
    <div className="space-y-4 p-4">
      <p className="text-sm text-muted-foreground">Choose where this host receives platform releases. Saving changes the source for the next update.</p>
      <div className="space-y-2"><label htmlFor="platform-feed-index" className="text-sm font-medium">Feed index URL</label>
        <div className="flex gap-2"><Input id="platform-feed-index" value={indexRef} onChange={event => { setIndexRef(event.target.value); setSaved(false); }} disabled={busy} />
          <Button variant="outline" onClick={() => void preview()} disabled={busy || !indexRef}>Read feeds</Button></div></div>
      <div className="space-y-2"><label htmlFor="platform-feed" className="text-sm font-medium">Feed</label>
        <select id="platform-feed" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={feedId}
          onChange={event => { setFeedId(event.target.value); setSaved(false); }} disabled={busy || state?.indexRef !== indexRef}>
          <option value="">Select a feed</option>
          {feedId && !state?.index.feeds.some(feed => feed.id === feedId) && <option value={feedId} disabled>{feedId} — unavailable</option>}
          {state?.index.feeds.map(feed => <option key={feed.id} value={feed.id}>{feed.label || feed.id}{feed.default || state.index.feeds.length === 1 ? " (default)" : ""}</option>)}
        </select></div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {saved && <p role="status" className="text-sm">Update feed saved.</p>}
      <Button onClick={() => void save()} disabled={busy || !feedId || state?.indexRef !== indexRef}>Save feed</Button>
    </div>
  </section>;
}
