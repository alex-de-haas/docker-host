"use client";
import { ProviderUsageIndicator } from "@/components/provider-usage";
import { ContextUsageIndicator } from "@/components/context-usage";
import { applyContextUsage, emptyContextUsage } from "@/lib/context-usage";
import { observedMcpActivity, type McpActivity } from "@/lib/mcp-activity";
import { HostyNavigationBoundary } from "@hosty-sdk/app/react";
import { SessionAgentSettings, type AgentSettingsNotice } from "@/components/session-agent-settings";
import { SessionAutonomy } from "@/components/session-autonomy";
import { SessionExecutionRecovery } from "@/components/session-execution-recovery";
import { SessionExecutionIndicator } from "@/components/session-execution-indicator";
import { useHostyUi } from "@hosty-sdk/app/ui/react";
import { AssistantActivity } from "@/components/assistant-activity";
import type { SessionActivity } from "../../../src/harness/activity";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { SpeechInput } from "@/components/speech-input";
import { SessionCredentials } from "@/components/session-credentials";
import { SessionSandboxes } from "@/components/session-sandboxes";
import { SessionWorkspaces } from "@/components/session-workspaces";
import { usePromptSuggestions } from "@/lib/prompt-suggestions";
import { MessageQueue, queueFileLabel } from "@/components/message-queue";
import { useMessageQueue } from "@/lib/use-message-queue";
import { uploadQueueAttachment, type QueueEntry } from "@/lib/message-queue-api";
import { clearEditDraft, listPreservedDrafts, outboxFiles, preserveDraft, readEditDraft, removePreservedDraft, restoredFiles, saveEditDraft, type EditDraft, type OutboxFile, type PreservedDraft } from "@/lib/message-outbox";
import { AppMentionInput, type AppMentionInputHandle } from "@/components/app-mention-input";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuCheckboxItem } from "@/components/ui/dropdown-menu";
import { AppContextPicker, type AppContextPickerHandle } from "@/components/app-context-picker";
import { ArrowLeft, History, Loader2, MessageSquarePlus, Paperclip, Plus, Blocks, Send, Sparkles, Square, PanelRight, PanelLeft, Diamond, Pencil } from "lucide-react";
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
import { feedbackCardForEvent, useFeedbackTranscript } from "@/lib/feedback-transcript";
import { resolveTranscriptReview, type TranscriptReviewReference } from "@/lib/transcript-edits";
import { InputGroup, InputGroupAddon } from "@/components/ui/input-group";
import { useWorkspaceSessionActions } from "@/lib/use-workspace-session-actions";
import { rememberWorkspaceSession, rememberedWorkspaceSession, workspaceSessionIds } from "@/lib/workspace-navigation";
import { readWorkSelection, rememberWorkSelection } from "@/lib/work-selection";
import { ColumnResizeHandle } from "@/components/column-resize-handle";
import { COLUMN_DEFAULTS, COLUMN_MIN, useConversationColumns } from "@/lib/use-conversation-columns";
import { DevelopmentNavigation } from "@/components/development-navigation";
import { CreateApp } from "@/components/create-app";
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
import { forgetPendingSend, readPendingSend, PENDING_SEND_PREFIX, PENDING_SEND_CHANGED, withPendingSendLock, retryPendingSend, type PendingSend } from "@/lib/pending-send";
import { useSessionListRefresh } from "@/lib/use-session-list-refresh";
import { activityTime, orderSessions, publishAttention, waitingCount } from "@/lib/attention";
import {
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
const EMPTY_MCP_ACTIVITY: McpActivity = { total: 0, tools: [] };


export function AssistantConversation({ fullPage = false }: { fullPage?: boolean }) {
  const ui = useHostyUi();
  const [health, setHealth] = useState<HarnessHealth | null>(null);
  const [sessions, setSessions] = useState<AssistantSession[]>([]);
  // Hold an embedder's session request until authentication finishes. Resolve it directly through
  // the API: a session Shell just created may not appear in this tab's initial list.
  const requestedSessionRef = useRef<string | null>(null);
  // Workspace-only and cleared selections have no session ID. Keep their intent through late
  // startup reads just as we do for an explicitly requested conversation.
  const selectionIntent = useRef(0);
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
  const [contextDetailsOpen, setContextDetailsOpen] = useState(false);
  const [agentNotice, setAgentNotice] = useState<AgentSettingsNotice | null>(null);
  const [autonomyNotice, setAutonomyNotice] = useState<AgentSettingsNotice | null>(null);
  const [activity, setActivity] = useState<SessionActivity | null>(null);
  const [connection, setConnection] = useState<StreamConnection>("connecting");
  const [historyReadyFor, setHistoryReadyFor] = useState<string | null>(null);
  const historyLoading = !!session && historyReadyFor !== session.id && connection !== "disconnected";
  const [events, setEvents] = useState<AssistantEvent[]>([]);
  const transcriptRequestIds = useMemo(() => new Set(events.flatMap(event => event.type === "user_message" && typeof event.clientRequestId === "string" ? [event.clientRequestId] : [])), [events]);
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
  // Fetched once: the roster changes when apps are installed, not between messages, and a failed
  // read leaves every label as the wire name — which is what the transcript showed before.
  const [appNames, setAppNames] = useState<Record<string, string>>({});
  // Already stored for this message but not yet sent — kept across a failed send, so a retry names
  // them instead of uploading them again under de-duplicated names.
  const [uploaded, setUploaded] = useState<StoredAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [historyOpen, setShowSessions] = useState(false);
  const showSessions = !fullPage && historyOpen;
  const navigationTitle = "Sessions";
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
  const narrowViewport = useNarrowWorkspace();
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
  const columnsRef = useRef<HTMLDivElement>(null);
  const columns = useConversationColumns(fullPage && !!workspace && workspaceVisible && !narrowViewport, columnsRef);
  const narrowWorkspace = narrowViewport || columns.narrow;
  const workspaceModal = narrowWorkspace && mobileDetails;
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
  const messageQueue = useMessageQueue(session, ready);
  const { queue: queueSnapshot, scope: queueScope, perform: performQueue, operation: queueOperation } = messageQueue;
  const queueReceive = messageQueue.receive;
  // A new document gets a new view. Reload/duplicated tabs recover a reservation explicitly.
  const [viewId] = useState(() => crypto.randomUUID());
  const [editTransition, setEditTransition] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [preserved, setPreserved] = useState<{ scope: string; drafts: PreservedDraft[] } | null>(null);
  const [composerEpoch, setComposerEpoch] = useState(0);
  const editFiles = useRef(new WeakMap<File, OutboxFile>());
  const restoredEdit = useRef("");
  const currentDraft = useRef({ input, pending, uploaded });
  useLayoutEffect(() => { currentDraft.current = { input, pending, uploaded }; }, [input, pending, uploaded]);
  const editing = editDraft?.scope === queueScope ? editDraft : null;
  const savedDrafts = preserved?.scope === queueScope ? preserved.drafts : [];
  const editRow = queueSnapshot?.entries.find(entry => entry.id === editing?.entryId);
  const editOwnershipLost = !!editing && !!queueSnapshot && (editRow?.edit?.reservationId !== editing.reservationId || editRow.edit.viewId !== viewId);
  const suggestions = usePromptSuggestions(session, ready, !!input || pending.length > 0 || uploaded.length > 0 || !!editing, {
    insert: text => mentionInputRef.current?.insertPlainText(text) ?? false, scope: queueSnapshot?.installationId,
  });
  const suggestionsReceive = suggestions.receive;
  const draftGeneration = useRef(new Map<string, number>());
  const suggestionInteracted = suggestions.interact;
  const draftInteracted = useCallback(() => {
    const id = activeSessionId.current;
    if (id) draftGeneration.current.set(id, (draftGeneration.current.get(id) ?? 0) + 1);
    suggestionInteracted();
  }, [suggestionInteracted]);
  const editLocked = editSaving || editOwnershipLost || editTransition === session?.id || !!queueOperation && ["reserve_edit", "recover_edit", "save_edit", "cancel_edit"].includes(queueOperation.input.command.type);
  const visibleSuggestion = !running && !sending && !pendingSend && !contextSaving && !mentionSaving && !providerSaving
    && !composerBlocked && queueSnapshot && connection === "connected" ? suggestions.suggestion : null;
  const acceptSuggestion = () => { if (visibleSuggestion) void suggestions.select(visibleSuggestion.suggestionId); };
  const fileSnapshots = useCallback((files: File[]) => files.map(file => {
    let stored = editFiles.current.get(file);
    if (!stored) { stored = outboxFiles([file])[0]!; editFiles.current.set(file, stored); }
    return stored;
  }), []);
  const restoreComposer = useCallback((draft: { text: string; attachments: StoredAttachment[]; files: OutboxFile[] }, persist = true) => {
    draftInteracted();
    const files = restoredFiles(draft.files);
    files.forEach((file, index) => editFiles.current.set(file, draft.files[index]!));
    setInput(draft.text); setUploaded(draft.attachments); setPending(files);
    if (persist && activeSessionId.current) { writeDraft(activeSessionId.current, draft.text); writeDraftAttachments(activeSessionId.current, draft.attachments); }
  }, [draftInteracted]);
  useEffect(() => {
    if (!queueScope) return;
    let active = true;
    void listPreservedDrafts(queueScope).then(drafts => { if (active) setPreserved({ scope: queueScope, drafts }); })
      .catch(cause => { if (active && typeof indexedDB !== "undefined") setError(String(cause)); });
    return () => { active = false; };
  }, [queueScope]);
  useEffect(() => {
    const key = queueScope;
    if (!key) { restoredEdit.current = ""; return; }
    const entry = queueSnapshot?.entries.find(entry => entry.edit?.viewId === viewId);
    if (!entry?.edit || restoredEdit.current === `${key}:${entry.edit.reservationId}`) return;
    let active = true;
    void Promise.all([readEditDraft(key, entry.id, entry.edit.reservationId), readEditDraft(key, entry.id, `pending:${viewId}`), readEditDraft(key, entry.id)])
      .then(([exact, pending, current]) => {
      const local = exact ?? pending ?? current;
      if (!active || !entry.edit) return;
      const reusable = local?.entryId === entry.id && local.viewId === viewId;
      const saved: EditDraft = { scope: key, entryId: entry.id, viewId, reservationId: entry.edit.reservationId,
        originalDraft: reusable ? local.originalDraft ?? { text: local.stash.text, attachments: local.stash.attachments }
          : { text: readDraft(session!.id), attachments: readDraftAttachments(session!.id) ?? [] },
        stash: reusable ? { ...local.stash,
          ...(local.stash.text === entry.edit.stashedDraft.text ? { attachments: entry.edit.stashedDraft.attachments } : {}) }
          : { ...entry.edit.stashedDraft, files: [] },
        buffer: reusable && local.buffer ? local.buffer : { text: entry.edit.text, attachments: entry.edit.attachments, files: [] } };
      restoredEdit.current = `${key}:${entry.edit.reservationId}`; setEditDraft(saved); restoreComposer(saved.buffer!, false);
      void saveEditDraft(saved).catch(cause => setError(String(cause)));
    }).catch(cause => setError(String(cause)));
    return () => { active = false; };
  }, [queueScope, queueSnapshot, viewId, restoreComposer, session]);
  useEffect(() => {
    if (!editing || editSaving) return;
    const value = { ...editing, buffer: { text: input, attachments: uploaded, files: fileSnapshots(pending) } };
    void saveEditDraft(value).catch(cause => setError(String(cause)));
    const row = queueSnapshot?.entries.find(entry => entry.id === editing.entryId);
    if (queueOperation || row?.edit?.reservationId !== editing.reservationId
      || row.edit.text === (mentionInputRef.current?.serialize() ?? input) && JSON.stringify(row.edit.attachments.map(file => file.name)) === JSON.stringify(uploaded.map(file => file.name))) return;
    const timer = setTimeout(() => {
      void performQueue({ type: "update_edit", entryId: editing.entryId, reservationId: editing.reservationId,
        viewId, text: mentionInputRef.current?.serialize() ?? input, attachments: uploaded.map(file => file.name) }).catch(() => {});
    }, 800);
    return () => clearTimeout(timer);
  }, [editing, input, pending, uploaded, editSaving, fileSnapshots, queueSnapshot, queueOperation, performQueue, viewId]);
  const beginQueueEdit = async (entry: QueueEntry, recover = false) => {
    if (!queueScope || !session || editing || sendingRef.current || editLocked) return;
    const id = session.id; setEditTransition(id);
    try {
      const draft = currentDraft.current;
      const previous = recover ? await readEditDraft(queueScope, entry.id) : null;
      const keepStash = previous?.entryId === entry.id && previous.stash.text === draft.input && !draft.pending.length;
      if (previous && !keepStash) await preserveDraft(queueScope, { id: `${previous.reservationId}:stash`, draft: previous.stash });
      const saved: EditDraft = { scope: queueScope, entryId: entry.id, viewId, reservationId: `pending:${viewId}`,
        originalDraft: { text: draft.input, attachments: draft.uploaded },
        stash: keepStash
          ? previous.stash : { text: draft.input, attachments: draft.uploaded, files: fileSnapshots(draft.pending) },
        ...(previous?.entryId === entry.id && previous.buffer ? { buffer: previous.buffer } : {}) };
      await saveEditDraft(saved);
      await performQueue(recover ? { type: "recover_edit", entryId: entry.id, viewId }
        : { type: "reserve_edit", entryId: entry.id, viewId, stashedDraft: { text: draft.input, attachments: draft.uploaded.map(file => file.name) } });
    } catch (cause) { if (activeSessionId.current === id) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setEditTransition(current => current === id ? null : current); }
  };
  const completeQueueEdit = useCallback(async (edit: EditDraft, id: string) => {
    const original = edit.originalDraft ?? edit.stash;
    const readShared = () => ({ text: readDraft(id), attachments: readDraftAttachments(id) ?? [], files: [] as OutboxFile[] });
    const names = (files: StoredAttachment[]) => files.map(file => file.name).sort().join("\n");
    const changedFrom = (draft: ReturnType<typeof readShared>) => draft.text !== draftStorageText(original.text) || names(draft.attachments) !== names(original.attachments);
    let shared = readShared(), changed = changedFrom(shared);
    if (changed) await preserveDraft(edit.scope, { id: edit.reservationId, draft: edit.stash });
    let drafts = await listPreservedDrafts(edit.scope);
    // A different tab may have typed while the browser storage transaction completed.
    shared = readShared();
    if (!changed && changedFrom(shared)) {
      await preserveDraft(edit.scope, { id: edit.reservationId, draft: edit.stash });
      drafts = await listPreservedDrafts(edit.scope); shared = readShared();
    }
    changed = changedFrom(shared);
    if (activeSessionId.current === id) {
      restoreComposer(changed ? shared : edit.stash);
      setEditDraft(current => current?.reservationId === edit.reservationId ? null : current); restoredEdit.current = "";
      setPreserved({ scope: edit.scope, drafts });
    } else if (!changed) { writeDraft(id, edit.stash.text); writeDraftAttachments(id, edit.stash.attachments); pendingBySession.current.set(id, restoredFiles(edit.stash.files)); }
    await clearEditDraft(edit.scope, edit.entryId, edit.reservationId);
  }, [restoreComposer]);
  useEffect(() => {
    if (!editing || !session || !editOwnershipLost || editSaving || editTransition || queueOperation) return;
    const id = session.id, scope = editing.scope;
    const draft = currentDraft.current;
    let active = true;
    // A recovery in another tab invalidates this reservation. Freeze and retain the local buffer
    // before returning to the ordinary draft; stale saves must never overwrite the new editor.
    void preserveDraft(scope, { id: `${editing.reservationId}:buffer`, draft: {
      text: draft.input, attachments: draft.uploaded, files: fileSnapshots(draft.pending),
    } }).then(async () => {
      if (!active) return;
      await completeQueueEdit(editing, id);
      const drafts = await listPreservedDrafts(scope);
      if (active && activeSessionId.current === id) setPreserved({ scope, drafts });
    }).catch(cause => { if (active && activeSessionId.current === id) setError(String(cause)); });
    return () => { active = false; };
  }, [editing, session, editOwnershipLost, editSaving, editTransition, queueOperation, fileSnapshots, completeQueueEdit]);
  const retryQueueOperation = async () => {
    const command = queueOperation?.input.command, edit = editing, id = session?.id;
    if (edit && command && ["save_edit", "cancel_edit"].includes(command.type)) setEditSaving(true);
    try {
      await performQueue();
      if (edit && id && command && (command.type === "save_edit" || command.type === "cancel_edit") && command.reservationId === edit.reservationId) await completeQueueEdit(edit, id);
    } catch { /* The exact operation remains in its recovery row. */ }
    finally { setEditSaving(false); }
  };
  const restorePreservedDraft = async (saved: PreservedDraft) => {
    if (!queueScope || !session || editing || editLocked || sendingRef.current) return;
    const scope = queueScope, id = session.id, draft = currentDraft.current;
    setEditTransition(id);
    try {
      // Restoring an older draft never discards the one currently in the composer.
      if (draft.input || draft.pending.length || draft.uploaded.length) await preserveDraft(scope, {
        id: crypto.randomUUID(), draft: { text: draft.input, attachments: draft.uploaded, files: fileSnapshots(draft.pending) },
      });
      if (activeSessionId.current !== id) return;
      const latest = { text: readDraft(id), attachments: readDraftAttachments(id) ?? [], files: [] as OutboxFile[] };
      if (latest.text !== draftStorageText(draft.input)
        || JSON.stringify(latest.attachments.map(file => file.name).sort()) !== JSON.stringify(draft.uploaded.map(file => file.name).sort())) {
        restoreComposer(latest, false);
        setPreserved({ scope, drafts: await listPreservedDrafts(scope) });
        setError("Another tab changed the draft. Its latest text was kept; restore the saved draft again when ready.");
        return;
      }
      restoreComposer(saved.draft);
      await removePreservedDraft(scope, saved.id);
      const drafts = await listPreservedDrafts(scope);
      if (activeSessionId.current === id) setPreserved({ scope, drafts });
    } catch (cause) { if (activeSessionId.current === id) setError(String(cause)); }
    finally { setEditTransition(current => current === id ? null : current); }
  };
  const finishQueueEdit = async (save: boolean) => {
    if (!editing || !session || sendingRef.current) return;
    sendingRef.current = true; setEditSaving(true); setSending(true); setError(null);
    try {
      const draft = currentDraft.current, files = fileSnapshots(draft.pending);
      const text = mentionInputRef.current?.serialize() ?? draft.input;
      const saved = { ...editing, buffer: { text: draft.input, attachments: draft.uploaded, files } };
      await saveEditDraft(saved);
      if (save) for (const file of files) {
        file.stored ??= await uploadQueueAttachment(session.id, file.id, file.name, file.bytes);
        await saveEditDraft(saved);
      }
      await performQueue(save ? { type: "save_edit", entryId: editing.entryId, reservationId: editing.reservationId,
        viewId, text, attachments: [...draft.uploaded, ...files.flatMap(file => file.stored ? [file.stored] : [])].map(file => file.name) }
        : { type: "cancel_edit", entryId: editing.entryId, reservationId: editing.reservationId, viewId });
      await completeQueueEdit(editing, session.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { sendingRef.current = false; setSending(false); setEditSaving(false); }
  };

  /** Attaches to one session and follows its log. Shared by reattach, switch and new. */
  const attach = useCallback((record: AssistantSession) => {
    if (activeSessionId.current !== record.id) setReview(null);
    streamAbortRef.current?.abort();
    activeSessionId.current = record.id;
    setContextUsage(emptyContextUsage(record.id));
    setContextDetailsOpen(false);
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
    setHistoryReadyFor(null);
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
    try {
      if (!fullPage) window.localStorage.setItem(SESSION_STORAGE_KEY, record.id);
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
        queueReceive(event);
        if (event.type === "session_message_queue") return;
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
        // The stream reports connected only after its initial historical replay.
        // Keep this boundary through reconnects so an existing reader is not remounted.
        if (state === "connected") setHistoryReadyFor(record.id);
        if (state !== "connected") setActivity(null);
        if (state === "disconnected") setStreamed("");
      },
    );
  }, [onSessionChange, suggestionsReceive, queueReceive, fullPage]);

  // A full-page selection is also a navigation: Shell must restore that exact session on reload.
  const navigateSelection = useCallback(async (sessionId: string | null, workspaceId?: string | null, replace = false) => {
    if (!fullPage) return;
    rememberWorkSelection(sessionId ? { sessionId } : workspaceId ? { workspaceId } : {});
    const route = new URL(window.location.href);
    route.searchParams.delete("workspace");
    if (!sessionId && workspaceId) route.searchParams.set("workspace", workspaceId);
    if (sessionId) route.searchParams.set("session", sessionId);
    else route.searchParams.delete("session");
    if (route.href !== window.location.href) window.history[replace ? "replaceState" : "pushState"](window.history.state, "", route);
    // Report an in-place selection to the host; opening a main surface reloads this document.
    for (const key of ["hosty_launch", "hosty_theme", "hosty_theme_preference"]) route.searchParams.delete(key);
    ui.reportSurfaceState({ route: `${route.pathname}${route.search}${route.hash}`, state: "ready" });
  }, [fullPage, ui]);
  const selectedRoute = useRef<string | null>(null);
  const pickSession = (record: Pick<AssistantSession, "id">) => {
    selectionIntent.current++;
    setSelectedWorkspaceId(null); setWorkspaceToResolve(null);
    selectedRoute.current = fullPage ? record.id : null;
    requestedSessionRef.current = record.id;
    setSurfaceSessionId(null);
    setRequestedSessionId(record.id);
    setMobileSessions(false); setMobileDetails(false); setReview(null);
  };

  const clearActiveConversation = useCallback(() => {
    selectionIntent.current++;
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
      rememberWorkSelection(id ? { sessionId: id } : target ? { workspaceId: target } : {});
      setSelectedWorkspaceId(target); setWorkspaceToResolve(target); setMobileSessions(!id && !target);
      if (id) { requestedSessionRef.current = id; setRequestedSessionId(id); }
      else if (!target) void navigateSelection(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [fullPage, clearActiveConversation, navigateSelection]);
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
    selectionIntent.current++;
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
    const startupIntent = selectionIntent.current;
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
        if (selectionIntent.current !== startupIntent) return;

        // Reattach first: the stream replays from seq 0, which rebuilds unresolved approval cards.
        let stored: string | null = null;
        let storedWorkspace: string | undefined;
        let restoreHistory = false;
        try {
          if (fullPage) {
            const selection = readWorkSelection(window.location.pathname);
            stored = selection?.sessionId ?? null;
            storedWorkspace = selection?.workspaceId;
          } else stored = window.localStorage.getItem(SESSION_STORAGE_KEY);
          restoreHistory = window.localStorage.getItem(HISTORY_STORAGE_KEY) === "true";
        } catch {
          // Private-mode storage can refuse reads as well as writes; that costs reattachment, and
          // must not take the whole page down with it.
        }
        // URL and embedder requests win without even fetching an unrelated saved conversation.
        if (requestedSessionRef.current || requestedWorkspace) {
          if (fullPage) rememberWorkSelection(requestedSessionRef.current ? { sessionId: requestedSessionRef.current } : { workspaceId: requestedWorkspace! });
          return;
        }
        if (storedWorkspace) {
          setSelectedWorkspaceId(storedWorkspace); setWorkspaceToResolve(storedWorkspace); setMobileSessions(false);
          await navigateSelection(null, storedWorkspace, true);
          return;
        }
        const previous = stored ? await getSession(stored).catch(() => null) : null;
        if (cancelled || selectionIntent.current !== startupIntent) {
          return;
        }

        if (requestedSessionRef.current || requestedWorkspace) return;
        setShowSessions(restoreHistory);

        if (previous) {
          attach(previous);
          if (fullPage) { setMobileSessions(false); await navigateSelection(previous.id, null, true); }
          return;
        }

        // Deleting the last session leaves an empty history, including after a reload.
        if (restoreHistory || fullPage) return;

        // Created because nothing was stored — and added to the list, or "Recent sessions" would
        // say there are none while one is open, and switching away would strand it.
        const created = await createSession({});
        if (cancelled || selectionIntent.current !== startupIntent) {
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
  }, [attach, fullPage, navigateSelection]);

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
        selectionIntent.current++;
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
      else if (fullPage) {
        const workspaceId = new URLSearchParams(window.location.search).get("workspace");
        rememberWorkSelection(workspaceId ? { workspaceId } : { sessionId: record.id });
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
      composerRef.current?.focus();
    }).catch(cause => {
      if (!cancelled) { requestedSessionRef.current = null; setError(cause instanceof Error ? cause.message : String(cause)); setRequestedSessionId(null); }
    });
    return () => { cancelled = true; };
  }, [attach, requestedSessionId, ready, setHistoryOpen, navigateSelection, fullPage]);

  // Written on change rather than on unload: a closed laptop, a crashed tab and a navigation away all
  // skip unload handlers, and those are exactly the cases where the text matters most.
  useEffect(() => {
    if (session && !editing && !editLocked) writeDraft(session.id, input);
  }, [input, session, editing, editLocked]);

  useEffect(() => {
    const refreshPending = () => {
      if (!session) return;
      try { setPendingSend(readPendingSend(session.id)); setSendRecoveryBlocked(false); }
      catch (error) { setSendRecoveryBlocked(true); setError(error instanceof Error ? error.message : String(error)); }
    };
    const changed = (event: StorageEvent) => {
      if (session && event.key === PENDING_SEND_PREFIX + session.id) refreshPending();
      if (session && !editing && !editLocked && event.key === `hosty.assistant.draft.${session.id}`) { draftInteracted(); setInput(event.newValue ?? ""); }
      if (session && !editing && !editLocked && event.key === `hosty.assistant.attachments.${session.id}`) setUploaded(readDraftAttachments(session.id) ?? []);
    };
    window.addEventListener("storage", changed);
    window.addEventListener(PENDING_SEND_CHANGED, refreshPending);
    return () => { window.removeEventListener("storage", changed); window.removeEventListener(PENDING_SEND_CHANGED, refreshPending); };
  }, [session, draftInteracted, editing, editLocked]);

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

  const send = async () => {
    if (editLocked) return;
    if (editing) { await finishQueueEdit(true); return; }
    const text = (mentionInputRef.current?.serialize() ?? input).trim();
    if (!session || !hasMessageContent(text, pending.length, uploaded.length) || pendingSend || sendRecoveryBlocked || composerBlockedRef.current
      || sendingRef.current || providerSavingRef.current || contextSaving || mentionSavingRef.current || !queueSnapshot) return;
    const id = session.id, snapshot = { input, pending, uploaded, generation: draftGeneration.current.get(session.id) ?? 0 };
    sendingRef.current = true; setSending(true); setError(null);
    try {
      await messageQueue.enqueue({ text, draftText: input, files: pending, attachments: uploaded,
        promptSuggestions: suggestions.preference?.enabled === true, withoutAppDetails });
      // Retire this session's persisted snapshot even if the operator switched away while staging.
      // Compare before clearing so a newer draft from another view survives the acknowledgement.
      if (readDraft(id) === draftStorageText(snapshot.input)
        && (draftGeneration.current.get(id) ?? 0) === snapshot.generation) writeDraft(id, "");
      writeDraftAttachments(id, (readDraftAttachments(id) ?? snapshot.uploaded).filter(file => !snapshot.uploaded.some(sent => sent.name === file.name)));
      const retained = pendingBySession.current.get(id);
      if (retained) pendingBySession.current.set(id, retained.filter(file => !snapshot.pending.includes(file)));
      // Only the submitted snapshot moves into the stack. A newer draft stays editable.
      if (activeSessionId.current === id) {
        setComposerEpoch(current => current + 1);
        setInput(current => (draftGeneration.current.get(id) ?? 0) === snapshot.generation && current === snapshot.input ? "" : current);
        setPending(current => current.filter(file => !snapshot.pending.includes(file)));
        setUploaded(current => current.filter(file => !snapshot.uploaded.includes(file)));
        setWithoutAppDetails(false); setContextUnavailable(false);
      }
    } catch (cause) { if (activeSessionId.current === id) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { sendingRef.current = false; setSending(false); }
  };

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
    setContextUnavailable(false);
    setWithoutAppDetails(false);
    requestedSessionRef.current = null;
    selectedRoute.current = null;
    setRequestedSessionId(null);
    setSurfaceSessionId(null);
    setMobileDetails(false);
    setHistoryOpen(!fullPage);
    const retainedWorkspaceId = workspace?.id;
    setSelectedWorkspaceId(retainedWorkspaceId ?? null);
    void inventory.refresh();
    void navigateSelection(null, retainedWorkspaceId).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
    try {
      if (!fullPage) window.localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // An obsolete stored id is harmless: reattachment resolves it through the API.
    }
  }, [setHistoryOpen, fullPage, navigateSelection, workspace, inventory]);

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
  const items = useMemo(() => transcriptItems(events, attachmentIndex.claimed, decidedApprovals), [events, attachmentIndex, decidedApprovals]);
  const feedbackTranscript = useFeedbackTranscript(session?.id, events, !historyLoading && !showSessions);
  const mcpActivity = useMemo(() => contextDetailsOpen ? observedMcpActivity(events) : EMPTY_MCP_ACTIVITY, [events, contextDetailsOpen]);

  const pendingDecision = events.find(event => status === "awaiting_approval" && event.type === "approval_request" && !decidedApprovals.has(String(event.approvalId)) || status === "awaiting_question" && event.type === "question_request" && !cancelledQuestionIds.has(String(event.questionId)) && !answeredQuestions.has(String(event.questionId)));

  const createAppAction = fullPage ? session ? (
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

  const navigationToggle = fullPage && <Button className="md:hidden shrink-0" size="icon-sm" variant="ghost"
    aria-label={`Show ${navigationTitle.toLowerCase()}`} title={`Show ${navigationTitle.toLowerCase()}`}
    onClick={() => { setMobileSessions(true); setMobileDetails(false); }}><PanelLeft aria-hidden /></Button>;
  const workspaceToggle = fullPage && workspace && <Button size="icon-sm" variant="ghost" aria-label="Workspace details" title="Workspace details"
    aria-expanded={narrowWorkspace ? mobileDetails : workspaceVisible}
    onClick={() => { if (narrowWorkspace) { setMobileDetails(v => !v); setMobileSessions(false); } else setWorkspaceVisible(v => !v); }}><PanelRight aria-hidden /></Button>;

  return (
    <div className={`harness-conversation flex h-full min-h-0 min-w-0 flex-col overflow-hidden ${review ? "harness-review-active" : ""}`}>
      {fullPage && inventory.error && <p role="alert" className="border-b px-4 py-2 text-sm text-destructive-foreground">{inventory.error}</p>}
      <div ref={columnsRef} className="flex min-h-0 min-w-0 flex-1">
      {fullPage && <div inert={workspaceModal} style={{ "--navigation-width": `${columns.widths.navigation}px` } as CSSProperties} className={`${review ? "hidden" : mobileSessions ? "block md:block" : "hidden md:block"} relative w-full shrink-0 border-r md:w-[var(--navigation-width)]`}><DevelopmentNavigation sessions={listedSessions} activeId={session?.id} activeWorkspaceId={workspace?.id} workspaces={inventory.workspaces}
        createAppAction={createAppAction} onRefresh={inventory.refresh} onClose={() => setMobileSessions(false)} onWorkspace={pickWorkspace} onNew={() => { setMobileSessions(false); void startNew(); }} onPick={pickSession} onDelete={remove} />
        <ColumnResizeHandle label={`Resize ${navigationTitle.toLowerCase()} list`} side="right" className="hidden md:block"
          width={columns.widths.navigation} min={COLUMN_MIN.navigation} max={columns.maximum.navigation} defaultWidth={COLUMN_DEFAULTS.navigation}
          onResize={width => columns.resize("navigation", width)} />
      </div>}
      <main ref={conversationRef} tabIndex={-1} inert={workspaceModal} className={`${review ? "hidden" : fullPage && mobileSessions ? "hidden md:flex" : "flex"} min-h-0 min-w-0 flex-1 flex-col`}>

      {fullPage && (!chatVisible || !session) && <div className={`shrink-0 items-center gap-2 border-b px-3 py-2 ${workspace ? "flex" : "flex md:hidden"}`}>{navigationToggle}<div className="ml-auto">{workspaceToggle}</div></div>}
      {fullPage && (!chatVisible || !session) ? <div className="min-h-0 flex-1" aria-label="Workspace center">
        {!workspace && <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
          <p>Choose a workspace or session, or create an app.</p>
          <Button variant="outline" disabled={!ready} onClick={() => void startNew()}>New session</Button>
        </div>}
        {workspace && <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
          <p>No accessible chats in this workspace.</p>
          <Button variant="outline" disabled={workspaceActions.busy || workspaceActions.retry || !workspace.participation || !workflowIsActive(workspace.workflow)} onClick={() => void workspaceActions.command("new")}>New session in workspace</Button>
        </div>}
        {error && <p role="alert" className="p-3 text-sm text-destructive-foreground">{error}</p>}
      </div> : <div id="workspace-chat" role="region" aria-label={session?.title || "Session conversation"} className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap shrink-0 items-center gap-2 border-b px-3 py-2">
        {navigationToggle}
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
              {status !== "idle" && <StatusBadge value={status} />}
              {composerBlocked && (running || stopping) && <Button type="button" variant="ghost" size="icon-sm" disabled={sending || stopping} onClick={() => void stop()} aria-label="Stop" title="Stop response">
                {sending || stopping ? <Loader2 className="motion-safe:animate-spin" /> : <Square className="fill-current" />}
              </Button>}
              {session && <SessionExecutionIndicator executionMode={session.executionMode} />}
              {workspaceToggle}
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
                    const destination = "/chats";
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
      {!showSessions && !historyLoading && pendingDecision && <div className="flex shrink-0 items-center gap-2 border-b border-warning-foreground/25 bg-warning-soft px-3 py-2 text-sm text-warning-foreground"><Diamond className="size-4 shrink-0" /><span className="min-w-0 flex-1">Needs you · {pendingDecision.type === "approval_request" ? "Approval requested" : "Answer requested"}</span><Button size="sm" variant="outline" onClick={() => { decisionCard.current?.scrollIntoView({ block: "center", behavior: "instant" }); decisionCard.current?.focus(); }}>Review</Button></div>}

      {!showSessions && session && <SessionCredentials key={`credentials-${session.id}`} sessionId={session.id} />}
      {!fullPage && !showSessions && session && <SessionSandboxes key={`sandbox-${session.id}`} sessionId={session.id} />}
      {!fullPage && !showSessions && session && <SessionWorkspaces key={`workspaces-${session.id}`} session={session} running={running} />}
      {error && <div className="shrink-0 p-3" role="alert"><InlineError message={error} /></div>}
      {session && (session.workerRun || session.workerRecovery?.state === "pending") && <SessionExecutionRecovery key={session.id}
        sessionId={session.id} refreshKey={`${session.workerRun?.id ?? ""}:${status}:${error ?? ""}`} onRecovered={async () => {
          const current = await getSession(session.id);
          if (activeSessionId.current === session.id) { onSessionChange(current); setStatus(current.status); setError(null); }
        }} />}



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
          {historyLoading ? <div role="status" aria-label="Loading conversation history" className="flex min-h-0 flex-1 items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
            {connection === "reconnecting" ? "Reconnecting to conversation…" : "Loading conversation history…"}
          </div> : <MessageScrollerProvider key={session?.id ?? "connecting"} autoScroll>
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
                      <ToolActivity events={item.events} appNames={appNames} reviewContext={transcriptReviewContext} commandResults={item.commandResults} toolResults={item.toolResults} approvals={item.approvals} />
                    </MessageScrollerItem>
                  ) : (
                    <MessageScrollerItem key={item.key} messageId={item.key}>
                    <div ref={item.event === pendingDecision ? decisionCard : undefined} tabIndex={item.event === pendingDecision ? -1 : undefined}>
                    <TranscriptEvent
                      event={item.event}
                      appNames={appNames}
                      attachments={attachmentIndex}
                      feedbackCard={feedbackCardForEvent(item.event, feedbackTranscript.cards)}
                      feedbackLoading={feedbackTranscript.loading}
                      reviewContext={transcriptReviewContext}
                      decision={item.event.type === "approval_request" ? decidedApprovals.get(String(item.event.approvalId)) ?? null : null}
                      questionCancelled={item.event.type === "question_request" && cancelledQuestionIds.has(String(item.event.questionId))}
                      answers={item.event.type === "question_request" ? answeredQuestions.get(String(item.event.questionId)) ?? null : null}
                      // Absent reads as "cannot": a reason box on a harness whose decline carries nothing
                      // would promise delivery the gateway then refuses.
                      denyReason={health?.capabilities?.denyReason === true}
                      onDecide={decide}
                      onAnswer={answer}
                      suggestions={{ cards: suggestions.cards, canInsert: !!queueSnapshot && !input && !pending.length && !uploaded.length && !editing,
                        actionable: !!queueSnapshot && connection === "connected" && !composerBlocked, busy: suggestions.acting,
                        tabHint: !!visibleSuggestion, onSelect: id => void suggestions.select(id), onDismiss: id => void suggestions.dismiss(id) }}
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
          </MessageScrollerProvider>}

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
            <MessageQueue queue={queueSnapshot} outbox={messageQueue.outbox} transcriptRequestIds={transcriptRequestIds} busy={messageQueue.busy} viewId={viewId}
              editingId={editing?.entryId} error={messageQueue.error} pendingOperation={!!queueOperation}
              legacySend={pendingSend} legacyBusy={sending} onLegacyRetry={() => void recoverSend()}
              onCommand={command => { void performQueue(command).catch(() => {}); }}
              onEdit={(entry, recover) => { void beginQueueEdit(entry, recover); }}
              onRetryLocal={id => { void messageQueue.retryLocal(id).then(accepted => {
                if (!accepted || accepted.sessionId !== activeSessionId.current) return;
                setInput(current => current === accepted.draftText ? "" : current);
                setPending(current => current.filter(file => !accepted.files.some(sent => sent.bytes === file)));
                setUploaded(current => current.filter(file => !accepted.attachments.some(sent => sent.name === file.name)));
              }).catch(cause => setError(String(cause))); }}
              onRecoverLocal={id => {
                const scope = queueScope, sessionId = session?.id;
                if (!scope || !sessionId) return;
                void messageQueue.recoverLocal(id).then(() => listPreservedDrafts(scope)).then(drafts => {
                  if (activeSessionId.current === sessionId) setPreserved({ scope, drafts });
                }).catch(cause => { if (activeSessionId.current === sessionId) setError(String(cause)); });
              }}
              onRetryOperation={() => { void retryQueueOperation(); }} onRefresh={() => { void messageQueue.refresh().catch(() => {}); }} />
            {!!savedDrafts.length && <section aria-label="Saved drafts" className="mx-3 mb-2 max-h-36 overflow-y-auto rounded-lg border px-3 py-2 text-xs">
              <p className="mb-1 text-muted-foreground">Earlier drafts were preserved while another tab changed this conversation.</p>
              {savedDrafts.map(saved => <div key={saved.id} className="flex min-w-0 items-center gap-2 py-1">
                <p className="min-w-0 flex-1 truncate">{saved.draft.text || saved.draft.files.map(file => file.name).join(", ") || "Draft attachments"}</p>
                <Button type="button" size="sm" variant="ghost" disabled={!!editing || editLocked || sending || composerBlocked}
                  onClick={() => void restorePreservedDraft(saved)}>Restore draft</Button>
              </div>)}
            </section>}
            {editing && <div className="mx-3 mb-2 flex items-center justify-between gap-2 text-xs text-muted-foreground" role="status">
              <span>Editing queued message</span><Button type="button" variant="ghost" size="sm" disabled={editSaving || messageQueue.busy} onClick={() => void finishQueueEdit(false)}>Cancel edit</Button>
            </div>}
            {suggestions.insertionError && <div className="mx-3 mb-2 text-xs" role="status">{suggestions.insertionError}
              <Button type="button" size="sm" variant="ghost" disabled={suggestions.acting || !!input || !!editing || pending.length > 0 || uploaded.length > 0} onClick={() => void suggestions.retryInsertion()}>Retry insertion</Button>
            </div>}
            <InputGroup aria-label="Message and context" className="@container/composer">
              <AppMentionInput
                ref={mentionInputRef}
                key={session?.id ?? "empty"}
                inputRef={composerRef}
                session={session}
                contextBusy={contextSaving || editLocked || providerSaving}
                onContextChange={onSessionChange}
                onBusyChange={onMentionSaving}
                value={input}
                onChange={text => { draftInteracted(); setInput(text); }}
                onCompositionStart={draftInteracted}
                onPaste={(event) => {
                  draftInteracted();
                  // Leave native paste intact for every text flavor, including HTML-only clipboards.
                  const images = takePastedImages(event.clipboardData);
                  if (images.length === 0) return;
                  setPending((current) => [...current, ...images]);
                }}
                onKeyDown={(event) => {
                  if (visibleSuggestion && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                    if (event.key === "Escape") { event.preventDefault(); void suggestions.dismiss(visibleSuggestion.suggestionId); return; }
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
                disabled={!session || editLocked}
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
                  draftInteracted();
                  setPending((current) => [...current, ...chosen]);
                }}
              />
              <InputGroupAddon align="block-end" className="flex-col items-stretch gap-2 px-2">
                {(pending.length > 0 || uploaded.length > 0) && (
                  <div className="flex max-h-48 shrink-0 flex-col gap-2 overflow-y-auto pb-2" aria-label="Attachments to send">
                    {uploaded.map((attachment) => (
                      <ChatAttachment key={`stored-${attachment.name}`} name={attachment.displayName ?? queueFileLabel(attachment.name)} size={attachment.size}
                        description="Uploaded · ready to send" disabled={editLocked} onRemove={() => {
                          draftInteracted();
                          const remaining = uploaded.filter(item => item.name !== attachment.name);
                          setUploaded(remaining);
                          if (session && !editing) writeDraftAttachments(session.id, remaining);
                        }} />
                    ))}
                    {pending.map((file, index) => (
                      <ChatAttachment key={`${file.name}-${index}`} name={file.name} size={file.size} file={file}
                        state="idle" description="Ready to upload" disabled={editLocked}
                        onRemove={() => { draftInteracted(); setPending(current => current.filter((_, i) => i !== index)); }} />
                    ))}
                  </div>
                )}
                <div className={cn("flex items-center gap-0.5",
                  "@max-[640px]/composer:[&_:is([data-slot=provider-usage],[data-slot=context-usage])]:h-6 @max-[640px]/composer:[&_:is([data-slot=provider-usage],[data-slot=context-usage])]:min-w-6",
                  "@max-[640px]/composer:[&_:is([data-slot=provider-usage],[data-slot=context-usage])]:gap-0.5 @max-[640px]/composer:[&_:is([data-slot=provider-usage],[data-slot=context-usage])]:px-0",
                  "@max-[640px]/composer:[&_[data-slot=usage-ring]]:size-5 @max-[640px]/composer:[&_[data-slot=usage-ring]>svg]:size-5 @max-[640px]/composer:[&_.font-mono]:text-[11px]",
                  "@max-[640px]/composer:[&_[data-slot=speech-input]]:gap-0.5 @max-[640px]/composer:[&_[data-speech-control]]:size-6 @max-[640px]/composer:[&_[data-speech-control]]:p-0",
                  "@max-[640px]/composer:[&_[data-slot=speech-input]_[data-speech-provider]]:size-6 @max-[640px]/composer:[&_[data-speech-provider]]:justify-center @max-[640px]/composer:[&_[data-speech-provider]]:gap-0 @max-[640px]/composer:[&_[data-speech-provider]]:px-0 @max-[640px]/composer:[&_[data-speech-provider]_[data-slot=select-value]]:sr-only",
                  "@max-[640px]/composer:[&_[data-slot=speech-status]]:h-6 @max-[640px]/composer:[&_[data-slot=speech-status]]:w-4 @max-[640px]/composer:[&_[data-speech-meter]]:gap-[1.5px] @max-[640px]/composer:[&_[data-speech-bar]]:w-0.5")}
                  role="group" aria-label="Message actions">
                  <div className="flex min-w-0 flex-1 items-center gap-0.5">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button ref={addButtonRef} type="button" size="icon" variant="ghost" className="@max-[640px]/composer:size-6" disabled={!session || editLocked || mentionSaving || providerSaving} aria-label="Add to message"><Plus /></Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent side="top" align="start" onCloseAutoFocus={event => {
                        if (openContextAfterMenu.current) {
                          event.preventDefault(); openContextAfterMenu.current = false;
                          contextPickerRef.current?.open();
                        }
                      }}>
                        <DropdownMenuGroup>
                          <DropdownMenuItem disabled={contextSaving} onSelect={() => { openContextAfterMenu.current = true; }}><Blocks />Add app context</DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => { draftInteracted(); fileInputRef.current?.click(); }}><Paperclip />Attach files</DropdownMenuItem>
                          <DropdownMenuCheckboxItem checked={suggestions.preference?.enabled ?? false} disabled={!suggestions.preference || suggestions.saving}
                            onCheckedChange={() => void suggestions.toggle()}>Prompt suggestions</DropdownMenuCheckboxItem>
                          {(suggestions.error || suggestions.availability === "unsupported" || suggestions.availability === "unavailable") &&
                            <p className="max-w-64 px-2 py-1 text-xs text-muted-foreground">{suggestions.error ?? (suggestions.availability === "unsupported"
                              ? "This provider version does not support suggestions." : "No suggestion is available for this connection and turn.")}</p>}
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <div className="contents @max-[640px]/composer:[&_button]:size-6 @max-[640px]/composer:[&_button]:min-w-6 @max-[640px]/composer:[&_button]:p-0 @max-[640px]/composer:[&_button>span:not(.sr-only)]:hidden">
                    {session && <SessionAgentSettings key={`agent:${session.id}`}
                      session={{ ...session, status }} busy={sending || stopping || !!pendingSend || sendRecoveryBlocked || mentionSaving || contextSaving || providerSaving}
                      onSavingChange={onProviderSaving} onNoticeChange={setAgentNotice} onChange={record => {
                        onSessionChange(record);
                        void getHealth(record.id).then(value => { if (activeSessionId.current === record.id) setHealth(value); }).catch(() => {});
                      }} />}
                    {session && <SessionAutonomy key={`autonomy:${session.id}`} session={{ ...session, status }} busy={sending || stopping || mentionSaving || contextSaving || providerSaving}
                      onSavingChange={onProviderSaving} onChange={onSessionChange} onErrorChange={setAutonomyNotice} />}
                    </div>
                    {session?.connectionId && <ProviderUsageIndicator key={session.connectionId + ":" + session.connectionRevision} connectionId={session.connectionId} revision={session.connectionRevision} model={session.executionSelection?.model} />}
                    {session && <ContextUsageIndicator key={`context:${session.id}`} usage={contextUsage.sessionId === session.id ? contextUsage.usage : null} connected={connection === "connected"} mcpActivity={mcpActivity} onDetailOpenChange={setContextDetailsOpen} />}
                  </div>
                  {session && <SpeechInput key={`${session.id}:${editing?.reservationId ?? "draft"}:${composerEpoch}`} onStart={draftInteracted} disabled={editLocked} onText={text => { draftInteracted(); setInput(current => current ? `${current}${/\s$/.test(current) ? "" : " "}${text}` : text); }} />}
                  {(running || stopping) && <Button type="button" size="icon" variant="ghost" className="shrink-0 @max-[640px]/composer:size-8" disabled={stopping} onClick={() => void stop()} aria-label="Stop" title="Stop response">
                    {stopping ? <Loader2 className="motion-safe:animate-spin" /> : <Square className="fill-current" />}
                  </Button>}
                  <Button type="submit" size="icon" className="shrink-0 @max-[640px]/composer:size-8" disabled={!session || editLocked || sending || !!pendingSend || sendRecoveryBlocked || providerSaving || contextSaving || mentionSaving || !queueSnapshot || messageQueue.outbox.some(row => row.durable === false) || !hasMessageContent(input, pending.length, uploaded.length)} aria-label={editing ? "Save queued message" : "Send"} title={editing ? "Save queued message" : running ? "Add to queue" : "Send"}>
                    {sending ? <Loader2 className="motion-safe:animate-spin" /> : <Send />}
                  </Button>
                </div>
                {agentNotice?.sessionId === session?.id && agentNotice?.text && <p role="alert" className="text-xs text-destructive-foreground wrap-anywhere">{agentNotice.text}</p>}
                {autonomyNotice?.sessionId === session?.id && autonomyNotice?.text && <p role="alert" className="text-xs text-destructive-foreground wrap-anywhere">{autonomyNotice.text}</p>}
              </InputGroupAddon>
            </InputGroup>
          </form>
          </>}
        </>
      )}
      </div>}
      </main>
      {fullPage && workspace && <RetainedWorkspacePane narrow={narrowWorkspace} width={columns.widths.details} resizeHandle={<ColumnResizeHandle label="Resize workspace details" side="left" width={columns.widths.details} min={COLUMN_MIN.details} max={columns.maximum.details} defaultWidth={COLUMN_DEFAULTS.details} onResize={width => columns.resize("details", width)} />} open={mobileDetails} visible={workspaceVisible} reviewing={!!review} onClose={() => setMobileDetails(false)}>
        <WorkspaceDetails onSessionPicked={id => pickSession({ id })} onDeleteSession={remove} sessionActions={workspaceActions} key={workspace.id} workspace={workspace} onSessionSelected={record => { setSessions(current => [record, ...current.filter(s => s.id !== record.id)]); pickSession(record); }} appMetadata={appIconMetadata} title={workspace.name || session?.title || "Workspace"} sessionId={session?.id} running={running} refresh={inventory.refresh} deleteConversation={session ? () => remove(session.id) : undefined} onReview={(tree, choice) => openReview(workspace.id, tree, session?.id, choice)} />
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
