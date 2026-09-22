"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SessionProvider } from "@/components/session-provider";
import { AppContextPicker } from "@/components/app-context-picker";
import { ArrowLeft, History, Loader2, MessageSquarePlus, Paperclip, Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, InlineError, StatusBadge } from "@/components/status";
import { Markdown } from "@/components/markdown";
import { ChatAttachment } from "@/components/chat-attachment";
import {
  MessageScroller, MessageScrollerButton, MessageScrollerContent,
  MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { transcriptItems } from "@/lib/transcript-items";
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "@/components/ui/input-group";
import { SessionList } from "@/components/session-list";
import { hasMessageContent, indexAttachments, takeChosenFiles, takePastedImages } from "@/lib/attachments";
import { ToolActivity, TranscriptEvent, type ApprovalDecision } from "@/components/transcript";
import { establishSession } from "@/lib/api";
import { composeAskDraft } from "@/lib/ask-draft";
import { clearDraft, pruneDrafts, readDraft, writeDraft } from "@/lib/draft-store";
import { orderSessions, publishAttention, waitingCount } from "@/lib/attention";
import {
  AssistantApiError,
  createSession,
  deleteSession,
  getHealth,
  stopSession,
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
const HISTORY_STORAGE_KEY = "hosty.assistant.history";
/** An ask is a prompt fragment, not a payload: anything longer is a page dumping itself into the draft. */
const MAX_ASK_CHARS = 4_000;


export default function AssistantPage() {
  const [health, setHealth] = useState<HarnessHealth | null>(null);
  const [sessions, setSessions] = useState<AssistantSession[]>([]);
  // Hold an embedder's session request until authentication finishes. Resolve it directly through
  // the API: a session Shell just created may not appear in this tab's initial list.
  const requestedSessionRef = useRef<string | null>(null);
  const [requestedSessionId, setRequestedSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<AssistantSession | null>(null);
  const [status, setStatus] = useState("idle");
  const [events, setEvents] = useState<AssistantEvent[]>([]);
  const [streamed, setStreamed] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [contextSaving, setContextSaving] = useState(false);
  const [contextUnavailable, setContextUnavailable] = useState(false);
  const [withoutAppDetails, setWithoutAppDetails] = useState(false);
  // Chosen but not yet sent. Uploaded only when the message goes, so a file picked and then
  // reconsidered never reaches the gateway.
  const [pending, setPending] = useState<File[]>([]);
  const [uploadingFile, setUploadingFile] = useState<File | null>(null);
  const [failedUpload, setFailedUpload] = useState<File | null>(null);
  // Fetched once: the roster changes when apps are installed, not between messages, and a failed
  // read leaves every label as the wire name — which is what the transcript showed before.
  const [appNames, setAppNames] = useState<Record<string, string>>({});
  // Already stored for this message but not yet sent — kept across a failed send, so a retry names
  // them instead of uploading them again under de-duplicated names.
  const [uploaded, setUploaded] = useState<StoredAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [showSessions, setShowSessions] = useState(false);
  const setHistoryOpen = useCallback((open: boolean) => {
    setShowSessions(open);
    try {
      window.localStorage.setItem(HISTORY_STORAGE_KEY, String(open));
    } catch {
      // Storage refusal only prevents restoring the current view after a reload.
    }
  }, []);
  const [ready, setReady] = useState(false);
  const activeSessionId = useRef<string | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  // A session this client was watching that no longer exists; cleared once acted on.
  const [deletedElsewhere, setDeletedElsewhere] = useState<string | null>(null);
  // Sessions this tab deleted itself. The deletion fans out to every subscriber including this one,
  // and its own click must not come back as "this session was deleted" from somewhere else.
  const selfDeleted = useRef(new Set<string>());

  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  /** Attaches to one session and follows its log. Shared by reattach, switch and new. */
  const attach = useCallback((record: AssistantSession) => {
    streamAbortRef.current?.abort();
    activeSessionId.current = record.id;
    setSession(record);
    setHealth(null);
    void getHealth(record.id).then(value => { if (activeSessionId.current === record.id) setHealth(value); }).catch(() => {});
    setError(null);
    setContextUnavailable(false);
    setWithoutAppDetails(false);
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
    setUploadingFile(null);
    setFailedUpload(null);
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
        if (abort.signal.aborted) return;
        if (event.type === "session_provider_changed") {
          void getSession(record.id).then(value => { if (activeSessionId.current === record.id) setSession(value); }).catch(() => {});
          void getHealth(record.id).then(value => { if (activeSessionId.current === record.id) setHealth(value); }).catch(() => {});
          return;
        }
        if (event.type === "user_message") setSession(current => current?.id === record.id ? { ...current, ...(current.providerLocked !== undefined ? { providerLocked: true } : {}) } : current);
        if (event.type === "app_context_changed") {
          const revision = Number(event.appContextRevision);
          setSession(current => current?.id === record.id && revision > (current.appContextRevision ?? 0)
            ? { ...current, appIds: event.appIds as string[], appContextRevision: revision } : current);
        }
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
          // below rather than handled here: detaching clears the conversation and opens history,
          // and reaching that state from inside the stream callback would tie this callback to
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
      setHistoryOpen(false);
      attach(record);
      return record;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [attach, setHistoryOpen]);

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


        // Reattach first: the stream replays from seq 0, which rebuilds unresolved approval cards.
        let stored: string | null = null;
        let restoreHistory = false;
        try {
          stored = window.localStorage.getItem(SESSION_STORAGE_KEY);
          restoreHistory = window.localStorage.getItem(HISTORY_STORAGE_KEY) === "true";
        } catch {
          // Private-mode storage can refuse reads as well as writes; that costs reattachment, and
          // must not take the whole page down with it.
        }
        const previous = stored ? await getSession(stored).catch(() => null) : null;
        if (cancelled) {
          return;
        }

        if (requestedSessionRef.current) return;
        setShowSessions(restoreHistory);

        if (previous) {
          attach(previous);
          return;
        }

        // Deleting the last session leaves an empty history, including after a reload.
        if (restoreHistory) return;

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
        requestedSessionRef.current = data.sessionId;
        setRequestedSessionId(data.sessionId);
        return;
      }

      if (data.type !== "hosty:ask-assistant" || typeof data.text !== "string") {
        return;
      }

      const text = data.text.slice(0, MAX_ASK_CHARS);
      const sourceAppId = typeof data.sourceAppId === "string" ? data.sourceAppId : "";
      // After deleting the active session, history intentionally has no attached conversation.
      // An explicit ask may start one, but still only fills its draft and never sends a message.
      if (!activeSessionId.current) {
        void startNew().then(record => {
          if (record && activeSessionId.current === record.id) {
            setInput(current => composeAskDraft(current, text, sourceAppId));
          }
        });
        return;
      }
      setHistoryOpen(false);
      setInput((current) => composeAskDraft(current, text, sourceAppId));
      composerRef.current?.focus();
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [startNew, setHistoryOpen]);

  // Shell can create a session after the initial list was fetched. Resolve the requested id
  // through the authenticated API, and never replace a newer request with an older response.
  useEffect(() => {
    if (!requestedSessionId || !ready) return;
    let cancelled = false;
    void getSession(requestedSessionId).then(record => {
      if (cancelled) return;
      setSessions(current => [record, ...current.filter(item => item.id !== record.id)]);
      attach(record);
      setHistoryOpen(false);
      requestedSessionRef.current = null;
      setRequestedSessionId(null);
      composerRef.current?.focus();
    }).catch(cause => {
      if (!cancelled) { requestedSessionRef.current = null; setError(cause instanceof Error ? cause.message : String(cause)); setRequestedSessionId(null); }
    });
    return () => { cancelled = true; };
  }, [attach, requestedSessionId, ready, setHistoryOpen]);

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
    if (!hasMessageContent(trimmed, pending.length, uploaded.length) || !session || sending || contextSaving || !health?.available) {
      return;
    }
    setSending(true);
    setError(null);
    setFailedUpload(null);
    let activeFile: File | null = null;
    try {
      // Files first, then the message that names them by their stored names — which may differ from
      // what the operator called them. A failed upload stops here with the text kept, so nothing is
      // sent that refers to a file the gateway does not have.
      const stored = [...uploaded];
      for (const file of pending) {
        activeFile = file;
        if (activeSessionId.current === session.id) setUploadingFile(file);
        const attachment = await uploadAttachment(session.id, file);
        activeFile = null;
        // Moved as each lands, not after all have: a failure part-way leaves the ones that made it
        // in `uploaded` and the rest still pending, so the retry sends exactly what is missing.
        stored.push(attachment);
        if (activeSessionId.current === session.id) {
          setUploaded((current) => [...current, attachment]);
          setPending((current) => current.filter((candidate) => candidate !== file));
        }
      }
      if (activeSessionId.current === session.id) setUploadingFile(null);
      await postMessage(session.id, trimmed, stored.map((attachment) => attachment.name), session.appContextRevision ?? 0, withoutAppDetails);
      // Clear only after acceptance, and never overwrite another session opened during the request.
      clearDraft(session.id);
      if (activeSessionId.current !== session.id) return;
      setContextUnavailable(false);
      setWithoutAppDetails(false);
      setUploaded([]);
      setPending([]);
      setInput("");
      // The gateway names an unnamed session from its first message, so the record the list holds is
      // stale the moment that message lands. Re-read rather than deriving the same title here: two
      // implementations of one rule drift, and the server's is the one that is stored.
      if (!session.title) {
        const named = await getSession(session.id).catch(() => null);
        if (named?.title) {
          setSession(current => current?.id === named.id && (current.appContextRevision ?? 0) <= (named.appContextRevision ?? 0) ? named : current);
          setSessions((current) => current.map((record) => (record.id === named.id ? named : record)));
        }
      }
    } catch (cause) {
      if (activeSessionId.current !== session.id) return;
      setFailedUpload(activeFile);
      if (cause instanceof AssistantApiError && cause.code === "app_context_unavailable") setContextUnavailable(true);
      if (cause instanceof AssistantApiError && cause.code === "app_context_conflict") {
        const current = await getSession(session.id).catch(() => null);
        if (current) setSession(previous => previous?.id === current.id && (previous.appContextRevision ?? 0) <= (current.appContextRevision ?? 0) ? current : previous);
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (activeSessionId.current === session.id) setUploadingFile(null);
      setSending(false);
    }
  }, [input, pending, sending, contextSaving, session, uploaded, withoutAppDetails, health?.available]);

  // Deletion clears the active conversation without creating or selecting another one.
  const detachDeleted = useCallback((sessionId: string) => {
    if (activeSessionId.current !== sessionId) return;
    streamAbortRef.current?.abort();
    activeSessionId.current = null;
    setSession(null);
    setStatus("idle");
    setEvents([]);
    setStreamed("");
    setInput("");
    setPending([]);
    setUploaded([]);
    setUploadingFile(null);
    setFailedUpload(null);
    setContextUnavailable(false);
    setWithoutAppDetails(false);
    setHistoryOpen(true);
    try {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // An obsolete stored id is harmless: reattachment resolves it through the API.
    }
  }, [setHistoryOpen]);

  const remove = useCallback(async (sessionId: string) => {
    setError(null);
    // The deletion event can arrive before its HTTP response.
    selfDeleted.current.add(sessionId);
    try {
      await deleteSession(sessionId);
      clearDraft(sessionId);
      setSessions(current => current.filter(entry => entry.id !== sessionId));
      detachDeleted(sessionId);
    } catch (cause) {
      selfDeleted.current.delete(sessionId);
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  }, [detachDeleted]);

  useEffect(() => {
    if (!deletedElsewhere) return;
    setDeletedElsewhere(null);
    setSessions(current => current.filter(entry => entry.id !== deletedElsewhere));
    clearDraft(deletedElsewhere);
    if (activeSessionId.current === deletedElsewhere) {
      detachDeleted(deletedElsewhere);
      setError("This session was deleted in another window. Choose a session or start a new one.");
    }
  }, [deletedElsewhere, detachDeleted]);

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
      await resolveApproval(session.id, approvalId, decision, message);
    },
    [session],
  );

  const answer = useCallback(
    async (questionId: string, answers: Record<string, string>) => {
      if (!session) {
        return;
      }
      await resolveQuestion(session.id, questionId, answers);
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

  // Which message each uploaded file belongs to, so a claimed file is drawn under its message and
  // nowhere else.
  const attachmentIndex = useMemo(() => indexAttachments(events), [events]);
  const items = useMemo(() => transcriptItems(events, attachmentIndex.claimed), [events, attachmentIndex]);

  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        {showSessions ? (
          <>
            {session && <Button variant="ghost" size="icon-sm" aria-label="Back to conversation" title="Back to conversation" onClick={() => setHistoryOpen(false)}><ArrowLeft /></Button>}
            <h1 className="min-w-0 flex-1 truncate text-sm font-medium">Session history</h1>
            <Button variant="ghost" size="sm" disabled={!ready} onClick={() => void startNew()}><MessageSquarePlus data-icon="inline-start" />New session</Button>
          </>
        ) : (
          <>
            <Sparkles className="hosty-shell-chrome h-4 w-4 shrink-0" aria-hidden />
            <span className="hosty-shell-chrome text-sm font-medium">Assistant</span>
            <StatusBadge value={status} />
            <div className="ml-auto flex items-center gap-1">
              {session && status !== "cancelled" && <Button size="sm" variant="ghost" disabled={sending} onClick={() => void stopSession(session.id).catch(cause => setError(cause.message))}>Stop</Button>}
              <Button variant="ghost" size="icon-sm" title="Session history" aria-label="Session history" disabled={!ready} onClick={() => {
                setHistoryOpen(true);
                void listSessions().then(setSessions).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
              }}><History /></Button>
              <Button variant="ghost" size="icon-sm" title="New session" aria-label="New session" disabled={!ready} onClick={() => void startNew()}><MessageSquarePlus /></Button>
            </div>
          </>
        )}
      </header>
      {!showSessions && session && session.providerLocked !== undefined && <SessionProvider key={`${session.id}:${session.connectionId}:${session.connectionRevision}`} session={session} busy={sending} onChange={record => {
        setSession(current => current?.id === record.id ? record : current);
        void getHealth(record.id).then(value => { if (activeSessionId.current === record.id) setHealth(value); }).catch(() => {});
      }} />}
      {error && <div className="shrink-0 p-3" role="alert"><InlineError message={error} /></div>}

      {showSessions ? (
        <SessionList
          sessions={orderSessions(sessions)}
          activeId={session?.id ?? null}
          onPick={(record) => {
            requestedSessionRef.current = record.id;
            setRequestedSessionId(record.id);
          }}
          onRename={rename}
          onDelete={remove}
        />
      ) : (
        <>
          <MessageScrollerProvider key={session?.id ?? "connecting"} autoScroll>
            <MessageScroller className="h-auto flex-1">
              <MessageScrollerViewport aria-label="Assistant conversation">
                <MessageScrollerContent className="gap-3 p-3" aria-busy={Boolean(streamed)}>

                  {health && !health.available && (
                    <MessageScrollerItem messageId="unavailable"><Alert severity="warning" title="Assistant unavailable" detail={health.reason} /></MessageScrollerItem>
                  )}
                  {ready && health?.available && events.length === 0 && !streamed && (
                    <MessageScrollerItem messageId="welcome"><p className="px-1 text-xs text-muted-foreground">
                      Operator session on this host — every write asks first.
                    </p></MessageScrollerItem>
                  )}

                  {items.map((item) => item.kind === "activity" ? (
                    <MessageScrollerItem key={item.key} messageId={item.key}>
                      <ToolActivity events={item.events} appNames={appNames} />
                    </MessageScrollerItem>
                  ) : (
                    <MessageScrollerItem key={item.key} messageId={item.key}>
                    <TranscriptEvent
                      event={item.event}
                      appNames={appNames}
                      attachments={attachmentIndex}
                      decision={item.event.type === "approval_request" ? decidedApprovals.get(String(item.event.approvalId)) ?? null : null}
                      answers={item.event.type === "question_request" ? answeredQuestions.get(String(item.event.questionId)) ?? null : null}
                      // Absent reads as "cannot": a reason box on a harness whose decline carries nothing
                      // would promise delivery the gateway then refuses.
                      denyReason={health?.capabilities?.denyReason === true}
                      onDecide={decide}
                      onAnswer={answer}
                    />
                    </MessageScrollerItem>
                  ))}
                  {streamed && (
                    // Formatted while it streams, not once it lands: the parser closes an unfinished block
                    // at the end of what has arrived, so a half-written table is a table with fewer rows
                    // rather than a paragraph of pipes that reflows the moment the turn ends.
                    <MessageScrollerItem messageId="streaming">
                    <div className="rounded-lg bg-muted/60 px-3 py-2">
                      <Markdown text={streamed} streaming />
                      <Loader2 className="ml-1 inline h-3 w-3 animate-spin text-muted-foreground" aria-hidden />
                    </div>
                    </MessageScrollerItem>
                  )}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton aria-label="Jump to latest message" />
            </MessageScroller>
          </MessageScrollerProvider>

          {contextUnavailable && (
            <label className="flex gap-2 px-3 py-2 text-xs">
              <input type="checkbox" checked={withoutAppDetails} onChange={event => setWithoutAppDetails(event.target.checked)} />
              Send without fresh app details for this message
            </label>
          )}
          <form
            className="shrink-0 p-3" aria-label="Message composer"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <InputGroup aria-label="Message and context">
              <InputGroupTextarea
                ref={composerRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onPaste={(event) => {
                  // Leave native paste intact for every text flavor, including HTML-only clipboards.
                  const images = takePastedImages(event.clipboardData);
                  if (images.length === 0) return;
                  setPending((current) => [...current, ...images]);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                    event.preventDefault();
                    void send();
                  }
                }}
                rows={2}
                aria-label="Message"
                placeholder={session ? "Ask the operator assistant…" : "Waiting for the gateway…"}
                disabled={!session || sending}
                className="max-h-48 min-h-20 w-full px-3"
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
              <InputGroupAddon align="block-end" className="flex-col items-stretch gap-2" onClick={() => {}}>
                {(pending.length > 0 || uploaded.length > 0) && (
                  <div className="flex max-h-48 shrink-0 flex-col gap-2 overflow-y-auto pb-2" aria-label="Attachments to send">
                    {uploaded.map((attachment) => (
                      <ChatAttachment key={`stored-${attachment.name}`} name={attachment.name} size={attachment.size}
                        description="Uploaded · ready to send" />
                    ))}
                    {pending.map((file, index) => (
                      <ChatAttachment key={`${file.name}-${index}`} name={file.name} size={file.size} file={file}
                        state={uploadingFile === file ? "uploading" : failedUpload === file ? "error" : "idle"}
                        description={uploadingFile === file ? "Uploading…" : failedUpload === file ? "Upload failed · send to retry" : "Ready to upload"}
                        disabled={sending}
                        onRemove={() => setPending(current => current.filter((_, i) => i !== index))} />
                    ))}
                  </div>
                )}
                <div className="flex items-end gap-2" role="group" aria-label="Message actions">
                  <div className="flex min-w-0 flex-1 items-start gap-1">
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
                    {session && (
                      <AppContextPicker key={session.id} session={session} busy={sending} onBusyChange={setContextSaving} running={["running", "awaiting_approval", "awaiting_question"].includes(status)}
                        onChange={record => setSession(current => current?.id === record.id && (record.appContextRevision ?? 0) >= (current.appContextRevision ?? 0) ? record : current)} />
                    )}
                  </div>
                  <Button type="submit" size="icon" className="shrink-0" disabled={!session || sending || contextSaving || !health?.available || !hasMessageContent(input, pending.length, uploaded.length)} aria-label="Send">
                    {sending ? <Loader2 className="animate-spin" /> : <Send />}
                  </Button>
                </div>
              </InputGroupAddon>
            </InputGroup>
          </form>
        </>
      )}
    </div>
  );
}
