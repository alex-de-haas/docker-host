"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History, Loader2, MessageSquarePlus, Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, InlineError, StatusBadge } from "@/components/status";
import { TranscriptEvent } from "@/components/transcript";
import { cn } from "@/lib/utils";
import { establishSession } from "@/lib/api";
import { composeAskDraft } from "@/lib/ask-draft";
import { startThemeSync } from "@/lib/shell-theme";
import {
  createSession,
  getHealth,
  getSession,
  listSessions,
  postMessage,
  resolveApproval,
  resolveQuestion,
  streamEvents,
  type AssistantEvent,
  type AssistantSession,
  type HarnessHealth,
} from "@/lib/assistant-api";

// The operator chat, served by the gateway and docked in Shell's right panel.
//
// It used to be a Dialog inside Shell, pinned over the page. Docked, the operator can read the error
// they are asking about while they ask — the close-to-look move that lost drafts is simply gone.
//
// Which session is open lives in storage rather than in the embedder: closing the panel never stops
// the harness run, so a reload that forgot the id would orphan a live run behind a brand-new session.
const SESSION_STORAGE_KEY = "hosty.assistant.session";
/** An ask is a prompt fragment, not a payload: anything longer is a page dumping itself into the draft. */
const MAX_ASK_CHARS = 4_000;


export default function AssistantPage() {
  const [health, setHealth] = useState<HarnessHealth | null>(null);
  const [sessions, setSessions] = useState<AssistantSession[]>([]);
  const [session, setSession] = useState<AssistantSession | null>(null);
  const [status, setStatus] = useState("idle");
  const [events, setEvents] = useState<AssistantEvent[]>([]);
  const [streamed, setStreamed] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [ready, setReady] = useState(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => startThemeSync(), []);

  /** Attaches to one session and follows its log. Shared by reattach, switch and new. */
  const attach = useCallback((record: AssistantSession) => {
    streamAbortRef.current?.abort();
    setSession(record);
    setStatus(record.status);
    setEvents([]);
    setStreamed("");
    try {
      window.localStorage.setItem(SESSION_STORAGE_KEY, record.id);
    } catch {
      // Private-mode storage refusal costs reattachment across reloads, nothing else.
    }

    const abort = new AbortController();
    streamAbortRef.current = abort;
    void streamEvents(
      record.id,
      (event) => {
        if (event.type === "assistant_delta") {
          setStreamed((current) => current + String(event.text ?? ""));
          return;
        }
        if (event.type === "assistant_text") {
          setStreamed("");
        }
        if (event.type === "session_status") {
          setStatus(String(event.status ?? "idle"));
          return;
        }
        setEvents((current) => [...current, event]);
      },
      abort.signal,
    );
  }, []);

  const startNew = useCallback(async () => {
    setError(null);
    try {
      const record = await createSession({});
      setSessions((current) => [record, ...current]);
      setShowSessions(false);
      attach(record);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [attach]);

  // The session before the data, as on the settings page: a launch code that has not been spent yet
  // means every request below is answered 401 by a gateway that is working correctly.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await establishSession();
        const [harness, list] = await Promise.all([getHealth(), listSessions().catch(() => [])]);
        if (cancelled) {
          return;
        }
        setHealth(harness);
        setSessions(list);
        if (!harness.available) {
          return;
        }

        // Reattach first: the stream replays from seq 0, which rebuilds unresolved approval cards.
        let stored: string | null = null;
        try {
          stored = window.localStorage.getItem(SESSION_STORAGE_KEY);
        } catch {
          // Private-mode storage can refuse reads as well as writes; that costs reattachment, and
          // must not take the whole page down with it.
        }
        const previous = stored ? await getSession(stored).catch(() => null) : null;
        if (cancelled) {
          return;
        }

        if (previous) {
          attach(previous);
          return;
        }

        // Created because nothing was stored — and added to the list, or "Recent sessions" would
        // say there are none while one is open, and switching away would strand it.
        const created = await createSession({});
        if (cancelled) {
          return;
        }
        setSessions((current) => [created, ...current]);
        attach(created);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (!cancelled) {
          setReady(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      streamAbortRef.current?.abort();
    };
  }, [attach]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [events, streamed]);

  /**
   * An "ask the assistant" handed in by the embedder.
   *
   * It fills the draft and **stops there** — nothing is sent. That is the load-bearing rule, not a
   * nicety: text that originates outside the operator must not become agent behaviour without a
   * human between them, and an error message is exactly the shape a prompt injection arrives in. The
   * provenance line is part of the same rule: the operator has to be able to see everything the
   * model will, including where it came from.
   */
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Sender verification against the embedder's origin lands with the *public* message in the
      // routing deliverable, which is where its tests live. Today the only sender is Shell posting
      // into its own panel frame; the rule that actually holds the design up — the operator sends,
      // never the app — is enforced below by filling the draft and stopping.
      if (event.source !== window.parent) {
        return;
      }
      const data = event.data as { type?: unknown; text?: unknown; sourceAppId?: unknown } | null;
      if (!data || data.type !== "hosty:ask-assistant" || typeof data.text !== "string") {
        return;
      }

      const text = data.text.slice(0, MAX_ASK_CHARS);
      const sourceAppId = typeof data.sourceAppId === "string" ? data.sourceAppId : "";
      setInput((current) => composeAskDraft(current, text, sourceAppId));
      composerRef.current?.focus();
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const send = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || !session || sending) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      await postMessage(session.id, trimmed);
      setInput("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }, [input, sending, session]);

  const decide = useCallback(
    async (approvalId: string, decision: "allow" | "deny") => {
      if (!session) {
        return;
      }
      try {
        await resolveApproval(session.id, approvalId, decision);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [session],
  );

  const answer = useCallback(
    async (questionId: string, answers: Record<string, string>) => {
      if (!session) {
        return;
      }
      try {
        await resolveQuestion(session.id, questionId, answers);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [session],
  );

  const decidedApprovals = useMemo(() => {
    const decisions = new Map<string, string>();
    for (const event of events) {
      if (event.type === "approval_decision") {
        decisions.set(String(event.approvalId), String(event.decision));
      }
    }
    return decisions;
  }, [events]);

  // Answered questions collapse to their chosen values, the same way a resolved approval collapses to
  // a badge — a replayed transcript must not offer buttons for a pause that is already over.
  const answeredQuestions = useMemo(() => {
    const answers = new Map<string, Record<string, string>>();
    for (const event of events) {
      if (event.type === "question_answered") {
        answers.set(String(event.questionId), (event.answers ?? {}) as Record<string, string>);
      }
    }
    return answers;
  }, [events]);

  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <Sparkles className="hosty-shell-chrome h-4 w-4 shrink-0" aria-hidden />
        <span className="hosty-shell-chrome text-sm font-medium">Assistant</span>
        <StatusBadge value={status} />
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="Recent sessions"
            aria-label="Recent sessions"
            aria-pressed={showSessions}
            className={cn(showSessions && "bg-muted")}
            onClick={() => setShowSessions((open) => !open)}
          >
            <History className="h-4 w-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" title="New session" aria-label="New session" onClick={() => void startNew()}>
            <MessageSquarePlus className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {showSessions ? (
        <SessionList
          sessions={sessions}
          activeId={session?.id ?? null}
          onPick={(record) => {
            setShowSessions(false);
            attach(record);
          }}
        />
      ) : (
        <>
          <div ref={transcriptRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            {health && !health.available && (
              <Alert severity="warning" title="Assistant unavailable" detail={health.reason} />
            )}
            {error && <InlineError message={error} />}
            {ready && health?.available && events.length === 0 && !streamed && (
              <p className="px-1 text-xs text-muted-foreground">
                Operator session on this host — every write asks first.
              </p>
            )}

            {events.map((event) => (
              <TranscriptEvent
                key={event.seq}
                event={event}
                decision={event.type === "approval_request" ? decidedApprovals.get(String(event.approvalId)) ?? null : null}
                answers={event.type === "question_request" ? answeredQuestions.get(String(event.questionId)) ?? null : null}
                onDecide={decide}
                onAnswer={answer}
              />
            ))}
            {streamed && (
              <div className="rounded-lg bg-muted/60 px-3 py-2 text-sm whitespace-pre-wrap">
                {streamed}
                <Loader2 className="ml-1 inline h-3 w-3 animate-spin text-muted-foreground" aria-hidden />
              </div>
            )}
          </div>

          <form
            className="flex shrink-0 items-end gap-2 border-t p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <textarea
              ref={composerRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              rows={2}
              placeholder={session ? "Ask the operator assistant…" : "Waiting for the gateway…"}
              disabled={!session || sending}
              className="flex-1 resize-none rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
            />
            <Button type="submit" size="icon" disabled={!session || sending || !input.trim()} aria-label="Send">
              {sending ? <Loader2 className="animate-spin" /> : <Send />}
            </Button>
          </form>
        </>
      )}
    </div>
  );
}

// The history the Shell panel never had: closing it used to be the only way back to a previous
// conversation, and there was no way back at all.
function SessionList({
  sessions,
  activeId,
  onPick,
}: {
  sessions: AssistantSession[];
  activeId: string | null;
  onPick: (session: AssistantSession) => void;
}) {
  if (sessions.length === 0) {
    return <p className="p-3 text-xs text-muted-foreground">No sessions yet.</p>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      {sessions.map((record) => (
        <button
          key={record.id}
          type="button"
          onClick={() => onPick(record)}
          className={cn(
            "block w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted",
            record.id === activeId && "bg-muted",
          )}
        >
          <div className="truncate text-sm">{record.title || "Untitled session"}</div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{new Date(record.createdAt).toLocaleString()}</span>
            <span aria-hidden>·</span>
            <span>{record.status}</span>
          </div>
        </button>
      ))}
    </div>
  );
}
