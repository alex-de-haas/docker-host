"use client";
import { HostyNavigationBoundary } from "@hosty-sdk/app/react";
import { SessionAutonomy } from "@/components/session-autonomy";
import { useHostyUi } from "@hosty-sdk/app/ui/react";
import { AssistantActivity } from "@/components/assistant-activity";
import type { SessionActivity } from "../../../src/harness/activity";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SpeechInput } from "@/components/speech-input";
import { SessionCredentials } from "@/components/session-credentials";
import { SessionSandboxes } from "@/components/session-sandboxes";
import { SessionWorkspaces } from "@/components/session-workspaces";
import { SessionProvider } from "@/components/session-provider";
import { AppMentionInput, type AppMentionInputHandle } from "@/components/app-mention-input";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { AppContextPicker, type AppContextPickerHandle } from "@/components/app-context-picker";
import { ArrowLeft, History, Loader2, MessageSquarePlus, Paperclip, Plus, Blocks, Send, Sparkles, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, InlineError, StatusBadge } from "@/components/status";
import { Markdown } from "@/components/markdown";
import { ChatAttachment } from "@/components/chat-attachment";
import {
  MessageScroller, MessageScrollerButton, MessageScrollerContent,
  MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { transcriptItems } from "@/lib/transcript-items";
import { InputGroup, InputGroupAddon } from "@/components/ui/input-group";
import { DevelopmentNavigation } from "@/components/development-navigation";
import { CreateApp } from "@/components/create-app";
import { SessionRetention } from "@/components/session-retention";
import { WorkspaceDetails } from "@/components/workspace-details";
import { orderWorkspaces, useDevelopmentInventory } from "@/lib/development-api";
import { SessionList } from "@/components/session-list";
import { hasMessageContent, indexAttachments, takeChosenFiles, takePastedImages } from "@/lib/attachments";
import { approvalDecisions, cancelledQuestions, ToolActivity, TranscriptEvent } from "@/components/transcript";
import { retryHandoff } from "@/lib/assistant-api";
import { composeAskDraft } from "@/lib/ask-draft";
import { clearDraft, pruneDrafts, readDraft, writeDraft, readDraftAttachments, writeDraftAttachments } from "@/lib/draft-store";
import { useSessionListRefresh } from "@/lib/use-session-list-refresh";
import { activityTime, orderSessions, publishAttention, waitingCount } from "@/lib/attention";
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
  type StreamConnection,
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


export function AssistantConversation({ fullPage = false }: { fullPage?: boolean }) {
  const ui = useHostyUi();
  const [health, setHealth] = useState<HarnessHealth | null>(null);
  const [sessions, setSessions] = useState<AssistantSession[]>([]);
  // Hold an embedder's session request until authentication finishes. Resolve it directly through
  // the API: a session Shell just created may not appear in this tab's initial list.
  const requestedSessionRef = useRef<string | null>(null);
  const requestedDraftRef = useRef<{ sessionId: string; text: string; sourceAppId: string } | null>(null);
  const [requestedSessionId, setRequestedSessionId] = useState<string | null>(null);
  // Retain the expected message-selected session even if fetching it fails.
  const [surfaceSessionId, setSurfaceSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<AssistantSession | null>(null);
  useEffect(() => {
    const route = new URL(window.location.href);
    const expected = route.searchParams.get("session");
    if (!session?.id || (expected && session.id !== expected)
      || (surfaceSessionId && session.id !== surfaceSessionId)) return;
    for (const key of ["hosty_launch", "hosty_theme", "hosty_theme_preference"]) route.searchParams.delete(key);
    ui.reportSurfaceState({ route: `${route.pathname}${route.search}${route.hash}`, state: "ready" });
  }, [ui, session?.id, surfaceSessionId]);
  const [status, setStatus] = useState("idle");
  const [activity, setActivity] = useState<SessionActivity | null>(null);
  const [connection, setConnection] = useState<StreamConnection>("connecting");
  const [events, setEvents] = useState<AssistantEvent[]>([]);
  const [streamed, setStreamed] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [stoppingSession, setStoppingSession] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const [providerSaving, setProviderSaving] = useState(false);
  const providerSavingRef = useRef(false);
  const onProviderSaving = useCallback((saving: boolean) => {
    providerSavingRef.current = saving;
    setProviderSaving(saving);
  }, []);
  const stoppingRef = useRef<string | null>(null);
  const running = ["running", "awaiting_approval", "awaiting_question"].includes(status);
  const stopping = session?.id === stoppingSession;
  const [contextSaving, setContextSaving] = useState(false);
  const [mentionSaving, setMentionSaving] = useState(false);
  const mentionSavingRef = useRef(false);
  const onMentionSaving = useCallback((busy: boolean) => { mentionSavingRef.current = busy; setMentionSaving(busy); }, []);
  const contextPickerRef = useRef<AppContextPickerHandle>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const openContextAfterMenu = useRef(false);
  const onSessionChange = useCallback((record: AssistantSession) => {
    const merge = (current: AssistantSession) => current.id !== record.id ? current : {
      ...((record.appContextRevision ?? 0) >= (current.appContextRevision ?? 0) && activityTime(record) >= activityTime(current) ? record : current),
      updatedAt: activityTime(record) >= activityTime(current) ? record.updatedAt : current.updatedAt,
    };
    setSession(current => current ? merge(current) : current);
    setSessions(current => current.map(merge));
  }, []);
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
  const [historyOpen, setShowSessions] = useState(false);
  const showSessions = !fullPage && historyOpen;
  const setHistoryOpen = useCallback((open: boolean) => {
    setShowSessions(open);
    try {
      window.localStorage.setItem(HISTORY_STORAGE_KEY, String(open));
    } catch {
      // Storage refusal only prevents restoring the current view after a reload.
    }
  }, []);
  const [ready, setReady] = useState(false);
  const inventory = useDevelopmentInventory(fullPage && ready);
  useSessionListRefresh(fullPage && ready, sessions, session?.id, setSessions);
  const [tab, setTab] = useState("sessions");
  const [externalId, setExternalId] = useState("");
  const [mobileDetails, setMobileDetails] = useState(false);
  const [mobileSessions, setMobileSessions] = useState(false);
  const workspace = inventory.workspaces.find(w => w.owner.kind === "assistant" && w.owner.appId === "hosty.harness" && w.owner.reference === session?.id && w.workflow.state !== "deleted");
  const external = orderWorkspaces(inventory.workspaces.filter(w => w.owner.kind === "external" && w.workflow.state !== "deleted"));
  const selectedExternal = external.find(w => w.id === externalId) ?? external[0];
  if (selectedExternal && externalId !== selectedExternal.id) setExternalId(selectedExternal.id);
  const activeSessionId = useRef<string | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  // Reach the current deletion handler from the stream without stale state.
  const deletedSessionRef = useRef<(sessionId: string, local: boolean) => void>(() => {});
  // A terminal stream event can confirm a local deletion before its HTTP response arrives.
  const pendingDeletes = useRef(new Map<string, { confirmed: boolean }>());

  const mentionInputRef = useRef<AppMentionInputHandle>(null);
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
    setActivity(null);
    setConnection("connecting");
    setEvents([]);
    setStreamed("");
    // Whatever was left unsent in this session, put back in the box. Per session, so switching away
    // and back returns your own half-written sentence rather than someone else's.
    setInput(readDraft(record.id, record.handoffDraft?.text ?? ""));
    // Files are not a draft: a selection made for one session must not follow the operator into
    // the next and be uploaded there.
    setPending([]);
    setUploaded(readDraftAttachments(record.id) ?? record.handoffDraft?.attachments ?? []);
    setUploadingFile(null);
    setFailedUpload(null);
    try {
      window.localStorage.setItem(SESSION_STORAGE_KEY, record.id);
    } catch {
      // Private-mode storage refusal costs reattachment across reloads, nothing else.
    }

    const abort = new AbortController();
    let settingsRefresh = 0;
    streamAbortRef.current = abort;
    void streamEvents(
      record.id,
      (event) => {
        if (abort.signal.aborted) return;
        if (event.type === "session_activity") {
          const update = event as unknown as SessionActivity;
          setActivity(current => current?.epoch === update.epoch && current.revision >= update.revision ? current : update);
          return;
        }
        if (event.type === "session_provider_changed" || event.type === "session_autonomy_changed") {
          const settings: Partial<AssistantSession> = event.type === "session_autonomy_changed"
            ? (event.autonomy === "normal" || event.autonomy === "autonomous" ? { autonomy: event.autonomy } : {})
            : typeof event.connectionId === "string" && typeof event.connectionRevision === "number"
              && (event.harnessKind === "codex" || event.harnessKind === "claude") && typeof event.providerLocked === "boolean"
              ? { connectionId: event.connectionId, connectionRevision: event.connectionRevision, harnessKind: event.harnessKind, providerLocked: event.providerLocked } : {};
          const applySettings = (current: AssistantSession) => current.id === record.id && activityTime({ updatedAt: event.ts }) >= activityTime(current)
            ? { ...current, ...settings, updatedAt: event.ts } : current;
          setSessions(current => current.map(applySettings));
          setSession(current => current ? applySettings(current) : current);
          const revision = ++settingsRefresh;
          void getSession(record.id).then(value => { if (!abort.signal.aborted && revision === settingsRefresh && activeSessionId.current === record.id) onSessionChange(value); }).catch(() => {});
          void getHealth(record.id).then(value => { if (activeSessionId.current === record.id) setHealth(value); }).catch(() => {});
          return;
        }
        if (event.type === "user_message") setSession(current => current?.id === record.id ? { ...current, ...(current.providerLocked !== undefined ? { providerLocked: true } : {}) } : current);
        if (event.type === "app_context_changed") {
          const revision = Number(event.appContextRevision);
          setSessions(current => current.map(item => item.id === record.id && revision > (item.appContextRevision ?? 0)
            ? { ...item, appIds: event.appIds as string[], appContextRevision: revision, updatedAt: activityTime({ updatedAt: event.ts }) > activityTime(item) ? event.ts : item.updatedAt } : item));
          setSession(current => current?.id === record.id && revision > (current.appContextRevision ?? 0)
            ? { ...current, appIds: event.appIds as string[], appContextRevision: revision, updatedAt: activityTime({ updatedAt: event.ts }) > activityTime(current) ? event.ts : current.updatedAt } : current);
        }
        if (event.type === "assistant_delta") {
          setStreamed((current) => current + String(event.text ?? ""));
          return;
        }
        if (event.type === "assistant_text") {
          setStreamed("");
        }
        if (event.type === "session_status") {
          // Cancellation closes earlier approval cards, including when replaying a stopped turn.
          if (event.status === "cancelled") setEvents(current => [...current, event]);
          const value = String(event.status ?? "idle");
          setStatus(value);
          setSessions(current => current.map(item => item.id === record.id ? { ...item, status: value, updatedAt: activityTime({ updatedAt: event.ts }) > activityTime(item) ? event.ts : item.updatedAt } : item));
          if (!["running", "awaiting_approval", "awaiting_question"].includes(String(event.status))) {
            setActivity(null);
            setStreamed("");
            // A recovered Docker stop can clear a previously unavailable generation without
            // changing the selected provider or session. Refresh from its terminal event.
            void getHealth(record.id).then(value => {
              if (!abort.signal.aborted && activeSessionId.current === record.id) setHealth(value);
            }).catch(() => {});
          }
          return;
        }
        if (event.type === "session_deleted") {
          const pending = pendingDeletes.current.get(record.id);
          if (pending) pending.confirmed = true;
          // Always detach immediately, even when this tab initiated the request. The HTTP response
          // may never arrive; a confirmed terminal event is already sufficient evidence of success.
          deletedSessionRef.current(record.id, !!pending);
          return;
        }
        setEvents((current) => [...current, event]);
      },
      abort.signal,
      (state) => {
        if (abort.signal.aborted) return;
        setConnection(state);
        if (state !== "connected") setActivity(null);
        if (state === "disconnected") setStreamed("");
      },
    );
  }, [onSessionChange]);

  // A full-page selection is also a navigation: Shell must restore that exact session on reload.
  const navigateSelection = useCallback(async (sessionId: string | null) => {
    if (!fullPage) return;
    const search = sessionId ? `?session=${encodeURIComponent(sessionId)}` : "";
    const entry = ui.getNavigation().entries.find(item => item.route?.split("?")[0] === "/development");
    if (entry) {
      const result = await ui.navigate(entry.key, { requestId: crypto.randomUUID(), placement: "main", search });
      if (result.status === "accepted") return;
    }
    const route = new URL(window.location.href);
    if (sessionId) route.searchParams.set("session", sessionId);
    else route.searchParams.delete("session");
    window.history.replaceState(window.history.state, "", route);
  }, [fullPage, ui]);
  const selectedRoute = useRef<string | null>(null);
  const pickSession = (record: AssistantSession) => {
    selectedRoute.current = fullPage ? record.id : null;
    requestedSessionRef.current = record.id;
    setSurfaceSessionId(null);
    setRequestedSessionId(record.id);
    setMobileSessions(false); setMobileDetails(false);
  };

  const startNew = useCallback(async () => {
    setError(null);
    try {
      const record = await createSession({});
      setSessions((current) => [record, ...current]);
      setHistoryOpen(false);
      attach(record);
      await navigateSelection(record.id);
      return record;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [attach, setHistoryOpen, navigateSelection]);

  // The session before the data, as on the settings page: a launch code that has not been spent yet
  // means every request below is answered 401 by a gateway that is working correctly.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const requested = new URLSearchParams(window.location.search).get("session");
        if (requested && /^[a-zA-Z0-9-]+$/.test(requested)) {
          requestedSessionRef.current = requested;
          setRequestedSessionId(requested);
        }
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
        | { type?: unknown; text?: unknown; sourceAppId?: unknown; sessionId?: unknown; draft?: unknown }
        | null;
      if (!data) {
        return;
      }

      if (data.type === "hosty:open-assistant-session" && typeof data.sessionId === "string") {
        // Shell can also hand off an error to a fresh session. Resolve the session through the
        // authenticated API before filling its draft; never submit this untrusted text.
        requestedDraftRef.current = typeof data.draft === "string" ? {
          sessionId: data.sessionId,
          text: data.draft.length > MAX_ASK_CHARS ? `${data.draft.slice(0, MAX_ASK_CHARS)}\n[Error truncated; use Copy in Shell for the full text.]` : data.draft,
          sourceAppId: typeof data.sourceAppId === "string" ? data.sourceAppId : "",
        } : null;
        requestedSessionRef.current = data.sessionId;
        setSurfaceSessionId(data.sessionId);
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
    const draft = requestedDraftRef.current;
    void getSession(requestedSessionId).then(async record => {
      if (cancelled) return;
      setSessions(current => [record, ...current.filter(item => item.id !== record.id)]);
      if (record.id !== requestedSessionId) throw new Error("The requested session is unavailable.");
      if (selectedRoute.current === record.id) {
        selectedRoute.current = null;
        await navigateSelection(record.id);
        if (cancelled) return;
      }
      attach(record);
      // A repeated delivery/reload must not append the same error or replace an operator's draft.
      if (draft?.sessionId === record.id && !readDraft(record.id)) {
        const text = composeAskDraft("", draft.text, draft.sourceAppId);
        writeDraft(record.id, text);
        setInput(text);
      }
      requestedDraftRef.current = null;
      setHistoryOpen(false);
      requestedSessionRef.current = null;
      setRequestedSessionId(null);
      composerRef.current?.focus();
    }).catch(cause => {
      if (!cancelled) { requestedSessionRef.current = null; setError(cause instanceof Error ? cause.message : String(cause)); setRequestedSessionId(null); }
    });
    return () => { cancelled = true; };
  }, [attach, requestedSessionId, ready, setHistoryOpen, navigateSelection]);

  // Written on change rather than on unload: a closed laptop, a crashed tab and a navigation away all
  // skip unload handlers, and those are exactly the cases where the text matters most.
  useEffect(() => {
    if (session) {
      writeDraft(session.id, input);
    }
  }, [input, session]);

  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (session && event.key === `hosty.assistant.draft.${session.id}`) setInput(event.newValue ?? "");
      if (session && event.key === `hosty.assistant.attachments.${session.id}`) setUploaded(readDraftAttachments(session.id) ?? []);
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [session]);

  // Overlay live status while retaining stream updates for previously selected sessions.
  const listedSessions = useMemo(
    () => session ? sessions.map(record => record.id === session.id && record.status !== status ? { ...record, status } : record) : sessions,
    [sessions, session, status],
  );

  useEffect(() => {
    publishAttention(waitingCount(listedSessions));
  }, [listedSessions]);

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
    const trimmed = (mentionInputRef.current?.serialize() ?? input).trim();
    if (!hasMessageContent(trimmed, pending.length, uploaded.length) || !session || sendingRef.current || providerSavingRef.current || stoppingRef.current === session.id || running || contextSaving || mentionSavingRef.current || !health?.available) {
      return;
    }
    sendingRef.current = true;
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
      // Lock the composer before the HTTP response: SSE may confirm (or finish) the turn first.
      if (activeSessionId.current === session.id) setStatus("running");
      await postMessage(session.id, trimmed, stored.map((attachment) => attachment.name), session.appContextRevision ?? 0, withoutAppDetails);
      // Clear only after acceptance, and never overwrite another session opened during the request.
      clearDraft(session.id);
      setSessions(current => current.map(item => item.id === session.id ? { ...item, handoffDraft: undefined } : item));
      setSession(current => current?.id === session.id ? { ...current, handoffDraft: undefined } : current);
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
          onSessionChange(named);
        }
      }
    } catch (cause) {
      if (activeSessionId.current !== session.id) return;
      setFailedUpload(activeFile);
      if (cause instanceof AssistantApiError && cause.code === "app_context_unavailable") setContextUnavailable(true);
      if (cause instanceof AssistantApiError && cause.code === "app_context_conflict") {
        const current = await getSession(session.id).catch(() => null);
        if (current) onSessionChange(current);
      }
      setError(cause instanceof Error ? cause.message : String(cause));
      const current = await getSession(session.id).catch(() => null);
      if (activeSessionId.current === session.id) setStatus(current?.status ?? status);
    } finally {
      if (activeSessionId.current === session.id) setUploadingFile(null);
      sendingRef.current = false;
      setSending(false);
    }
  }, [input, pending, running, status, contextSaving, session, uploaded, withoutAppDetails, health?.available, onSessionChange]);

  const stop = useCallback(async () => {
    if (!session || !running || sendingRef.current || providerSavingRef.current || stoppingRef.current) return;
    const id = session.id;
    stoppingRef.current = id;
    setStoppingSession(id);
    setError(null);
    try {
      await stopSession(id);
    } catch (cause) {
      if (activeSessionId.current === id) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      stoppingRef.current = null;
      setStoppingSession(null);
    }
  }, [session, running]);

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
    requestedSessionRef.current = null;
    selectedRoute.current = null;
    setRequestedSessionId(null);
    setSurfaceSessionId(null);
    setMobileDetails(false);
    setHistoryOpen(!fullPage);
    void navigateSelection(null).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
    try {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // An obsolete stored id is harmless: reattachment resolves it through the API.
    }
  }, [setHistoryOpen, fullPage, navigateSelection]);

  const remove = useCallback(async (sessionId: string) => {
    setError(null);
    // The deletion event can arrive before its HTTP response.
    const pending = { confirmed: false };
    pendingDeletes.current.set(sessionId, pending);
    try {
      await deleteSession(sessionId);
    } catch (cause) {
      if (!pending.confirmed) {
        // Other navigation rows have no active stream. Reconcile a lost response against the
        // authenticated inventory, preserving local state if deletion cannot be established.
        const observed = await listSessions().catch(() => null);
        if (!pending.confirmed && (!observed || observed.some(entry => entry.id === sessionId))) {
          setError(cause instanceof Error ? cause.message : String(cause));
          throw cause;
        }
      }
    } finally {
      pendingDeletes.current.delete(sessionId);
    }
    clearDraft(sessionId);
    setSessions(current => current.filter(entry => entry.id !== sessionId));
    detachDeleted(sessionId);
  }, [detachDeleted]);

  useEffect(() => {
    deletedSessionRef.current = (sessionId: string, local: boolean) => {
      setSessions(current => current.filter(entry => entry.id !== sessionId));
      clearDraft(sessionId);
      if (activeSessionId.current === sessionId) {
        detachDeleted(sessionId);
        if (!local) setError("This session was deleted in another window. Choose a session or start a new one.");
      }
    };
  }, [detachDeleted]);

  const rename = useCallback(async (sessionId: string, title: string) => {
    setError(null);
    try {
      const record = await renameSession(sessionId, title);
      onSessionChange(record);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [onSessionChange]);

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

  const decidedApprovals = useMemo(() => approvalDecisions(events), [events]);
  const cancelledQuestionIds = useMemo(() => cancelledQuestions(events), [events]);

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
    <div className="flex h-dvh min-h-0 min-w-0 flex-col">
      {fullPage && <header className="flex flex-wrap shrink-0 items-center gap-1 border-b px-3 py-2">
        <Button size="sm" variant={tab === "sessions" ? "secondary" : "ghost"} onClick={() => setTab("sessions")}>Sessions</Button>
        <Button size="sm" variant={tab === "external" ? "secondary" : "ghost"} onClick={() => setTab("external")}>External workspaces</Button>
        {tab === "sessions" && <Button className="ml-auto md:hidden" size="sm" variant="ghost" onClick={() => { setMobileSessions(v => !v); setMobileDetails(false); }}>Session list</Button>}
        {tab === "sessions" && workspace && <Button className="min-[900px]:hidden" size="sm" variant="outline" onClick={() => { setMobileDetails(v => !v); setMobileSessions(false); }}>Workspace details</Button>}
      </header>}
      {fullPage && inventory.error && <p role="alert" className="border-b px-4 py-2 text-sm text-destructive">{inventory.error}</p>}
      {fullPage && tab === "external" && <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto md:grid-cols-[260px_1fr]">
        <nav aria-label="External workspaces" className="border-r p-2">{external.map(w => <button key={w.id} type="button" aria-current={selectedExternal?.id === w.id ? "page" : undefined} onClick={() => setExternalId(w.id)} className={`block w-full rounded p-3 text-left text-sm hover:bg-muted ${selectedExternal?.id === w.id ? "bg-muted" : ""}`}>{w.owner.label}<span className="block truncate text-xs text-muted-foreground">{w.owner.reference}</span></button>)}{!external.length && <p className="p-3 text-sm text-muted-foreground">No external workspaces available.</p>}</nav>
        {selectedExternal && <WorkspaceDetails key={selectedExternal.id} workspace={selectedExternal} title={selectedExternal.owner.label} refresh={inventory.refresh} />}
      </div>}
      <div className={`${fullPage && tab !== "sessions" ? "hidden" : "flex"} min-h-0 flex-1`}>
      {fullPage && <div className={`${mobileSessions ? "block" : "hidden"} w-full shrink-0 border-r md:block md:w-52`}><DevelopmentNavigation sessions={listedSessions} activeId={session?.id} workspaces={inventory.workspaces}
        onNew={() => { setMobileSessions(false); void startNew(); }} onPick={pickSession} onDelete={remove} /></div>}
      <main className={`${fullPage && mobileDetails && workspace ? "hidden min-[900px]:flex" : fullPage && mobileSessions ? "hidden md:flex" : "flex"} min-h-0 min-w-0 flex-1 flex-col`}>

      <header className="flex flex-wrap shrink-0 items-center gap-2 border-b px-3 py-2">
        {showSessions ? (
          <>
            {session && <Button variant="ghost" size="icon-sm" aria-label="Back to conversation" title="Back to conversation" onClick={() => setHistoryOpen(false)}><ArrowLeft /></Button>}
            <h1 className="min-w-0 flex-1 truncate text-sm font-medium">Session history</h1>
            <Button variant="ghost" size="sm" disabled={!ready} onClick={() => void startNew()}><MessageSquarePlus data-icon="inline-start" />New session</Button>
          </>
        ) : (
          <>
            {fullPage ? <h1 className="min-w-0 truncate text-sm font-medium">{session?.title || "New session"}</h1> : <HostyNavigationBoundary><Sparkles className="h-4 w-4 shrink-0" aria-hidden /><span className="text-sm font-medium">Assistant</span></HostyNavigationBoundary>}
            <StatusBadge value={status} />
            {session && (
              <AppContextPicker key={session.id} ref={contextPickerRef} opener={addButtonRef} compact side="bottom" session={session} busy={sending || mentionSaving || providerSaving} onBusyChange={setContextSaving} running={running}
                onChange={onSessionChange} />
            )}
            {!fullPage && <div className="ml-auto flex items-center gap-1">
              <Button variant="ghost" size="sm" disabled={!session || sending} onClick={async () => {
                if (!session || sendingRef.current) return;
                sendingRef.current = true; setSending(true); setError(null);
                try {
                  writeDraft(session.id, input);
                  const stored = [...uploaded];
                  for (const file of pending) {
                    const attachment = await uploadAttachment(session.id, file);
                    stored.push(attachment);
                    setUploaded(current => [...current, attachment]);
                    setPending(current => current.filter(candidate => candidate !== file));
                  }
                  if (!writeDraftAttachments(session.id, stored)) throw new Error("Browser storage is unavailable. Your draft and attachments remain in this panel.");
                  localStorage.setItem(SESSION_STORAGE_KEY, session.id);
                  const entry = ui.getNavigation().entries.find(e => e.route === "/development");
                  if (entry) { const result = await ui.navigate(entry.key, { requestId: crypto.randomUUID(), placement: "main", search: `?session=${encodeURIComponent(session.id)}` }); if (result.status === "accepted") return; }
                  window.open(`/development?session=${encodeURIComponent(session.id)}`, "_blank", "noopener");
                } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
                finally { sendingRef.current = false; setSending(false); }
              }}>Open in Harness</Button>
              <Button variant="ghost" size="icon-sm" title="Manage sessions" aria-label="Session history" disabled={!ready} onClick={() => {
                setHistoryOpen(true);
                void listSessions().then(setSessions).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
              }}><History /></Button>
              <Button variant="ghost" size="icon-sm" title="New session" aria-label="New session" disabled={!ready} onClick={() => void startNew()}><MessageSquarePlus /></Button>
            </div>}
          </>
        )}
      </header>
      {session && !showSessions && <CreateApp key={`creation-${session.id}`} session={session} busy={running || sending || stopping || providerSaving} onChange={record => { onSessionChange(record); void inventory.refresh(); }} />}
      {session && !showSessions && <SessionRetention sessionId={session.id} revision={`${status}:${workspace?.workflow.revision ?? ""}`} />}

      {!showSessions && session && <SessionCredentials key={`credentials-${session.id}`} sessionId={session.id} />}
      {!fullPage && !showSessions && session && <SessionSandboxes key={`sandbox-${session.id}`} sessionId={session.id} />}
      {!fullPage && !showSessions && session && <SessionWorkspaces key={`workspaces-${session.id}`} session={session} running={running} />}
      {error && <div className="shrink-0 p-3" role="alert"><InlineError message={error} /></div>}

      {showSessions ? (
        <SessionList
          sessions={orderSessions(listedSessions)}
          activeId={session?.id ?? null}
          onPick={pickSession}
          onRename={rename}
          onDelete={remove}
        />
      ) : (
        <>
          <MessageScrollerProvider key={session?.id ?? "connecting"} autoScroll>
            <MessageScroller className="h-auto flex-1">
              <MessageScrollerViewport aria-label="Assistant conversation">
                <MessageScrollerContent className="gap-3 p-3">

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
                      questionCancelled={item.event.type === "question_request" && cancelledQuestionIds.has(String(item.event.questionId))}
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
                    </div>
                    </MessageScrollerItem>
                  )}
                  {(running || stopping) && connection !== "disconnected" && <MessageScrollerItem messageId="current-activity">
                    <AssistantActivity status={status} activity={activity?.activity ?? null}
                      connection={connection} stopping={stopping} appNames={appNames} />
                  </MessageScrollerItem>}
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
            {session?.handoffDispatch && ["queued", "unknown"].includes(session.handoffDispatch.state) &&
              <div role="status" className="text-sm text-muted-foreground">
                {session.handoffDispatch.error || (session.handoffDispatch.state === "queued"
                  ? "This request was accepted but has not started. Configure a provider if needed, then retry."
                  : "The previous execution outcome is unknown. Review the conversation before sending another message.")}
                {session.handoffDispatch.state === "queued" && <Button type="button" variant="outline" size="sm" disabled={sending}
                  onClick={() => { setSending(true); void retryHandoff(session.id).then(attach).catch(cause => setError(String(cause))).finally(() => setSending(false)); }}>Retry starting</Button>}
              </div>}
            <InputGroup aria-label="Message and context">
              <AppMentionInput
                ref={mentionInputRef}
                key={session?.id ?? "empty"}
                inputRef={composerRef}
                session={session}
                contextBusy={contextSaving || sending || providerSaving}
                onContextChange={onSessionChange}
                onBusyChange={onMentionSaving}
                value={input}
                onChange={setInput}
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
              <InputGroupAddon align="block-end" className="flex-col items-stretch gap-2">
                {(pending.length > 0 || uploaded.length > 0) && (
                  <div className="flex max-h-48 shrink-0 flex-col gap-2 overflow-y-auto pb-2" aria-label="Attachments to send">
                    {uploaded.map((attachment) => (
                      <ChatAttachment key={`stored-${attachment.name}`} name={attachment.name} size={attachment.size}
                        description="Uploaded · ready to send" disabled={sending} onRemove={() => {
                          const remaining = uploaded.filter(item => item.name !== attachment.name);
                          setUploaded(remaining);
                          if (session) writeDraftAttachments(session.id, remaining);
                        }} />
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
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button ref={addButtonRef} type="button" size="icon" variant="ghost" disabled={!session || sending || mentionSaving || providerSaving} aria-label="Add to message"><Plus /></Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent side="top" align="start" onCloseAutoFocus={event => {
                        if (openContextAfterMenu.current) {
                          event.preventDefault(); openContextAfterMenu.current = false;
                          contextPickerRef.current?.open();
                        }
                      }}>
                        <DropdownMenuGroup>
                          <DropdownMenuItem disabled={contextSaving} onSelect={() => { openContextAfterMenu.current = true; }}><Blocks />Add app context</DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}><Paperclip />Attach files</DropdownMenuItem>
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {session && <SessionAutonomy key={session.id} session={{ ...session, status }} busy={sending || stopping || mentionSaving || contextSaving || providerSaving}
                      onSavingChange={onProviderSaving} onChange={onSessionChange} />}
                    {session && session.providerLocked !== undefined && <SessionProvider key={`${session.id}:${session.connectionId}:${session.connectionRevision}`} session={session} busy={sending || mentionSaving || contextSaving || providerSaving} onSavingChange={onProviderSaving} onChange={record => {
                      onSessionChange(record);
                      void getHealth(record.id).then(value => { if (activeSessionId.current === record.id) setHealth(value); }).catch(() => {});
                    }} />}
                  </div>
                  {session && <SpeechInput key={session.id} disabled={sending} onText={text => setInput(current => current ? `${current}${/\s$/.test(current) ? "" : " "}${text}` : text)} />}
                  {running || stopping ? (
                    <Button type="button" size="icon" className="shrink-0" disabled={sending || stopping} onClick={() => void stop()} aria-label="Stop" title="Stop response">
                      {sending || stopping ? <Loader2 className="animate-spin" /> : <Square className="fill-current" />}
                    </Button>
                  ) : (
                    <Button type="submit" size="icon" className="shrink-0" disabled={!session || sending || providerSaving || contextSaving || mentionSaving || !health?.available || !hasMessageContent(input, pending.length, uploaded.length)} aria-label="Send">
                      {sending ? <Loader2 className="animate-spin" /> : <Send />}
                    </Button>
                  )}
                </div>
              </InputGroupAddon>
            </InputGroup>
          </form>
        </>
      )}
      </main>
      {fullPage && workspace && <div className={`${mobileDetails ? "block flex-1" : "hidden"} min-h-0 min-w-0 border-l min-[900px]:block min-[900px]:w-72 min-[900px]:flex-none 2xl:w-96`}>
        <WorkspaceDetails key={workspace.id} workspace={workspace} title={session?.title || "Workspace"} sessionId={session?.id} running={running} refresh={inventory.refresh} deleteConversation={session ? () => remove(session.id) : undefined} />
      </div>}
      </div>
    </div>
  );
}
