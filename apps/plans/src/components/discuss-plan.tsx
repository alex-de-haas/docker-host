"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { sha256 } from "@noble/hashes/sha2.js";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { createAssistantRequestId } from "@hosty-sdk/app/assistant";
import { LoaderCircleIcon, MessageCircleIcon } from "lucide-react";
import { discussionVersion, type DiscussionInput, type DiscussionOptions } from "@/lib/discussion";
import type { PlanDetail } from "@/lib/types";
import { Button } from "./ui/button";

type Failure = { message: string; reviewUrl?: string; code?: string };
async function responseBody<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw body;
  return body as T;
}
function failure(error: unknown): Failure {
  return error && typeof error === "object" && "message" in error && typeof error.message === "string"
    ? error as Failure : { message: "Could not reach the assistant. Retry to resume the same discussion." };
}

export function DiscussPlan({ detail, workspaceId, back, refresh }: { detail: PlanDetail | null; workspaceId: string | null; back?: ReactNode; refresh?: ReactNode }) {
  const [options, setOptions] = useState<DiscussionOptions | null>(null);
  const [selection, setSelection] = useState("");
  const [error, setError] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);
  const [openUrl, setOpenUrl] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const running = useRef(false);
  const requests = useRef(new Map<string, string>());
  const version = detail && discussionVersion(detail, workspaceId);
  const selected = options?.providers.find(item => `${item.appId}:${item.key}` === selection)
    ?? (options?.providers.length === 1 ? options.providers[0] : undefined);

  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    const load = () => {
      if (loading || running.current) return;
      loading = true;
      void appFetch("/api/assistant", { cache: "no-store", signal: controller.signal })
      .then(responseBody<DiscussionOptions>).then(value => { if (!controller.signal.aborted) { setOptions(value); setError(null); } })
      .catch(cause => { if (!controller.signal.aborted) setError(failure(cause)); })
      .finally(() => { loading = false; });
    };
    load(); window.addEventListener("focus", load);
    return () => { controller.abort(); window.removeEventListener("focus", load); };
  }, [epoch]);

  async function discuss(startNew = false) {
    if (running.current || !detail || !version || !selected || selected.problem || !options) return;
    running.current = true; setPending(true); setError(null); setOpenUrl(null);
    // Reserve the tab in the click gesture. If blocked, the finalized discussion remains a link.
    let tab: Window | null = null;
    try {
      tab = window.open("about:blank", "_blank");
      if (tab) { tab.opener = null; tab.document.title = "Opening Assistant"; tab.document.body.textContent = "Attaching the document to Assistant…"; }
      // Named HTTP localhost origins do not expose Web Crypto in every supported browser.
      const contentHash = Array.from(sha256(new TextEncoder().encode(version.document.content)), value => value.toString(16).padStart(2, "0")).join("");
      const input = { repositoryId: detail.repository.id, path: detail.path, workspaceId: version.workspaceId,
        contentHash, providerAppId: selected.appId, key: selected.key };
      const storageKey = `hosty.plans.discussion:${JSON.stringify([options.userId, input])}`;
      let requestId = startNew ? undefined : requests.current.get(storageKey);
      try { if (!startNew) requestId ??= sessionStorage.getItem(storageKey) ?? undefined; } catch { /* Memory retry identity remains available. */ }
      requestId ??= createAssistantRequestId();
      requests.current.set(storageKey, requestId);
      try { sessionStorage.setItem(storageKey, requestId); } catch { /* Preserve in memory for this page. */ }
      const body: DiscussionInput = { ...input, requestId };
      const result = await appFetch("/api/assistant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then(responseBody<{ url: string }>);
      setOpenUrl(result.url);
      if (tab && !tab.closed) tab.location.replace(result.url);
    } catch (cause) {
      tab?.close(); setError(failure(cause));
    } finally { running.current = false; setPending(false); }
  }

  const unavailable = !version ? "This document version is unavailable or deleted."
    : selected?.problem ?? (options?.providers.length === 0 ? "No assistant is installed." : null);
  return <div className="flex min-w-0 flex-col gap-2">
    <div className="flex items-center justify-between gap-3">
      {back}
      <div className="flex shrink-0 items-center gap-2">
      {options && options.providers.length > 1 && <select aria-label="Assistant for this discussion" value={selection} disabled={pending}
        className="h-9 w-32 rounded-md border bg-background px-2 text-sm" onChange={event => setSelection(event.target.value)}>
        <option value="">Choose assistant</option>
        {options.providers.map(item => <option key={`${item.appId}:${item.key}`} value={`${item.appId}:${item.key}`} disabled={!!item.problem}>{item.displayName}{item.key !== "default" ? ` (${item.key})` : ""}{item.problem ? " — unavailable" : ""}</option>)}
      </select>}
      <Button variant="outline" disabled={pending || !version || !selected || !!selected.problem} onClick={() => void discuss()}
        aria-label={pending ? "Attaching document to Assistant" : "Discuss with Assistant"} aria-busy={pending}
        title={unavailable ?? `${version?.label ?? "Document"}. Attach the Markdown file to a new assistant draft.`}>
        {pending ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : <MessageCircleIcon data-icon="inline-start" />}
        <span className="hidden sm:inline">{pending ? "Attaching…" : "Discuss with Assistant"}</span>
      </Button>
      {refresh}
      </div>
    </div>
    {error && <div role="alert" className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-sm text-destructive"><p>{error.message}</p>
      {error.reviewUrl && <a href={error.reviewUrl} target="_blank" rel="noopener noreferrer" className="underline">Review Plans permissions</a>}
      {!options && <Button variant="link" size="sm" onClick={() => setEpoch(value => value + 1)}>Retry</Button>}
      {["handoff_closed", "request_expired", "conversation_deleted"].includes(error.code ?? "") &&
        <Button variant="link" size="sm" disabled={pending} onClick={() => void discuss(true)}>Start a new discussion</Button>}
    </div>}
    {!error && detail && unavailable && <p role="status" className="text-right text-xs text-muted-foreground">{unavailable}</p>}
    {openUrl && <a href={openUrl} target="_blank" rel="noopener noreferrer" className="self-end text-xs underline">Open discussion</a>}
  </div>;
}
