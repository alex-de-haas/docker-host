"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { getStorageRecovery, type StorageRecoveryReport } from "@/lib/assistant-api";

/** A bounded operator inventory; opening or refreshing it never starts recovery or resubmits work. */
export function StorageRecoveryNotice() {
  const [report, setReport] = useState<StorageRecoveryReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [revision, setRevision] = useState(0);
  const pending = useRef(true);
  useEffect(() => {
    let active = true;
    const controller = new AbortController(); pending.current = true;
    void getStorageRecovery(controller.signal).then(value => {
      if (active) { setReport(value); setError(null); }
    }).catch(cause => {
      if (active && !controller.signal.aborted) setError((cause instanceof Error ? cause.message : "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 240) || "Storage recovery status is unavailable.");
    }).finally(() => { if (active) { pending.current = false; setBusy(false); } });
    return () => { active = false; controller.abort(); };
  }, [revision]);
  useEffect(() => {
    const refresh = () => {
      if (pending.current) return;
      pending.current = true; setBusy(true); setRevision(value => value + 1);
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  const source = report?.issues ?? [], projections = report?.projectionIssues ?? [];
  if (!source.length && !projections.length && !error) return null;
  return <section aria-label="Storage recovery status" className="shrink-0 space-y-2 border-b px-4 py-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p role="status">{source.length ? `${source.length} reported session storage issue${source.length === 1 ? "" : "s"}.` : "History storage needs attention."}
        {projections.length > 0 && ` ${projections.length} history view${projections.length === 1 ? " needs" : "s need"} attention.`}</p>
      <Button type="button" size="sm" variant="outline" disabled={busy} aria-label="Refresh storage recovery status"
        onClick={() => { if (!pending.current) { pending.current = true; setBusy(true); setRevision(value => value + 1); } }}>{busy ? "Refreshing…" : "Refresh"}</Button>
    </div>
    {(source.length > 0 || projections.length > 0) && <details>
      <summary className="cursor-pointer">Show recovery details</summary>
      <ul className="mt-2 max-h-48 space-y-1 overflow-auto text-xs">
        {[...source, ...projections].map((issue, index) => <li key={`${issue.sessionId}:${issue.code}:${index}`} className="wrap-anywhere">
          <span className="font-mono">{issue.sessionId}</span>: {issue.message || issue.code}
        </li>)}
      </ul>
    </details>}
    {error && <p role="alert" className="wrap-anywhere text-destructive-foreground">{error}</p>}
  </section>;
}
