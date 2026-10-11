"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { sha256 } from "@noble/hashes/sha2.js";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { createAssistantRequestId } from "@hosty-sdk/app/assistant";
import { createPresentationRequestId, type PresentationResult } from "@hosty-sdk/app/ui";
import { useHostyUi } from "@hosty-sdk/app/ui/react";
import { LoaderCircleIcon, MessageCircleIcon } from "lucide-react";
import { discussionVersion, type DiscussionInput, type DiscussionOptions, type DiscussionResult } from "@/lib/discussion";
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
  const ui = useHostyUi();
  const [completed, setCompleted] = useState<{ result: DiscussionResult; presentationId: string; userId: string; path: string; source: string; contextKey: string } | null>(null);
  const [presentation, setPresentation] = useState<PresentationResult | null>(null);
  const [epoch, setEpoch] = useState(0);
  const running = useRef(false);
  const requests = useRef(new Map<string, { requestId: string; installationId: string }>());
  const results = useRef(new Map<string, NonNullable<typeof completed>>());
  const version = detail && discussionVersion(detail, workspaceId);
  const sourceKey = JSON.stringify([detail?.repository.id, detail?.path, workspaceId, version?.document.content]);
  const selected = options?.providers.find(item => `${item.appId}:${item.key}` === selection)
    ?? (options?.providers.length === 1 ? options.providers[0] : undefined);
  const contextKey = JSON.stringify([options?.userId, sourceKey, selected?.appId, selected?.key, selected?.installationId, selected?.problem]);
  const context = useRef<object | null>(null);
  useLayoutEffect(() => {
    const generation = {};
    context.current = generation;
    return () => { if (context.current === generation) context.current = null; };
  }, [contextKey]);

  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    const load = () => {
      if (loading) return;
      loading = true;
      void appFetch("/api/assistant", { cache: "no-store", signal: controller.signal })
      .then(responseBody<DiscussionOptions>).then(value => { if (!controller.signal.aborted) { setOptions(value); setError(null); } })
      .catch(cause => { if (!controller.signal.aborted) setError(failure(cause)); })
      .finally(() => { loading = false; });
    };
    load(); window.addEventListener("focus", load);
    return () => { controller.abort(); window.removeEventListener("focus", load); };
  }, [epoch]);

  useEffect(() => ui.subscribe(event => {
    if (event.type === "presentation" && event.value.requestId === completed?.presentationId) setPresentation(event.value);
  }), [ui, completed?.presentationId]);

  async function present(value: NonNullable<typeof completed>, generation = context.current) {
    if (!generation || context.current !== generation || value.contextKey !== contextKey) return;
    setCompleted(value);
    setPresentation(null);
    if (!value.result.target) return;
    const result = await ui.openSurface(value.result.target, { placement: "side", requestId: value.presentationId });
    if (context.current === generation) setPresentation(result);
  }

  async function discuss(startNew = false) {
    if (running.current || !detail || !version || !selected?.installationId || selected.problem || !options) return;
    const generation = context.current;
    running.current = true; setPending(true); setError(null);
    try {
      // Named HTTP localhost origins do not expose Web Crypto in every supported browser.
      const contentHash = Array.from(sha256(new TextEncoder().encode(version.document.content)), value => value.toString(16).padStart(2, "0")).join("");
      const input = { repositoryId: detail.repository.id, path: detail.path, workspaceId: version.workspaceId,
        contentHash, providerAppId: selected.appId, key: selected.key };
      const storageKey = `hosty.plans.discussion:${JSON.stringify([options.userId, input])}`;
      // A reinstall must revalidate the pinned pending intent before offering a new discussion.
      const resultKey = JSON.stringify([storageKey, selected.installationId]);
      const existing = !startNew && results.current.get(resultKey);
      if (existing) { await present(existing, generation); return; }
      let intent = startNew ? undefined : requests.current.get(storageKey);
      if (!intent && !startNew) {
        let saved: string | null = null;
        try { saved = sessionStorage.getItem(storageKey); } catch { /* Storage may be disabled. */ }
        if (saved !== null) {
          let stored: unknown;
          try { stored = JSON.parse(saved); } catch { /* Bare UUIDs from older Plans have no installation identity. */ }
          if (!stored || typeof stored !== "object" || !("requestId" in stored) || typeof stored.requestId !== "string"
            || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(stored.requestId)
            || !("installationId" in stored) || typeof stored.installationId !== "string" || !stored.installationId) {
            throw { code: "pending_intent_obsolete", message: "The saved discussion cannot be resumed safely. It may already exist; choose Start a new discussion to create another." };
          }
          intent = { requestId: stored.requestId, installationId: stored.installationId };
        }
      }
      intent ??= { requestId: createAssistantRequestId(), installationId: selected.installationId };
      requests.current.set(storageKey, intent);
      try { sessionStorage.setItem(storageKey, JSON.stringify(intent)); } catch { /* Preserve in memory for this page. */ }
      const body: DiscussionInput = { ...input, ...intent };
      const result = await appFetch("/api/assistant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then(responseBody<DiscussionResult>);
      const value = { result, presentationId: createPresentationRequestId(), userId: options.userId, path: detail.path, source: sourceKey, contextKey };
      results.current.set(resultKey, value);
      await present(value, generation);
    } catch (cause) {
      if (context.current === generation) setError(failure(cause));
    } finally { running.current = false; if (context.current) setPending(false); }
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
      {["handoff_closed", "request_expired", "conversation_deleted", "provider_changed", "pending_intent_obsolete"].includes(error.code ?? "") &&
        <Button variant="link" size="sm" disabled={pending} onClick={() => void discuss(true)}>Start a new discussion</Button>}
    </div>}
    {!error && detail && unavailable && <p role="status" className="text-right text-xs text-muted-foreground">{unavailable}</p>}
    {completed && completed.contextKey === contextKey && completed.userId === options?.userId && completed.path === detail?.path && completed.source === sourceKey && <div className="flex flex-wrap items-center justify-end gap-3 text-xs">
      <span role="status">{presentation?.status === "opened" ? presentation.readiness === "ready" ? "Discussion opened beside the document." : presentation.readiness === "unreported" ? "Discussion created. The assistant has not confirmed that it loaded." : presentation.readiness === "auth-required" ? "Discussion created. Check access in the assistant panel." : "Discussion created. Connecting to the assistant…"
        : "Discussion created. You can retry opening it here or open it separately."}</span>
      {completed.result.target && <Button variant="link" size="sm" disabled={pending} onClick={() => void present(completed)}>Retry opening</Button>}
      <a href={completed.result.url} target="_blank" rel="noopener noreferrer" className="underline">Open separately</a>
    </div>}
  </div>;
}
