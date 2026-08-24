"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History, Loader2, MessageSquarePlus, Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, InlineError, StatusBadge } from "@/components/status";
import { TranscriptEvent } from "@/components/transcript";
import { cn } from "@/lib/utils";
import { establishSession } from "@/lib/api";
import { composeAskDraft } from "@/lib/ask-draft";
import { clearDraft, pruneDrafts, readDraft, writeDraft } from "@/lib/draft-store";
import { isWaiting, orderSessions, publishAttention, waitingCount } from "@/lib/attention";
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
  // A session the embedder asked for before the list existed. Shell strips its parameter as soon as it
  // posts, so a request dropped here is not retried by anyone — it has to wait for the list instead.
  const [requestedSessionId, setRequestedSessionId] = useState<string | null>(null);
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
    // Whatever was left unsent in this session, put back in the box. Per session, so switching away
    // and back returns your own half-written sentence rather than someone else's.
    setInput(readDraft(record.id));
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
        // Listed separately from the health probe because a failure means different things: no
        // harness is a state to show, while no *list* is not knowledge of an empty fleet of sessions.
        const harness = await getHealth();
        const list = await listSessions().catch(() => null);
        if (list) {
          // Only after a successful listing. A transient failure answered as "no sessions" would have
          // this delete every saved draft — turning a network blip into permanent loss of exactly the
          // text this feature exists to protect.
          pruneDrafts(list.map((record) => record.id));
        }
        if (cancelled) {
          return;
        }
        setHealth(harness);
        // An unavailable listing leaves the list as it was rather than emptying it: "we could not
        // ask" and "there are none" are different statements, and only one of them is knowledge.
        setSessions(list ?? []);
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
      const data = event.data as
        | { type?: unknown; text?: unknown; sourceAppId?: unknown; sessionId?: unknown }
        | null;
      if (!data) {
        return;
      }

      if (data.type === "hosty:open-assistant-session" && typeof data.sessionId === "string") {
        // A notification arriving at the rail: open the session it was about. Only the id crosses —
        // the panel decides whether that session still exists and what to show, which is the same
        // division as everywhere else here.
        setRequestedSessionId(data.sessionId);
        return;
      }

      if (data.type !== "hosty:ask-assistant" || typeof data.text !== "string") {
        return;
      }

      const text = data.text.slice(0, MAX_ASK_CHARS);
      const sourceAppId = typeof data.sourceAppId === "string" ? data.sourceAppId : "";
      setInput((current) => composeAskDraft(current, text, sourceAppId));
      composerRef.current?.focus();
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // Re-attached when the session list changes: the handler resolves an incoming id against it, and
    // a listener closed over an empty first render would refuse every session that arrived later.
  }, [attach, sessions]);

  // Honoured once the list can answer. Held rather than dropped because the request arrives from a
  // notification the operator just acted on, and losing it silently is worse than opening a moment late.
  useEffect(() => {
    if (!requestedSessionId) {
      return;
    }
    const wanted = sessions.find((record) => record.id === requestedSessionId);
    if (wanted) {
      attach(wanted);
      setRequestedSessionId(null);
    }
  }, [attach, requestedSessionId, sessions]);

  // Written on change rather than on unload: a closed laptop, a crashed tab and a navigation away all
  // skip unload handlers, and those are exactly the cases where the text matters most.
  useEffect(() => {
    if (session) {
      writeDraft(session.id, input);
    }
  }, [input, session]);

  // The active session's status arrives on the stream, not in the list read at load. Folding it back
  // in is what keeps the ordering and the badge true for the session most likely to block — the one
  // the operator is watching.
  useEffect(() => {
    if (session) {
      setSessions((current) =>
        current.map((record) => (record.id === session.id ? { ...record, status } : record)),
      );
    }
  }, [session, status]);

  // One source: this page holds the list and the stream, so it publishes and the embedder listens. A
  // shell polling the gateway for the same fact would disagree with this one for its whole interval.
  useEffect(() => {
    publishAttention(waitingCount(sessions));
  }, [sessions]);

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
      // Cleared only once the gateway has it: clearing before the round trip would lose the text on
      // exactly the failure the operator most wants it kept for.
      clearDraft(session.id);
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
          sessions={orderSessions(sessions)}
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
            {isWaiting(record.status) && (
              // Marked as well as ordered: ordering alone is invisible to someone who has not seen the
              // list before, and the row has to say *why* it is first.
              <span className="inline-flex size-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden />
            )}
            <span>{new Date(record.createdAt).toLocaleString()}</span>
            <span aria-hidden>·</span>
            <span className={cn(isWaiting(record.status) && "font-medium text-amber-600 dark:text-amber-500")}>
              {isWaiting(record.status) ? "waiting for you" : record.status}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}
