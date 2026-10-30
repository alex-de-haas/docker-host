"use client";
import { ProviderUsageIndicator } from "@/components/provider-usage";
import { ContextUsageIndicator } from "@/components/context-usage";
import { applyContextUsage, emptyContextUsage } from "@/lib/context-usage";
import { HostyNavigationBoundary } from "@hosty-sdk/app/react";
import { SessionProfile } from "@/components/session-profile";
import { SessionModel } from "@/components/session-model";
import { SessionAutonomy } from "@/components/session-autonomy";
import { SessionExecutionIndicator } from "@/components/session-execution-indicator";
import { useHostyUi } from "@hosty-sdk/app/ui/react";
import { AssistantActivity } from "@/components/assistant-activity";
import type { SessionActivity } from "../../../src/harness/activity";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { SpeechInput } from "@/components/speech-input";
import { SessionCredentials } from "@/components/session-credentials";
import { SessionSandboxes } from "@/components/session-sandboxes";
import { SessionWorkspaces } from "@/components/session-workspaces";
import { SessionProvider } from "@/components/session-provider";
import { usePromptSuggestions } from "@/lib/prompt-suggestions";
import { PromptSuggestionCard } from "@/components/prompt-suggestion";
import { AppMentionInput, type AppMentionInputHandle } from "@/components/app-mention-input";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuCheckboxItem } from "@/components/ui/dropdown-menu";
import { AppContextPicker, type AppContextPickerHandle } from "@/components/app-context-picker";
import { ArrowLeft, History, Loader2, MessageSquarePlus, Paperclip, Plus, Blocks, Send, Sparkles, Square, PanelRight, Diamond, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, InlineError, StatusBadge } from "@/components/status";
import { Markdown } from "@/components/markdown";
import { ChatAttachment } from "@/components/chat-attachment";
import {
  MessageScroller, MessageScrollerButton, MessageScrollerContent,
  MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { transcriptItems } from "@/lib/transcript-items";
import { resolveTranscriptReview, type TranscriptReviewReference } from "@/lib/transcript-edits";
import { InputGroup, InputGroupAddon } from "@/components/ui/input-group";
import { WorkspaceSessionTabs } from "./workspace-session-tabs";
import { useWorkspaceSessionActions } from "@/lib/use-workspace-session-actions";
import { rememberWorkspaceSession, rememberedWorkspaceSession, workspaceSessionIds } from "@/lib/workspace-navigation";
import { DevelopmentNavigation } from "@/components/development-navigation";
import { CreateApp } from "@/components/create-app";
import { SessionRetention } from "@/components/session-retention";
import { RetainedWorkspacePane, useNarrowWorkspace } from "@/components/retained-workspace-pane";
import { WorkspaceReview, type ReviewChoice } from "@/components/workspace-review";
import type { DevelopmentWorkspace, Worktree } from "@/lib/development-api";
import { WorkspaceDetails } from "@/components/workspace-details";
import { useDevelopmentInventory, workflowIsActive } from "@/lib/development-api";
import { SessionList, SessionTitleInput } from "@/components/session-list";
import { hasMessageContent, indexAttachments, takeChosenFiles, takePastedImages } from "@/lib/attachments";
import { approvalDecisions, cancelledQuestions, ToolActivity, TranscriptEvent } from "@/components/transcript";
import { retryHandoff } from "@/lib/assistant-api";
import { composeAskDraft } from "@/lib/ask-draft";
import { clearDraft, draftStorageText, pruneDrafts, readDraft, writeDraft, readDraftAttachments, writeDraftAttachments } from "@/lib/draft-store";
import { dispatchPendingSend, forgetPendingSend, readPendingSend, claimPendingSend, PENDING_SEND_PREFIX, PENDING_SEND_CHANGED, withPendingSendLock, isMessageAdmissionRejection, retryPendingSend, type PendingSend } from "@/lib/pending-send";
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


export function AssistantConversation({ fullPage = false, navigation = "workspaces" }: { fullPage?: boolean; navigation?: "workspaces" | "chats" }) {
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
  const [contextUsage, setContextUsage] = useState(() => emptyContextUsage(""));
  const [activity, setActivity] = useState<SessionActivity | null>(null);
  const [connection, setConnection] = useState<StreamConnection>("connecting");
  const [events, setEvents] = useState<AssistantEvent[]>([]);
  const [streamed, setStreamed] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [stoppingSession, setStoppingSession] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(null);
  const [sendRecoveryBlocked, setSendRecoveryBlocked] = useState(false);
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
      ...((record.appContextRevision ?? 0) >= (current.appContextRevision ?? 0)
        && (record.selectionRevision ?? 0) >= (current.selectionRevision ?? 0) && activityTime(record) >= activityTime(current)
        && (record.lastEventSeq === undefined || current.lastEventSeq === undefined || record.lastEventSeq >= current.lastEventSeq) ? record : current),
      lastEventSeq: Math.max(record.lastEventSeq ?? 0, current.lastEventSeq ?? 0) || undefined,
      updatedAt: activityTime(record) >= activityTime(current) ? record.updatedAt : current.updatedAt,
      // Admission is permanent even if a pre-admission mutation reply arrives before its status event.
      ...(current.profileLocked === true ? { profileLocked: true } : {}),
      ...(current.providerLocked === true ? { providerLocked: true } : {}),
    };
    setSession(current => current ? merge(current) : current);
    setSessions(current => current.map(merge));
  }, []);
  const [contextUnavailable, setContextUnavailable] = useState(false);
  const [withoutAppDetails, setWithoutAppDetails] = useState(false);
  // Chosen but not yet sent. Uploaded only when the message goes, so a file picked and then
  // reconsidered never reaches the gateway.
  const [pending, setPending] = useState<File[]>([]);
  const pendingBySession = useRef(new Map<string, File[]>());
  useEffect(() => { if (session) pendingBySession.current.set(session.id, pending); }, [session, pending]);
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
  const sessionStorageKey = fullPage ? `hosty.harness.${navigation}.session` : SESSION_STORAGE_KEY;
  const navigationTitle = navigation === "workspaces" ? "Workspaces" : "Chats";
  const [openAppCreation, setOpenAppCreation] = useState(false);
  const setHistoryOpen = useCallback((open: boolean) => {
    setShowSessions(open);
    try {
      window.localStorage.setItem(HISTORY_STORAGE_KEY, String(open));
    } catch {
      // Storage refusal only prevents restoring the current view after a reload.
    }
  }, []);
  const [ready, setReady] = useState(false);
  const inventory = useDevelopmentInventory(ready);
  useSessionListRefresh(fullPage && ready, sessions, session?.id, setSessions);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [workspaceToResolve, setWorkspaceToResolve] = useState<string | null>(null);
  const [workspaceVisible, setWorkspaceVisible] = useState(true);
  const decisionCard = useRef<HTMLDivElement | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [mobileDetails, setMobileDetails] = useState(false);
  const narrowWorkspace = useNarrowWorkspace();
  const workspaceModal = narrowWorkspace && mobileDetails;
  const [mobileSessions, setMobileSessions] = useState(fullPage && !requestedSessionId);
  const [review, setReview] = useState<{ workspaceId: string; tree: Worktree; sessionId?: string; transcriptChoice?: ReviewChoice } | null>(null);
  const [reviewChoices, setReviewChoices] = useState<Record<string, ReviewChoice>>({});
  const reviewOpener = useRef<HTMLElement | null>(null);
  const conversationRef = useRef<HTMLElement | null>(null);
  const openReview = (workspaceId: string, tree: Worktree, sessionId?: string, choice?: ReviewChoice) => {
    reviewOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (choice) setReviewChoices(previous => ({ ...previous, [tree.id]: choice }));
    setReview({ workspaceId, tree, sessionId }); setMobileDetails(false);
  };
  const openTranscriptReview = (reference: TranscriptReviewReference) => {
    const target = resolveTranscriptReview(reference, session?.id, inventory.workspaces);
    if (!target) return;
    reviewOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setReview({ workspaceId: target.workspace.id, tree: target.tree, sessionId: session?.id,
      transcriptChoice: { view: "session", path: reference.path } });
    setMobileDetails(false);
  };
  const transcriptReviewContext = session ? { sessionId: session.id, workspaces: inventory.workspaces, onOpen: openTranscriptReview } : undefined;
  const closeReview = () => { if (review?.sessionId) setMobileSessions(false); setReview(null); requestAnimationFrame(() => {
    if (reviewOpener.current?.isConnected && reviewOpener.current.getClientRects().length) reviewOpener.current.focus();
    else (composerRef.current ?? conversationRef.current)?.focus();
  }); };
  const sessionWorkspace = inventory.workspaces.find(w => w.participation ? w.participation.sessions.some(binding => binding.attached && binding.canOpen && binding.sessionId === session?.id) : w.owner.kind === "assistant" && w.owner.appId === "hosty.harness" && w.owner.reference === session?.id);
  const selectedWorkspace = selectedWorkspaceId ? inventory.workspaces.find(w => w.id === selectedWorkspaceId) : sessionWorkspace;
  const workspace = selectedWorkspace?.workflow.state === "deleted" ? undefined : selectedWorkspace;
  const chatVisible = !fullPage || !selectedWorkspaceId || !!workspace && !!session && workspaceSessionIds(workspace).includes(session.id);
  useEffect(() => {
    if (workspace && session && chatVisible) rememberWorkspaceSession(workspace, session.id);
  }, [workspace, session, chatVisible]);
  const observedWorkspaceFence = !!sessionWorkspace && (!!sessionWorkspace.workflow.closure || ["completed", "deferred", "deleting", "deleted"].includes(sessionWorkspace.workflow.state));
  const observedWorkspaceActive = !!sessionWorkspace && workflowIsActive(sessionWorkspace.workflow);
  const workspaceSessionId = sessionWorkspace ? session?.id : undefined;
  const [fencedWorkspaceSessions, setFencedWorkspaceSessions] = useState<Set<string>>(() => new Set());
  if (workspaceSessionId && (observedWorkspaceFence || observedWorkspaceActive) && fencedWorkspaceSessions.has(workspaceSessionId) !== observedWorkspaceFence) {
    const next = new Set(fencedWorkspaceSessions);
    if (observedWorkspaceFence) next.add(workspaceSessionId); else next.delete(workspaceSessionId);
    setFencedWorkspaceSessions(next);
  }
  // A failed inventory read cannot reopen known closed source; only an observed active workflow can.
  const workspaceReadOnly = observedWorkspaceFence || (!observedWorkspaceActive && !!session && fencedWorkspaceSessions.has(session.id));
  const composerBlocked = workspaceReadOnly || inventory.loading;
  const composerBlockedRef = useRef(composerBlocked);
  useEffect(() => { composerBlockedRef.current = composerBlocked; }, [composerBlocked]);
  const activeSessionId = useRef<string | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  // Reach the current deletion handler from the stream without stale state.
  const deletedSessionRef = useRef<(sessionId: string, local: boolean) => void>(() => {});
  // A terminal stream event can confirm a local deletion before its HTTP response arrives.
  const pendingDeletes = useRef(new Map<string, { confirmed: boolean }>());

  const mentionInputRef = useRef<AppMentionInputHandle>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const suggestions = usePromptSuggestions(session, ready, !!input || pending.length > 0 || uploaded.length > 0);
  const suggestionsReceive = suggestions.receive;
  const visibleSuggestion = !running && !sending && !pendingSend && !contextSaving && !mentionSaving && !providerSaving
    && !composerBlocked && connection === "connected" ? suggestions.suggestion : null;
  const acceptSuggestion = () => {
    if (!visibleSuggestion || composerRef.current?.value) return;
    mentionInputRef.current?.insertPlainText(visibleSuggestion.text!);
    suggestions.interact();
  };

  /** Attaches to one session and follows its log. Shared by reattach, switch and new. */
  const attach = useCallback((record: AssistantSession) => {
    if (activeSessionId.current !== record.id) setReview(null);
    streamAbortRef.current?.abort();
    activeSessionId.current = record.id;
    setContextUsage(emptyContextUsage(record.id));
    setSession(record);
    setHealth(null);
    void getHealth(record.id).then(value => { if (activeSessionId.current === record.id) setHealth(value); }).catch(() => {});
    setError(null);
    let retainedSend: PendingSend | null = null;
    try { retainedSend = readPendingSend(record.id); setPendingSend(retainedSend); setSendRecoveryBlocked(false); }
    catch (error) { setPendingSend(null); setSendRecoveryBlocked(true); setError(error instanceof Error ? error.message : String(error)); }
    setContextUnavailable(false);
    setWithoutAppDetails(false);
    setStatus(record.status);
    setActivity(null);
    setConnection("connecting");
    setEvents([]);
    setStreamed("");
    // Whatever was left unsent in this session, put back in the box. Per session, so switching away
    // and back returns your own half-written sentence rather than someone else's.
    setInput(readDraft(record.id, retainedSend?.draftText ?? record.handoffDraft?.text ?? ""));
    // Keep unsent files scoped to their conversation during tab switches in this browser.
    setPending(pendingBySession.current.get(record.id) ?? []);
    const savedFiles = readDraftAttachments(record.id) ?? record.handoffDraft?.attachments ?? [];
    const recoveredFiles = [...new Map([...savedFiles, ...(retainedSend?.attachments ?? [])].map(file => [file.name, file])).values()];
    setUploaded(recoveredFiles);
    if (retainedSend) writeDraftAttachments(record.id, recoveredFiles);
    setUploadingFile(null);
    setFailedUpload(null);
    try {
      window.localStorage.setItem(SESSION_STORAGE_KEY, record.id);
      if (fullPage) window.localStorage.setItem(sessionStorageKey, record.id);
    } catch {
      // Private-mode storage refusal costs reattachment across reloads, nothing else.
    }

    const abort = new AbortController();
    let settingsRefresh = 0;
    let settingsPending = false;
    let latestModelRevision = record.selectionRevision ?? 0;
    const refreshSettings = () => {
      const revision = ++settingsRefresh;
      settingsPending = true;
      void getSession(record.id).then(value => {
        if (!abort.signal.aborted && revision === settingsRefresh && activeSessionId.current === record.id) onSessionChange(value);
      }).catch(() => {}).finally(() => { if (revision === settingsRefresh) settingsPending = false; });
    };
    streamAbortRef.current = abort;
    void streamEvents(
      record.id,
      (event) => {
        if (abort.signal.aborted) return;
        suggestionsReceive(event);
        if (event.type === "session_suggestion") return;
        if (event.type === "context_usage") {
          setContextUsage(current => applyContextUsage(current, record.id, event));
          return;
        }
        if (event.type === "session_activity") {
          const update = event as unknown as SessionActivity;
          setActivity(current => current?.epoch === update.epoch && current.revision >= update.revision ? current : update);
          return;
        }
        if (event.type === "session_profile_changed" || event.type === "session_provider_changed" || event.type === "session_autonomy_changed") {
          const settings: Partial<AssistantSession> = event.type === "session_autonomy_changed"
            ? (event.autonomy === "normal" || event.autonomy === "autonomous" ? { autonomy: event.autonomy } : {})
            : typeof event.connectionId === "string" && typeof event.connectionRevision === "number"
              && (event.harnessKind === "codex" || event.harnessKind === "claude") && typeof event.providerLocked === "boolean"
              ? { connectionId: event.connectionId, connectionRevision: event.connectionRevision, harnessKind: event.harnessKind, providerLocked: event.providerLocked } : {};
          const applySettings = (current: AssistantSession) => current.id === record.id && event.seq >= (current.lastEventSeq ?? 0) && activityTime({ updatedAt: event.ts }) >= activityTime(current)
            ? { ...current, ...settings, updatedAt: event.ts, lastEventSeq: event.seq } : current;
          // Profile notifications carry only a revision. Apply the fetched configuration atomically;
          // their later event timestamp must not make the saved record appear stale.
          if (event.type !== "session_profile_changed") {
            setSessions(current => current.map(applySettings));
            setSession(current => current ? applySettings(current) : current);
          }
          refreshSettings();
          void getHealth(record.id).then(value => { if (activeSessionId.current === record.id) setHealth(value); }).catch(() => {});
          return;
        }
        if (event.type === "model_selection_changed") {
          const revision = Number(event.revision);
          const selection = event.selection as AssistantSession["executionSelection"];
          const apply = (current: AssistantSession) => current.id === record.id && revision > (current.selectionRevision ?? 0)
            ? { ...current, executionSelection: selection, selectionRevision: revision } : current;
          setSession(current => current ? apply(current) : current); setSessions(current => current.map(apply));
          // A model event can overtake a pending profile snapshot. Replace that request so the
          // complete profile/provider configuration catches up without rolling back the selection.
          if (revision > latestModelRevision) {
            latestModelRevision = revision;
            refreshSettings();
          }
          return;
        }
        // A status/context update can make an in-flight settings snapshot too old to merge.
        // Replace only pending reads; ordinary conversation activity does not poll settings.
        if (settingsPending && (event.type === "user_message" || event.type === "app_context_changed"
          || event.type === "session_status" && event.historical !== true)) refreshSettings();
        if (event.type === "user_message") {
          const lock = (current: AssistantSession) => current.id === record.id
            ? { ...current, ...(current.providerLocked !== undefined ? { providerLocked: true } : {}), ...(current.profileLocked !== undefined ? { profileLocked: true } : {}) } : current;
          setSession(current => current ? lock(current) : current);
          setSessions(current => current.map(lock));
        }
        if (event.type === "app_context_changed") {
          const revision = Number(event.appContextRevision);
          setSessions(current => current.map(item => item.id === record.id && revision > (item.appContextRevision ?? 0)
            ? { ...item, appIds: event.appIds as string[], appContextRevision: revision, lastEventSeq: event.seq, updatedAt: activityTime({ updatedAt: event.ts }) > activityTime(item) ? event.ts : item.updatedAt } : item));
          setSession(current => current?.id === record.id && revision > (current.appContextRevision ?? 0)
            ? { ...current, appIds: event.appIds as string[], appContextRevision: revision, lastEventSeq: event.seq, updatedAt: activityTime({ updatedAt: event.ts }) > activityTime(current) ? event.ts : current.updatedAt } : current);
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
          if (event.historical === true) return;
          const value = String(event.status ?? "idle");
          setStatus(value);
          const applyStatus = (item: AssistantSession) => item.id === record.id ? { ...item, status: value,
            lastEventSeq: Math.max(item.lastEventSeq ?? 0, event.seq),
            updatedAt: activityTime({ updatedAt: event.ts }) > activityTime(item) ? event.ts : item.updatedAt } : item;
          setSessions(current => current.map(applyStatus));
          setSession(current => current ? applyStatus(current) : current);
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
  }, [onSessionChange, suggestionsReceive, fullPage, sessionStorageKey]);

  // A full-page selection is also a navigation: Shell must restore that exact session on reload.
  const navigateSelection = useCallback(async (sessionId: string | null, workspaceId?: string | null) => {
    if (!fullPage) return;
    const route = new URL(window.location.href);
    route.searchParams.delete("workspace");
    if (!sessionId && workspaceId) route.searchParams.set("workspace", workspaceId);
    if (sessionId) route.searchParams.set("session", sessionId);
    else route.searchParams.delete("session");
    if (route.href !== window.location.href) window.history.pushState(window.history.state, "", route);
    // Report an in-place selection to the host; opening a main surface reloads this document.
    for (const key of ["hosty_launch", "hosty_theme", "hosty_theme_preference"]) route.searchParams.delete(key);
    ui.reportSurfaceState({ route: `${route.pathname}${route.search}${route.hash}`, state: "ready" });
  }, [fullPage, ui]);
  const selectedRoute = useRef<string | null>(null);
  const sessionTabFocus = useRef<string | null>(null);
  const pickSession = (record: AssistantSession, keepTabFocus = false) => {
    sessionTabFocus.current = keepTabFocus ? record.id : null;
    setSelectedWorkspaceId(null); setWorkspaceToResolve(null);
    selectedRoute.current = fullPage ? record.id : null;
    requestedSessionRef.current = record.id;
    setSurfaceSessionId(null);
    setRequestedSessionId(record.id);
    setMobileSessions(false); setMobileDetails(false); setReview(null);
  };

  const clearActiveConversation = useCallback(() => {
    streamAbortRef.current?.abort(); activeSessionId.current = null;
    requestedSessionRef.current = null; selectedRoute.current = null;
    setRequestedSessionId(null); setSurfaceSessionId(null); setSession(null);
    setStatus("idle"); setEvents([]); setStreamed(""); setInput(""); setPending([]); setUploaded([]);
    setPendingSend(null); setError(null);
  }, []);
  const pickWorkspace = (target: DevelopmentWorkspace, matched?: AssistantSession) => {
    const record = matched ?? rememberedWorkspaceSession(target, sessions);
    setMobileSessions(false); setMobileDetails(false); setReview(null); setWorkspaceVisible(true);
    if (record) pickSession(record);
    else {
      clearActiveConversation(); setSelectedWorkspaceId(target.id); setWorkspaceToResolve(null);
      void navigateSelection(null, target.id);
    }
  };
  const workspaceActions = useWorkspaceSessionActions(workspace, inventory.refresh, record => {
    setSessions(current => [record, ...current.filter(s => s.id !== record.id)]); pickSession(record);
  });
  useEffect(() => {
    if (!fullPage) return;
    const onPop = () => {
      clearActiveConversation();
      const params = new URLSearchParams(window.location.search);
      const id = params.get("session"), target = params.get("workspace");
      setSelectedWorkspaceId(target); setWorkspaceToResolve(target); setMobileSessions(!id && !target);
      if (id) { requestedSessionRef.current = id; setRequestedSessionId(id); }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [fullPage, clearActiveConversation]);
  useEffect(() => {
    if (!workspaceToResolve || !ready || inventory.loading || inventory.error) return;
    const target = inventory.workspaces.find(w => w.id === workspaceToResolve && w.workflow.state !== "deleted");
    let cancelled = false;
    void listSessions().then(records => {
      if (cancelled) return;
      setWorkspaceToResolve(null);
      if (!target) { setError("This workspace is unavailable."); return; }
      setSessions(records);
      const record = rememberedWorkspaceSession(target, records);
      if (record) {
        requestedSessionRef.current = record.id; setRequestedSessionId(record.id);
      }
      const route = new URL(window.location.href);
      for (const key of ["hosty_launch", "hosty_theme", "hosty_theme_preference"]) route.searchParams.delete(key);
      ui.reportSurfaceState({ route: `${route.pathname}${route.search}${route.hash}`, state: "ready" });
    }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [workspaceToResolve, ready, inventory.loading, inventory.error, inventory.workspaces, ui]);

  const startNew = useCallback(async () => {
    setError(null);
    try {
      const record = await createSession({});
      setSessions((current) => [record, ...current]);
      setHistoryOpen(false);
      setSelectedWorkspaceId(null); setWorkspaceToResolve(null);
      attach(record); setReview(null); setMobileSessions(false);
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
        const params = new URLSearchParams(window.location.search);
        const requestedWorkspace = fullPage ? params.get("workspace") : null;
        if (requestedWorkspace) { setSelectedWorkspaceId(requestedWorkspace); setWorkspaceToResolve(requestedWorkspace); setMobileSessions(false); }
        const requested = params.get("session");
        if (requested && /^[a-zA-Z0-9-]+$/.test(requested)) {
          requestedSessionRef.current = requested;
          setRequestedSessionId(requested); setMobileSessions(false);
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
          stored = window.localStorage.getItem(sessionStorageKey);
          restoreHistory = window.localStorage.getItem(HISTORY_STORAGE_KEY) === "true";
        } catch {
          // Private-mode storage can refuse reads as well as writes; that costs reattachment, and
          // must not take the whole page down with it.
        }
        const previous = stored ? await getSession(stored).catch(() => null) : null;
        if (cancelled) {
          return;
        }

        if (requestedSessionRef.current || requestedWorkspace) return;
        setShowSessions(restoreHistory);

        if (previous) {
          attach(previous);
          return;
        }

        // Deleting the last session leaves an empty history, including after a reload.
        if (restoreHistory || fullPage) return;

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
  }, [attach, fullPage, sessionStorageKey]);

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
      setSelectedWorkspaceId(null);
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
      if (sessionTabFocus.current === record.id) {
        document.getElementById(`workspace-tab-${record.id}`)?.focus(); sessionTabFocus.current = null;
      } else composerRef.current?.focus();
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
    const refreshPending = () => {
      if (!session) return;
      try { setPendingSend(readPendingSend(session.id)); setSendRecoveryBlocked(false); }
      catch (error) { setSendRecoveryBlocked(true); setError(error instanceof Error ? error.message : String(error)); }
    };
    const changed = (event: StorageEvent) => {
      if (session && event.key === PENDING_SEND_PREFIX + session.id) refreshPending();
      if (session && event.key === `hosty.assistant.draft.${session.id}`) setInput(event.newValue ?? "");
      if (session && event.key === `hosty.assistant.attachments.${session.id}`) setUploaded(readDraftAttachments(session.id) ?? []);
    };
    window.addEventListener("storage", changed);
    window.addEventListener(PENDING_SEND_CHANGED, refreshPending);
    return () => { window.removeEventListener("storage", changed); window.removeEventListener(PENDING_SEND_CHANGED, refreshPending); };
  }, [session]);

  // Overlay live status while retaining stream updates for previously selected sessions.
  const listedSessions = useMemo(
    () => session ? sessions.map(record => record.id === session.id && record.status !== status ? { ...record, status } : record) : sessions,
    [sessions, session, status],
  );

  const appIconMetadata = useMemo(() => [...new Map([
    ...listedSessions.flatMap(record => record.contextApps ?? []), ...(session?.contextApps ?? []),
  ].map(app => [app.id, app])).values()], [listedSessions, session?.contextApps]);

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

  const acceptSend = useCallback(async (request: PendingSend) => {
    const sentNames = new Set(request.attachments.map(file => file.name));
    const settled = await withPendingSendLock(request.sessionId, () => {
      if (readPendingSend(request.sessionId)?.clientRequestId !== request.clientRequestId) return false;
      // Retire the original draft before releasing its journal; another view cannot claim it
      // between confirmation and cleanup. Storage failure keeps the original receipt recoverable.
      if (readDraft(request.sessionId) === draftStorageText(request.draftText)) {
        writeDraft(request.sessionId, "");
        if (readDraft(request.sessionId)) throw new Error("The message was accepted, but its saved draft could not be cleared. Retry checks the same receipt.");
      }
      const remaining = readDraftAttachments(request.sessionId)?.filter(file => !sentNames.has(file.name)) ?? [];
      if (!writeDraftAttachments(request.sessionId, remaining)) throw new Error("The message was accepted, but its saved attachments could not be cleared. Retry checks the same receipt.");
      forgetPendingSend(request);
      return true;
    });
    if (!settled) return;
    setSessions(current => current.map(item => item.id === request.sessionId ? { ...item, handoffDraft: undefined } : item));
    setSession(current => current?.id === request.sessionId ? { ...current, handoffDraft: undefined } : current);
    if (activeSessionId.current !== request.sessionId) return;
    setPendingSend(current => current?.clientRequestId === request.clientRequestId ? null : current);
    setContextUnavailable(false); setWithoutAppDetails(false);
    setUploaded(current => current.filter(file => !sentNames.has(file.name)));
    setInput(current => current === request.draftText ? "" : current);
    const named = await getSession(request.sessionId).catch(() => null);
    if (named && activeSessionId.current === request.sessionId) onSessionChange(named);
  }, [onSessionChange]);

  const recoverSend = useCallback(async () => {
    if (!pendingSend || sendingRef.current || sendRecoveryBlocked) return;
    const request = pendingSend;
    sendingRef.current = true; setSending(true); setError(null);
    try {
      const receipt = await retryPendingSend(request);
      if (receipt?.state === "accepted") await acceptSend(request);
      else if (receipt?.state === "rejected") {
        forgetPendingSend(request);
        if (activeSessionId.current === request.sessionId) setPendingSend(current => current?.clientRequestId === request.clientRequestId ? null : current);
        throw new Error(receipt.error?.message ?? "The message was not sent. Review the draft before sending again.");
      } else throw new Error("This message may already have been sent. Inspect the conversation; this check did not resend it.");
    } catch (error) {
      if (activeSessionId.current === request.sessionId) setError(error instanceof Error ? error.message : String(error));
    } finally { sendingRef.current = false; setSending(false); }
  }, [pendingSend, sendRecoveryBlocked, acceptSend]);

  const send = useCallback(async () => {
    const trimmed = (mentionInputRef.current?.serialize() ?? input).trim();
    if (!hasMessageContent(trimmed, pending.length, uploaded.length) || !session || pendingSend || sendRecoveryBlocked || composerBlockedRef.current || sendingRef.current || providerSavingRef.current || stoppingRef.current === session.id || running || contextSaving || mentionSavingRef.current || !health?.available) {
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setError(null);
    setFailedUpload(null);
    let activeFile: File | null = null;
    let request: PendingSend | undefined;
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
        if (!writeDraftAttachments(session.id, stored)) throw new Error("Browser storage is unavailable. Your uploaded attachment remains in this panel; allow storage before sending.");
      }
      if (activeSessionId.current === session.id) setUploadingFile(null);
      // Lock the composer before the HTTP response: SSE may confirm (or finish) the turn first.
      if (activeSessionId.current === session.id) setStatus("running");
      request = { version: 1, clientRequestId: crypto.randomUUID(), sessionId: session.id, text: trimmed, draftText: input,
        attachments: stored, ...(suggestions.preference?.enabled === true ? { promptSuggestions: true } : {}), appContextRevision: session.appContextRevision ?? 0, withoutAppDetails, selectionRevision: session.selectionRevision ?? 0 };
      await claimPendingSend(request);
      if (activeSessionId.current === session.id) setPendingSend(request);
      const receipt = await dispatchPendingSend(request);
      if (receipt?.state !== "accepted") throw new Error("The send outcome could not be verified. Retry checks the original request before sending again.");
      await acceptSend(request);
    } catch (cause) {
      if (activeSessionId.current !== session.id) return;
      setFailedUpload(activeFile);
      // These explicit pre-admission refusals settle the first attempt. Preserve the editable
      // draft so context/provider corrections can start a distinct intentional request.
      if (request && isMessageAdmissionRejection(cause)) {
        forgetPendingSend(request); setPendingSend(current => current?.clientRequestId === request?.clientRequestId ? null : current);
      }
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
  }, [input, pending, pendingSend, sendRecoveryBlocked, running, status, contextSaving, session, uploaded, withoutAppDetails, health?.available, onSessionChange, acceptSend, suggestions.preference?.enabled]);

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
    const retainedWorkspaceId = navigation === "workspaces" ? workspace?.id : undefined;
    setSelectedWorkspaceId(retainedWorkspaceId ?? null);
    void inventory.refresh();
    void navigateSelection(null, retainedWorkspaceId).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
    try {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
      window.localStorage.removeItem(sessionStorageKey);
    } catch {
      // An obsolete stored id is harmless: reattachment resolves it through the API.
    }
  }, [setHistoryOpen, fullPage, navigateSelection, workspace, inventory, sessionStorageKey, navigation]);

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

  const pendingDecision = events.find(event => status === "awaiting_approval" && event.type === "approval_request" && !decidedApprovals.has(String(event.approvalId)) || status === "awaiting_question" && event.type === "question_request" && !cancelledQuestionIds.has(String(event.questionId)) && !answeredQuestions.has(String(event.questionId)));

  const createAppAction = fullPage && navigation === "workspaces" ? session ? (
    <CreateApp key={`creation-${session.id}`} session={session} openOnMount={openAppCreation}
      onOpened={() => setOpenAppCreation(false)} busy={running || sending || stopping || providerSaving}
      onChange={record => { onSessionChange(record); void inventory.refresh(); }} />
  ) : (
    <Button variant="ghost" size="icon-sm" aria-label="Create app" title="Create app" disabled={!ready || openAppCreation}
      onClick={() => {
        setOpenAppCreation(true);
        void startNew().then(record => { if (!record) setOpenAppCreation(false); });
      }}><Plus aria-hidden /></Button>
  ) : null;

  return (
    <div className={`harness-conversation flex h-dvh min-h-0 min-w-0 flex-col overflow-hidden ${review ? "harness-review-active" : ""}`}>
      {fullPage && !review && <header inert={workspaceModal} className="flex min-[900px]:hidden shrink-0 items-center gap-2 border-b px-3 py-2">
        <Button className="md:hidden" size="sm" variant="ghost" onClick={() => { setMobileSessions(v => !v); setMobileDetails(false); }}>{navigationTitle}</Button>
        {workspace && <Button className="ml-auto" size="sm" variant="outline" onClick={() => { setMobileDetails(v => !v); setMobileSessions(false); }}>Workspace details</Button>}
      </header>}
      {fullPage && inventory.error && <p role="alert" className="border-b px-4 py-2 text-sm text-destructive-foreground">{inventory.error}</p>}
      <div className="flex min-h-0 flex-1">
      {fullPage && <div inert={workspaceModal} className={`${review ? "hidden" : mobileSessions ? "block md:block" : "hidden md:block"} w-full shrink-0 border-r md:w-[264px]`}><DevelopmentNavigation view={navigation} sessions={listedSessions} activeId={session?.id} activeWorkspaceId={navigation === "workspaces" ? workspace?.id : undefined} workspaces={inventory.workspaces}
        createAppAction={createAppAction} onWorkspace={pickWorkspace} onNew={() => { setMobileSessions(false); void startNew(); }} onPick={pickSession} onDelete={remove} /></div>}
      <main ref={conversationRef} tabIndex={-1} inert={workspaceModal} className={`${review ? "hidden" : fullPage && mobileSessions ? "hidden md:flex" : "flex"} min-h-0 min-w-0 flex-1 flex-col`}>

      {fullPage && navigation === "workspaces" && workspace && <WorkspaceSessionTabs workspace={workspace} sessions={listedSessions} activeId={chatVisible ? session?.id : undefined} onPick={record => pickSession(record, true)} actions={workspaceActions} />}
      {fullPage && (!chatVisible || !session) ? <div className="min-h-0 flex-1" aria-label="Workspace center">
        {!workspace && <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
          <p>{navigation === "workspaces" ? "Choose a workspace, create an app or continue building." : "Choose a chat or start a new one."}</p>
          {navigation === "chats" && <Button variant="outline" disabled={!ready} onClick={() => void startNew()}>New chat</Button>}
        </div>}
        {workspace && <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
          <p>No accessible chats in this workspace.</p>
          <Button variant="outline" disabled={workspaceActions.busy || workspaceActions.retry || !workspace.participation || !workflowIsActive(workspace.workflow)} onClick={() => void workspaceActions.command("new")}>New session in workspace</Button>
        </div>}
        {error && <p role="alert" className="p-3 text-sm text-destructive-foreground">{error}</p>}
      </div> : <div id="workspace-chat" role={fullPage && navigation === "workspaces" && workspace ? "tabpanel" : undefined} aria-labelledby={fullPage && navigation === "workspaces" && workspace && session ? `workspace-tab-${session.id}` : undefined} className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap shrink-0 items-center gap-2 border-b px-3 py-2">
        {showSessions ? (
          <>
            {session && <Button variant="ghost" size="icon-sm" aria-label="Back to conversation" title="Back to conversation" onClick={() => setHistoryOpen(false)}><ArrowLeft /></Button>}
            <h1 className="min-w-0 flex-1 truncate text-sm font-medium">Session history</h1>
            <Button variant="ghost" size="sm" disabled={!ready} onClick={() => void startNew()}><MessageSquarePlus data-icon="inline-start" />New session</Button>
          </>
        ) : (
          <>
            <div className={cn("flex min-w-0 flex-1 items-center gap-2", fullPage && "basis-48")}>
              {fullPage ? <>{session && renamingSessionId === session.id ? <SessionTitleInput key={session.id} title={session.title ?? ""} onCommit={async title => { setRenamingSessionId(null); await rename(session.id, title); }} onCancel={() => setRenamingSessionId(null)} /> : <><h1 className="min-w-0 truncate text-sm font-medium">{session ? session.title || "Untitled session" : "New session"}</h1>{session && <Button variant="ghost" size="icon-sm" aria-label="Rename session" onClick={() => setRenamingSessionId(session.id)}><Pencil className="size-3.5" /></Button>}</>}</> : <HostyNavigationBoundary><Sparkles className="h-4 w-4 shrink-0" aria-hidden /><span className="text-sm font-medium">Assistant</span></HostyNavigationBoundary>}
            </div>
            <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
              <StatusBadge value={status} />
              {session && <SessionExecutionIndicator executionMode={session.executionMode} />}
              {fullPage && workspace && <Button variant="ghost" size="icon-sm" className="hidden min-[900px]:inline-flex" aria-label="Toggle workspace" aria-pressed={workspaceVisible} onClick={() => setWorkspaceVisible(value => !value)}><PanelRight /></Button>}
              {session && (
                <AppContextPicker key={session.id} ref={contextPickerRef} opener={addButtonRef} compact side="bottom" session={session} busy={sending || mentionSaving || providerSaving} onBusyChange={setContextSaving} running={running}
                  onChange={onSessionChange} />
              )}
              {!fullPage && <div className="flex items-center gap-1">
                {createAppAction}
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
                    const destination = workspace ? "/development" : "/chats";
                    const entry = ui.getNavigation().entries.find(e => e.route === destination);
                    if (entry) { const result = await ui.navigate(entry.key, { requestId: crypto.randomUUID(), placement: "main", search: `?session=${encodeURIComponent(session.id)}` }); if (result.status === "accepted") return; }
                    window.open(`${destination}?session=${encodeURIComponent(session.id)}`, "_blank", "noopener");
                  } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
                  finally { sendingRef.current = false; setSending(false); }
                }}>Open in Harness</Button>
                <Button variant="ghost" size="icon-sm" title="Manage sessions" aria-label="Session history" disabled={!ready} onClick={() => {
                  setHistoryOpen(true);
                  void listSessions().then(setSessions).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
                }}><History /></Button>
                <Button variant="ghost" size="icon-sm" title="New session" aria-label="New session" disabled={!ready} onClick={() => void startNew()}><MessageSquarePlus /></Button>
              </div>}
            </div>
          </>
        )}
      </header>
      {!showSessions && pendingDecision && <div className="flex shrink-0 items-center gap-2 border-b border-warning-foreground/25 bg-warning-soft px-3 py-2 text-sm text-warning-foreground"><Diamond className="size-4 shrink-0" /><span className="min-w-0 flex-1">Needs you · {pendingDecision.type === "approval_request" ? "Approval requested" : "Answer requested"}</span><Button size="sm" variant="outline" onClick={() => { decisionCard.current?.scrollIntoView({ block: "center", behavior: "instant" }); decisionCard.current?.focus(); }}>Review</Button></div>}
      {!showSessions && !pendingDecision && (running || stopping) && <div className="flex shrink-0 items-center border-b bg-info-soft"><div className="min-w-0 flex-1"><AssistantActivity status={status} activity={activity?.activity ?? null} connection={connection} stopping={stopping} appNames={appNames} /></div><Button variant="ghost" size="sm" className="mr-2" disabled={stopping} onClick={() => void stop()}><Square className="size-3" />Stop</Button></div>}
      {session && !showSessions && <SessionRetention sessionId={session.id} revision={`${status}:${workspace?.workflow.revision ?? ""}`} />}

      {!showSessions && session && <SessionCredentials key={`credentials-${session.id}`} sessionId={session.id} />}
      {!fullPage && !showSessions && session && <SessionSandboxes key={`sandbox-${session.id}`} sessionId={session.id} />}
      {!fullPage && !showSessions && session && <SessionWorkspaces key={`workspaces-${session.id}`} session={session} running={running} />}
      {error && <div className="shrink-0 p-3" role="alert"><InlineError message={error} /></div>}
      {pendingSend && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-warning-soft px-3 py-2 text-sm" role="status">
        <span className="min-w-0 flex-1">Send not confirmed. Your draft is retained; Retry checks the original request.</span>
        <Button type="button" variant="outline" size="sm" disabled={sending} onClick={() => void recoverSend()}>{sending ? "Checking send…" : "Retry send"}</Button>
      </div>}

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
                <MessageScrollerContent className="mx-auto w-full max-w-[760px] gap-4 p-3 sm:p-4">

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
                      <ToolActivity events={item.events} appNames={appNames} reviewContext={transcriptReviewContext} commandResults={item.commandResults} toolResults={item.toolResults} />
                    </MessageScrollerItem>
                  ) : (
                    <MessageScrollerItem key={item.key} messageId={item.key}>
                    <div ref={item.event === pendingDecision ? decisionCard : undefined} tabIndex={item.event === pendingDecision ? -1 : undefined}>
                    <TranscriptEvent
                      event={item.event}
                      appNames={appNames}
                      attachments={attachmentIndex}
                      reviewContext={transcriptReviewContext}
                      decision={item.event.type === "approval_request" ? decidedApprovals.get(String(item.event.approvalId)) ?? null : null}
                      questionCancelled={item.event.type === "question_request" && cancelledQuestionIds.has(String(item.event.questionId))}
                      answers={item.event.type === "question_request" ? answeredQuestions.get(String(item.event.questionId)) ?? null : null}
                      // Absent reads as "cannot": a reason box on a harness whose decline carries nothing
                      // would promise delivery the gateway then refuses.
                      denyReason={health?.capabilities?.denyReason === true}
                      onDecide={decide}
                      onAnswer={answer}
                    />
                    </div>
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

          {!composerBlocked && <>
          {contextUnavailable && (
            <label className="flex gap-2 px-3 py-2 text-xs">
              <Checkbox checked={withoutAppDetails} onCheckedChange={value => setWithoutAppDetails(value === true)} />
              Send without fresh app details for this message
            </label>
          )}
          <form
            className="mx-auto w-full max-w-[760px] shrink-0 p-3 sm:p-4" aria-label="Message composer"
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
              {visibleSuggestion && <PromptSuggestionCard text={visibleSuggestion.text!} onAccept={acceptSuggestion} onDismiss={suggestions.interact} />}
              <AppMentionInput
                ref={mentionInputRef}
                key={session?.id ?? "empty"}
                inputRef={composerRef}
                session={session}
                contextBusy={contextSaving || sending || providerSaving}
                onContextChange={onSessionChange}
                onBusyChange={onMentionSaving}
                value={input}
                onChange={text => { suggestions.interact(); setInput(text); }}
                onCompositionStart={suggestions.interact}
                onPaste={(event) => {
                  suggestions.interact();
                  // Leave native paste intact for every text flavor, including HTML-only clipboards.
                  const images = takePastedImages(event.clipboardData);
                  if (images.length === 0) return;
                  setPending((current) => [...current, ...images]);
                }}
                onKeyDown={(event) => {
                  if (visibleSuggestion && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                    if (event.key === "Escape") { event.preventDefault(); suggestions.interact(); return; }
                    if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); acceptSuggestion(); return; }
                  }
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                    event.preventDefault();
                    void send();
                  }
                }}
                rows={2}
                aria-label="Message"
                placeholder={session ? "Ask the operator assistant…" : "Waiting for the gateway…"}
                disabled={!session || sending || !!pendingSend || sendRecoveryBlocked}
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
                        description="Uploaded · ready to send" disabled={sending || !!pendingSend} onRemove={() => {
                          const remaining = uploaded.filter(item => item.name !== attachment.name);
                          setUploaded(remaining);
                          if (session) writeDraftAttachments(session.id, remaining);
                        }} />
                    ))}
                    {pending.map((file, index) => (
                      <ChatAttachment key={`${file.name}-${index}`} name={file.name} size={file.size} file={file}
                        state={uploadingFile === file ? "uploading" : failedUpload === file ? "error" : "idle"}
                        description={uploadingFile === file ? "Uploading…" : failedUpload === file ? "Upload failed · send to retry" : "Ready to upload"}
                        disabled={sending || !!pendingSend}
                        onRemove={() => setPending(current => current.filter((_, i) => i !== index))} />
                    ))}
                  </div>
                )}
                <div className="flex items-end gap-2" role="group" aria-label="Message actions">
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button ref={addButtonRef} type="button" size="icon" variant="ghost" disabled={!session || sending || !!pendingSend || sendRecoveryBlocked || mentionSaving || providerSaving} aria-label="Add to message"><Plus /></Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent side="top" align="start" onCloseAutoFocus={event => {
                        if (openContextAfterMenu.current) {
                          event.preventDefault(); openContextAfterMenu.current = false;
                          contextPickerRef.current?.open();
                        }
                      }}>
                        <DropdownMenuGroup>
                          <DropdownMenuItem disabled={contextSaving} onSelect={() => { openContextAfterMenu.current = true; }}><Blocks />Add app context</DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => { suggestions.interact(); fileInputRef.current?.click(); }}><Paperclip />Attach files</DropdownMenuItem>
                          <DropdownMenuCheckboxItem checked={suggestions.preference?.enabled ?? false} disabled={!suggestions.preference || suggestions.saving}
                            onCheckedChange={() => void suggestions.toggle()}>Prompt suggestions</DropdownMenuCheckboxItem>
                          {(suggestions.error || suggestions.availability === "unsupported" || suggestions.availability === "unavailable") &&
                            <p className="max-w-64 px-2 py-1 text-xs text-muted-foreground">{suggestions.error ?? (suggestions.availability === "unsupported"
                              ? "This provider version does not support suggestions." : "No suggestion is available for this connection and turn.")}</p>}
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {session?.profileLocked !== undefined && <SessionProfile key={`profile:${session.id}`} session={session} busy={sending || stopping || mentionSaving || contextSaving || providerSaving}
                      onSavingChange={onProviderSaving} onChange={record => {
                        onSessionChange(record);
                        void getHealth(record.id).then(value => { if (activeSessionId.current === record.id) setHealth(value); }).catch(() => {});
                      }} />}
                    {session?.connectionId && <SessionModel key={`model:${session.id}:${session.connectionId}:${session.connectionRevision}`} session={{ ...session, status }} busy={sending || stopping || mentionSaving || contextSaving || providerSaving}
                      onSavingChange={onProviderSaving} onChange={onSessionChange} />}
                    {session && <SessionAutonomy key={`autonomy:${session.id}`} session={{ ...session, status }} busy={sending || stopping || mentionSaving || contextSaving || providerSaving}
                      onSavingChange={onProviderSaving} onChange={onSessionChange} />}
                    {session && session.providerLocked !== undefined && <SessionProvider key={`provider:${session.id}:${session.connectionId}:${session.connectionRevision}`} session={session} busy={sending || mentionSaving || contextSaving || providerSaving} onSavingChange={onProviderSaving} onChange={record => {
                      onSessionChange(record);
                      void getHealth(record.id).then(value => { if (activeSessionId.current === record.id) setHealth(value); }).catch(() => {});
                    }} />}
                    {session?.connectionId && <ProviderUsageIndicator key={session.connectionId + ":" + session.connectionRevision} connectionId={session.connectionId} revision={session.connectionRevision} />}
                    {session && <ContextUsageIndicator usage={contextUsage.sessionId === session.id ? contextUsage.usage : null} connected={connection === "connected"} />}
                  </div>
                  {session && <SpeechInput key={session.id} onStart={suggestions.interact} disabled={sending || !!pendingSend || sendRecoveryBlocked} onText={text => setInput(current => current ? `${current}${/\s$/.test(current) ? "" : " "}${text}` : text)} />}
                  {running || stopping ? (
                    <Button type="button" size="icon" className="shrink-0" disabled={sending || stopping} onClick={() => void stop()} aria-label="Stop" title="Stop response">
                      {sending || stopping ? <Loader2 className="motion-safe:animate-spin" /> : <Square className="fill-current" />}
                    </Button>
                  ) : (
                    <Button type="submit" size="icon" className="shrink-0" disabled={!session || sending || !!pendingSend || sendRecoveryBlocked || providerSaving || contextSaving || mentionSaving || !health?.available || !hasMessageContent(input, pending.length, uploaded.length)} aria-label="Send">
                      {sending ? <Loader2 className="motion-safe:animate-spin" /> : <Send />}
                    </Button>
                  )}
                </div>
              </InputGroupAddon>
            </InputGroup>
          </form>
          </>}
        </>
      )}
      </div>}
      </main>
      {fullPage && workspace && <RetainedWorkspacePane open={mobileDetails} visible={workspaceVisible} reviewing={!!review} onClose={() => setMobileDetails(false)}>
        <WorkspaceDetails sessionActions={workspaceActions} key={workspace.id} workspace={workspace} onSessionSelected={record => { setSessions(current => [record, ...current.filter(s => s.id !== record.id)]); pickSession(record); }} appMetadata={appIconMetadata} title={workspace.name || session?.title || "Workspace"} sessionId={session?.id} running={running} refresh={inventory.refresh} deleteConversation={session ? () => remove(session.id) : undefined} onReview={(tree, choice) => openReview(workspace.id, tree, session?.id, choice)} />
      </RetainedWorkspacePane>}
      {review && <WorkspaceReview key={`${review.workspaceId}:${review.tree.id}`} workspaceId={review.workspaceId} tree={review.tree}
        choice={review.transcriptChoice ?? reviewChoices[review.tree.id] ?? { view: "session", path: "" }} onChoice={choice => {
          if (review.transcriptChoice) setReview(previous => previous ? { ...previous, transcriptChoice: choice } : previous);
          else setReviewChoices(previous => ({ ...previous, [review.tree.id]: choice }));
        }}
        onBack={closeReview} onAsk={!composerBlocked && review.sessionId && review.sessionId === session?.id ? reference => {
          if (activeSessionId.current !== review.sessionId || composerBlockedRef.current) return;
          setInput(current => activeSessionId.current !== review.sessionId ? current : current ? `${current}\n\n${reference}` : reference);
          closeReview();
          requestAnimationFrame(() => { if (activeSessionId.current === review.sessionId) composerRef.current?.focus(); });
        } : undefined} />}
      </div>
    </div>
  );
}
