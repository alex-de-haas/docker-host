"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History, Loader2, MessageSquarePlus, Paperclip, Send, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, InlineError, StatusBadge } from "@/components/status";
import { Markdown } from "@/components/markdown";
import { SessionList } from "@/components/session-list";
import { takeChosenFiles } from "@/lib/attachments";
import { TranscriptEvent, type ApprovalDecision } from "@/components/transcript";
import { cn } from "@/lib/utils";
import { establishSession } from "@/lib/api";
import { composeAskDraft } from "@/lib/ask-draft";
import { clearDraft, pruneDrafts, readDraft, writeDraft } from "@/lib/draft-store";
import { orderSessions, publishAttention, waitingCount } from "@/lib/attention";
import { startThemeSync } from "@/lib/shell-theme";
import {
  createSession,
  deleteSession,
  getHealth,
  getSession,
  listAppNames,
  listSessions,
  postMessage,
  uploadAttachment,
  type StoredAttachment,
  renameSession,
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
  // Chosen but not yet sent. Uploaded only when the message goes, so a file picked and then
  // reconsidered never reaches the gateway.
  const [pending, setPending] = useState<File[]>([]);
  // Fetched once: the roster changes when apps are installed, not between messages, and a failed
  // read leaves every label as the wire name — which is what the transcript showed before.
  const [appNames, setAppNames] = useState<Record<string, string>>({});
  // Already stored for this message but not yet sent — kept across a failed send, so a retry names
  // them instead of uploading them again under de-duplicated names.
  const [uploaded, setUploaded] = useState<StoredAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [showSessions, setShowSessions] = useState(false);
  const [ready, setReady] = useState(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  // A session this client was watching that no longer exists; cleared once acted on.
  const [deletedElsewhere, setDeletedElsewhere] = useState<string | null>(null);
  // Sessions this tab deleted itself. The deletion fans out to every subscriber including this one,
  // and its own click must not come back as "this session was deleted" from somewhere else.
  const selfDeleted = useRef(new Set<string>());
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
    // Files are not a draft: a selection made for one session must not follow the operator into
    // the next and be uploaded there.
    setPending([]);
    setUploaded([]);
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
        if (event.type === "session_deleted") {
          if (selfDeleted.current.delete(record.id)) {
            // This tab's own delete, already handled where the button was pressed.
            return;
          }
          // Deleted from somewhere else — another tab, another client. Recorded for the effect
          // below rather than handled here: detaching needs the session list and the new-session
          // path, and reaching those from inside the stream callback would tie this callback to
          // state it must not go stale on.
          setDeletedElsewhere(record.id);
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

  useEffect(() => {
    let cancelled = false;
    listAppNames()
      .then((names) => {
        if (!cancelled) {
          setAppNames(names);
        }
      })
      .catch(() => {
        // Labels stay as the wire names. Not surfaced: an operator cannot act on it, and the
        // transcript is still readable, just less friendly.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const send = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || !session || sending) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      // Files first, then the message that names them by their stored names — which may differ from
      // what the operator called them. A failed upload stops here with the text kept, so nothing is
      // sent that refers to a file the gateway does not have.
      const stored = [...uploaded];
      for (const file of pending) {
        const attachment = await uploadAttachment(session.id, file);
        // Moved as each lands, not after all have: a failure part-way leaves the ones that made it
        // in `uploaded` and the rest still pending, so the retry sends exactly what is missing.
        stored.push(attachment);
        setUploaded((current) => [...current, attachment]);
        setPending((current) => current.filter((candidate) => candidate !== file));
      }
      await postMessage(session.id, trimmed, stored.map((attachment) => attachment.name));
      setUploaded([]);
      setPending([]);
      setInput("");
      // Cleared only once the gateway has it: clearing before the round trip would lose the text on
      // exactly the failure the operator most wants it kept for.
      clearDraft(session.id);
      // The gateway names an unnamed session from its first message, so the record the list holds is
      // stale the moment that message lands. Re-read rather than deriving the same title here: two
      // implementations of one rule drift, and the server's is the one that is stored.
      if (!session.title) {
        const named = await getSession(session.id).catch(() => null);
        if (named?.title) {
          setSession(named);
          setSessions((current) => current.map((record) => (record.id === named.id ? named : record)));
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }, [input, pending, sending, session, uploaded]);

  const remove = useCallback(
    async (sessionId: string) => {
      setError(null);
      // Claimed before the request: the fan-out can reach this tab's own stream before the response
      // does, and this is what tells the two apart.
      selfDeleted.current.add(sessionId);
      try {
        await deleteSession(sessionId);
        // The draft belonged to a session that no longer exists; leaving it behind would resurrect
        // someone's half-written message under a future session's id.
        clearDraft(sessionId);
        setSessions((current) => current.filter((entry) => entry.id !== sessionId));
        if (session?.id === sessionId) {
          // The open session was the one deleted: drop its stream and start a fresh one, rather
          // than leaving the panel attached to a transcript that is gone.
          streamAbortRef.current?.abort();
          try {
            window.localStorage.removeItem(SESSION_STORAGE_KEY);
          } catch {
            // Private-mode storage can refuse writes; the reattach path already tolerates a stored
            // id that no longer resolves.
          }
          await startNew();
        }
      } catch (cause) {
        // Nothing was deleted, so the claim must not outlive the attempt — a later deletion from
        // another tab would otherwise be swallowed as this one's own.
        selfDeleted.current.delete(sessionId);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [session, startNew],
  );

  useEffect(() => {
    if (!deletedElsewhere) {
      return;
    }
    setDeletedElsewhere(null);
    setSessions((current) => current.filter((entry) => entry.id !== deletedElsewhere));
    clearDraft(deletedElsewhere);
    if (session?.id === deletedElsewhere) {
      // The open session was deleted elsewhere: the composer must stop pointing at it, or the next
      // message is sent into a session that is not there.
      streamAbortRef.current?.abort();
      try {
        window.localStorage.removeItem(SESSION_STORAGE_KEY);
      } catch {
        // Reattachment across reloads already tolerates a stored id that no longer resolves.
      }
      setError("This session was deleted. Started a new one.");
      void startNew();
    }
  }, [deletedElsewhere, session, startNew]);

  const rename = useCallback(async (sessionId: string, title: string) => {
    setError(null);
    try {
      const record = await renameSession(sessionId, title);
      setSessions((current) => current.map((entry) => (entry.id === record.id ? record : entry)));
      setSession((current) => (current?.id === record.id ? record : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const decide = useCallback(
    async (approvalId: string, decision: "allow" | "deny", message?: string) => {
      if (!session) {
        return;
      }
      try {
        await resolveApproval(session.id, approvalId, decision, message);
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
    const decisions = new Map<string, ApprovalDecision>();
    for (const event of events) {
      if (event.type === "approval_decision") {
        decisions.set(String(event.approvalId), {
          decision: String(event.decision),
          // The operator's reason rides on the decision event, so a replayed transcript shows why a
          // card was refused and not only that it was.
          message: typeof event.message === "string" && event.message ? event.message : null,
        });
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
            onClick={() => {
              // Re-read on open: titles and statuses move on the server — another client's session
              // was named by its first message, one of them is now waiting — and a list that only
              // ever reflects this tab's own actions is a list the operator learns not to trust.
              setShowSessions((open) => {
                if (!open) {
                  void listSessions()
                    .then(setSessions)
                    .catch(() => undefined);
                }
                return !open;
              });
            }}
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
          onRename={rename}
          onDelete={remove}
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
                appNames={appNames}
                decision={event.type === "approval_request" ? decidedApprovals.get(String(event.approvalId)) ?? null : null}
                answers={event.type === "question_request" ? answeredQuestions.get(String(event.questionId)) ?? null : null}
                // Absent reads as "cannot": a reason box on a harness whose decline carries nothing
                // would promise delivery the gateway then refuses.
                denyReason={health?.capabilities?.denyReason === true}
                onDecide={decide}
                onAnswer={answer}
              />
            ))}
            {streamed && (
              // Formatted while it streams, not once it lands: the parser closes an unfinished block
              // at the end of what has arrived, so a half-written table is a table with fewer rows
              // rather than a paragraph of pipes that reflows the moment the turn ends.
              <div className="rounded-lg bg-muted/60 px-3 py-2">
                <Markdown text={streamed} />
                <Loader2 className="ml-1 inline h-3 w-3 animate-spin text-muted-foreground" aria-hidden />
              </div>
            )}
          </div>

          {(pending.length > 0 || uploaded.length > 0) && (
            <div className="flex shrink-0 flex-wrap gap-1 border-t px-3 pt-2 text-xs">
              {uploaded.map((attachment) => (
                <span key={`stored-${attachment.name}`} className="inline-flex max-w-[16rem] items-center gap-1 rounded border px-1.5 py-0.5">
                  <Paperclip className="h-3 w-3 shrink-0" aria-hidden />
                  <span className="truncate">{attachment.name}</span>
                </span>
              ))}
              {pending.map((file, index) => (
                <span key={`${file.name}-${index}`} className="inline-flex max-w-[16rem] items-center gap-1 rounded border px-1.5 py-0.5">
                  <Paperclip className="h-3 w-3 shrink-0" aria-hidden />
                  <span className="truncate">{file.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => setPending((current) => current.filter((_, i) => i !== index))}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
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
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                // Read before the state update is scheduled. A functional updater runs when React
                // flushes, after this handler has returned — and by then the reset on the next line
                // has already emptied `files`. Written that way first, every selection appended
                // nothing: no chip, no upload, a message sent without the file the operator chose.
                const chosen = takeChosenFiles(event.target);
                setPending((current) => [...current, ...chosen]);
              }}
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              disabled={!session || sending}
              aria-label="Attach files"
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip />
            </Button>
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
