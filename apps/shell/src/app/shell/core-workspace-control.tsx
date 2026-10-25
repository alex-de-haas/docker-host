"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Boxes, Check, ChevronDown, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CoreRequestError, coreErrorCode, readCoreError, readCoreErrorDetail, redirectToCoreLoginIfAuthRequired, isAuthRequiredRedirectError } from "./core-api";
import { useShellActions, useShellState } from "./shell-context";
import { fetchCore } from "./core-transport.js";
import type { CoreDevelopment, CoreLaunch } from "./core-development";
import type { ActivationWorkspace, WorkspaceSource } from "./workspace-sources";
import { HostyLoader } from "../../../../../shared/web/hosty-states";
import { CheckboxRow, InlineError } from "./ui";

type Selection = { coreSelected: boolean; coreWorktreeId?: string | null; apps: { appId: string; selected: boolean; worktreeId?: string | null; runtime?: string | null }[] };
type Participant = { id: string; kind: string; selected: boolean; worktreeId?: string | null; worktreeOptions?: string[]; sourcePath?: string | null; branch?: string | null; commit?: string | null; changedFiles?: number | null; unavailable?: string | null; targetRuntime?: string | null };
type Review = { plan: { coreInstance: string; coreSourceRevision?: string; participants: Participant[] }; planDigest: string; consequences: string[] };
type Activation = { id: string; workspaceId?: string; coreWorktreeId?: string | null; replacesCoreActivationId?: string | null; activatedCore?: CoreLaunch | null; coreReturnTarget?: { launch: CoreLaunch } | null; phase: string; coreProject?: string | null; coreReturned?: boolean; previousCore?: { mode: string; projectPath?: string | null }; preparationReleased?: boolean; error?: string | null; returns?: { request: { requestId: string }; state: string }[] };
type Retained = { workspaceId: string; activation: Activation };
type Detail = { status: { activation: Activation; helper?: { state: string; error?: string | null; logPath?: string | null }; cancellationRequested?: boolean }; children?: { appId: string; phase: string; error?: string | null }[] };
type Target = { kind: "release" } | { kind: "workspace"; workspaceId: string; worktreeId: string; label: string };
type Candidate = { target: Extract<Target, { kind: "workspace" }>; unavailable?: string; current: boolean };
type CoreExecutionTargets = { targets: { workspaceId: string; worktreeId: string; label: string; projectPath: string | null; unavailable?: string | null }[]; activations: Retained[] };
type Pending = { kind: "apply" | "return" | "resume" | "cancel"; workspaceId: string; body: Record<string, unknown> };
type ReleaseStage = { fromInstance: string; operationId?: string; status?: string; error?: string };
type Recovery = { release?: ReleaseStage; expectedCoreProject?: string; target: Target | null; workspaceId: string; activationId: string; pending?: Pending | null; originalApply?: Pending | null };
export type CoreWorkspaceControlProps = {
  coreOrigin: string; state: CoreDevelopment | null; workspaces: ActivationWorkspace[]; workspace?: WorkspaceSource;
  disabled: boolean; onRelease: (signal: AbortSignal) => Promise<string>; menu?: boolean;
};
const terminal = (a: Activation) => a.phase === "returned" || a.phase === "cancelled";
const ownsCore = (a: Activation) => !!a.coreProject && !a.coreReturned && !terminal(a);
const pathKey = (value?: string | null) => {
  const path = value?.replaceAll("\\", "/").replace(/\/+$/, "") ?? "";
  return /^[a-z]:\//i.test(path) ? path.toLowerCase() : path;
};
class ActivationError extends Error {
  constructor(message: string, readonly code: string | null, readonly status: number) { super(message); }
}
function onlyCore(review: Review, worktreeId: string): Selection {
  return { coreSelected: true, coreWorktreeId: worktreeId,
    apps: review.plan.participants.filter(row => row.kind === "app").map(row => ({ appId: row.id, selected: false, worktreeId: row.worktreeId, runtime: row.targetRuntime })) };
}
function requireCoreReview(review: Review, selection: Selection) {
  const selected = review.plan.participants.filter(row => row.selected);
  if (!review.planDigest || selected.length !== 1 || selected[0].kind !== "core" || selected[0].worktreeId !== selection.coreWorktreeId || selected[0].unavailable)
    throw new Error(review.plan.participants.find(row => row.kind === "core")?.unavailable || "Core did not approve a Core-only selection. Reopen the runtime menu to refresh the workspace choices.");
}
function matchesTarget(activation: Activation, entry: Recovery, state: CoreDevelopment | null) {
  const target = entry.target;
  return target?.kind === "workspace" && entry.workspaceId === target.workspaceId && activation.workspaceId === target.workspaceId &&
    activation.coreWorktreeId === target.worktreeId && !!activation.coreProject &&
    (!entry.expectedCoreProject || pathKey(entry.expectedCoreProject) === pathKey(activation.coreProject)) &&
    state?.launch.mode === "dev" && pathKey(activation.coreProject) === pathKey(state.launch.projectPath) &&
    activation.activatedCore?.mode === state.launch.mode && pathKey(activation.activatedCore.projectPath) === pathKey(state.launch.projectPath) &&
    pathKey(activation.activatedCore.generationPath) === pathKey(state.launch.generationPath) &&
    activation.activatedCore.processId === state.launch.processId && activation.activatedCore.startedAt === state.launch.startedAt;
}
function readRecovery(key: string): Recovery | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as Recovery | null;
    if (!value || typeof value.workspaceId !== "string" || typeof value.activationId !== "string") return null;
    if (value.target && value.target.kind !== "release" && value.target.kind !== "workspace") return null;
    return value;
  } catch { return null; }
}

/** Mounted by CoreSection, outside its transient More menu. Closing a menu never loses recovery. */
export function useCoreWorkspaceControl({ coreOrigin, state, workspaces, workspace, disabled, onRelease, menu = false }: CoreWorkspaceControlProps) {
  const { sendCsrfJson } = useShellActions();
  const { activeUser } = useShellState();
  const storageKey = "hosty:core-workspace:" + coreOrigin + ":" + (activeUser?.id ?? "signed-out") + ":v1";
  const [stored, setStored] = useState(() => ({ key: storageKey, value: readRecovery(storageKey) }));
  const recovery = stored.key === storageKey ? stored.value : null;
  const recoveryRef = useRef(recovery);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<Target | null>(recovery?.target ?? null);
  const [reviewState, setReview] = useState<{ value: Review; selection: Selection; repair?: boolean } | null>(null);
  const review = reviewState && reviewState.value.plan.coreInstance === state?.instance &&
    (!reviewState.value.plan.coreSourceRevision || reviewState.value.plan.coreSourceRevision === state?.source.revision) ? reviewState : null;
  const [retained, setRetained] = useState<Retained[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [inventoryReady, setInventoryReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const [completion, setCompletion] = useState("");
  const [repairing, setRepairing] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [accept, setAccept] = useState(false);
  const [statusRevision, setStatusRevision] = useState(0);
  const [statusFailures, setStatusFailures] = useState(0);
  const executing = useRef(false);
  const loadingInventory = useRef(false);
  const successfulStatusReads = useRef(0);
  const submenuTrigger = useRef<HTMLDivElement>(null);
  const [submenuOffset, setSubmenuOffset] = useState(0);
  const positionSubmenu = useCallback(() => {
    const trigger = submenuTrigger.current;
    // On phones the submenu overlaps its parent so a wide workspace name
    // remains inside the viewport instead of extending beyond its left edge.
    setSubmenuOffset(window.innerWidth < 768 && trigger
      ? Math.min(0, trigger.getBoundingClientRect().left - (window.innerWidth - 16)) : 0);
  }, []);
  useEffect(() => {
    window.addEventListener("resize", positionSubmenu);
    return () => window.removeEventListener("resize", positionSubmenu);
  }, [positionSubmenu]);
  const lifetime = useRef<AbortController | null>(null);
  if (stored.key !== storageKey) {
    setStored({ key: storageKey, value: readRecovery(storageKey) });
    setBusy(false); setReviewing(false); setLoading(false); setStatusFailures(0); setError(""); setErrorCode(null); setErrorStatus(null); setCompletion(""); setRepairing(false);
    setNotice(""); setOpen(false); setTarget(null); setReview(null); setDetail(null); setRetained([]); setCandidates([]); setInventoryReady(false);
  }
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    recoveryRef.current = readRecovery(storageKey);
    executing.current = false; loadingInventory.current = false;
    return () => controller.abort();
  }, [storageKey]);
  const remember = useCallback((value: Recovery | null) => {
    if (lifetime.current?.signal.aborted) return;
    recoveryRef.current = value;
    setStored({ key: storageKey, value });
    try { if (value) localStorage.setItem(storageKey, JSON.stringify(value)); else localStorage.removeItem(storageKey); } catch { /* The in-memory request remains available. */ }
  }, [storageKey]);
  useEffect(() => { recoveryRef.current = recovery; }, [recovery]);
  const request = useCallback(async <T,>(workspaceId: string, kind: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
    if (signal?.aborted) throw new DOMException("The request was cancelled.", "AbortError");
    const response = await sendCsrfJson(coreOrigin + "/api/development/workspaces/" + encodeURIComponent(workspaceId) + "/activation/" + kind, body, "POST", signal);
    if (signal?.aborted) throw new DOMException("The request was cancelled.", "AbortError");
    redirectToCoreLoginIfAuthRequired(response, coreOrigin);
    if (!response.ok) { const detail = await readCoreErrorDetail(response); throw new ActivationError(detail.message, detail.code, response.status); }
    const payload = await response.json() as T;
    if (signal?.aborted) throw new DOMException("The request was cancelled.", "AbortError");
    return payload;
  }, [coreOrigin, sendCsrfJson]);

  const loadInventory = useCallback(async () => {
    if (loadingInventory.current || !state?.manageable || !activeUser?.id) return;
    const scope = lifetime.current;
    if (!scope || scope.signal.aborted) return;
    loadingInventory.current = true; setLoading(true); setInventoryReady(false); setCatalogError("");
    const signal = scope.signal;
    try {
      // Listing needs metadata, not a full activation review for every workspace.
      // The selected destination still receives a fresh authoritative review before apply.
      const response = await fetchCore(coreOrigin + "/api/core/execution-targets", { credentials: "include", signal });
      if (signal.aborted) return;
      redirectToCoreLoginIfAuthRequired(response, coreOrigin);
      if (!response.ok) throw new Error(await readCoreError(response));
      const catalog = await response.json() as CoreExecutionTargets;
      if (signal.aborted) return;
      const rows: Candidate[] = catalog.targets.map(item => ({
        target: { kind: "workspace", workspaceId: item.workspaceId, worktreeId: item.worktreeId, label: item.label },
        unavailable: item.unavailable ?? undefined,
        current: state.launch.mode === "dev" && !!item.projectPath && pathKey(state.launch.projectPath) === pathKey(item.projectPath),
      }));
      setCandidates(rows);
      setRetained(catalog.activations.filter(row => ownsCore(row.activation)));
      setInventoryReady(true);
      return catalog;
    } catch (cause) {
      if (!signal?.aborted && !isAuthRequiredRedirectError(cause)) setCatalogError(cause instanceof Error ? cause.message : "Core workspace choices are unavailable.");
    } finally { if (lifetime.current === scope) { loadingInventory.current = false; if (!signal.aborted) setLoading(false); } }
  }, [activeUser?.id, coreOrigin, state]);

  const inspect = useCallback(async (entry: Recovery, signal = lifetime.current?.signal) => {
    const value = await request<Detail>(entry.workspaceId, "status", { activationId: entry.activationId }, signal);
    if (signal?.aborted) return;
    successfulStatusReads.current += 1;
    setDetail(value); setError(""); setErrorCode(null); setErrorStatus(null); setStatusFailures(0);
    const activation = value.status.activation;
    setRetained(previous => {
      const others = previous.filter(row => row.activation.id !== activation.id && (activation.phase !== "active" || row.activation.id !== activation.replacesCoreActivationId));
      return ownsCore(activation) ? [...others, { workspaceId: entry.workspaceId, activation }] : others;
    });
    if (entry.pending && (entry.pending.kind === "apply" && activation.id === entry.activationId ||
        entry.pending.kind === "return" && activation.returns?.some(receipt => receipt.request.requestId === (entry.pending!.body.return as { requestId?: string })?.requestId) ||
        entry.pending.kind === "resume" && value.status.helper && ["accepted", "running", "completed"].includes(value.status.helper.state) ||
        entry.pending.kind === "cancel" && value.status.cancellationRequested)) {
      remember({ ...entry, pending: null });
    }
    return value;
  }, [remember, request]);
  const observed = recovery && detail?.status.activation.id === recovery.activationId ? detail.status.activation : null;
  const helper = observed ? detail?.status.helper : null;
  const awaitingLaunch = !!recovery?.originalApply && observed?.phase === "active" && !observed.coreReturned && !matchesTarget(observed, recovery, state);
  const awaitingReleaseReturn = recovery?.target?.kind === "release" && !!observed?.coreReturned && (observed.coreReturnTarget?.launch ?? observed.previousCore)?.mode === "release" && state?.launch.mode !== "release";
  const transition = !!recovery && (!!recovery.release && !["failed", "completed"].includes(recovery.release.status ?? "") || !!recovery.pending || !observed && !recovery.release || awaitingLaunch || awaitingReleaseReturn || !!observed && !terminal(observed) && observed.phase !== "active" && !["failed", "paused"].includes(helper?.state ?? ""));
  const recoveryIdentity = recovery && !recovery.release ? recovery.workspaceId + ":" + recovery.activationId : "";
  const pendingIdentity = JSON.stringify(recovery?.pending ?? null);
  useEffect(() => {
    if (!recoveryIdentity) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>; let reading = false;
    const poll = async () => {
      if (controller.signal.aborted || reading || executing.current || document.visibilityState === "hidden") return;
      reading = true;
      try { await inspect(recoveryRef.current!, controller.signal); }
      catch (cause) {
        if (!controller.signal.aborted && !isAuthRequiredRedirectError(cause)) {
          setStatusFailures(value => value + 1);
          setErrorCode(cause instanceof ActivationError ? cause.code : coreErrorCode(cause));
          setErrorStatus(cause instanceof ActivationError || cause instanceof CoreRequestError ? cause.status : null);
          setError("Core status could not be confirmed. The original request is retained. " + (cause instanceof Error ? cause.message : ""));
        }
      }
      finally { reading = false; if (!controller.signal.aborted && transition) timer = setTimeout(() => void poll(), 3000); }
    };
    const visible = () => { if (document.visibilityState === "visible") void poll(); };
    document.addEventListener("visibilitychange", visible); void poll();
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [inspect, recoveryIdentity, pendingIdentity, transition, statusRevision]);

  const run = async (pending: Pending, entry: Recovery) => {
    const scope = lifetime.current;
    if (executing.current || disabled || !state?.manageable || !activeUser?.id || !scope || scope.signal.aborted) return;
    executing.current = true; setBusy(true); setNotice(""); setStatusFailures(0); setError(""); setErrorCode(null); setErrorStatus(null);
    const original = { ...entry, pending, originalApply: pending.kind === "apply" ? pending : entry.originalApply };
    remember(original);
    try {
      await request<unknown>(pending.workspaceId, pending.kind, pending.body, scope.signal);
      if (scope.signal.aborted) return;
      remember({ ...original, pending: null });
      await inspect({ ...original, pending: null }, scope.signal);
    } catch (cause) {
      if (!scope.signal.aborted && !isAuthRequiredRedirectError(cause)) {
        setErrorCode(cause instanceof ActivationError ? cause.code : coreErrorCode(cause));
        setErrorStatus(cause instanceof ActivationError || cause instanceof CoreRequestError ? cause.status : null);
        setError("The operation could not be confirmed. Its original request is retained. " + (cause instanceof Error ? cause.message : ""));
      }
    } finally { if (lifetime.current === scope) { executing.current = false; if (!scope.signal.aborted) { setBusy(false); setStatusRevision(value => value + 1); } } }
  };
  const prepareReview = async (next: Target, repair?: Pending) => {
    const scope = lifetime.current;
    if (executing.current || !scope || scope.signal.aborted) return;
    setNotice(""); setError(""); setErrorCode(null); setErrorStatus(null); setCompletion(""); setReview(null); setRepairing(!!repair); setTarget(next); setAccept(false); setOpen(true);
    if (next.kind === "release") return;
    executing.current = true; setBusy(true); setReviewing(true);
    try {
      let selection: Selection;
      if (repair) selection = repair.body.selection as Selection;
      else {
        const initial = await request<Review>(next.workspaceId, "plan", { selection: { coreSelected: false } }, scope.signal);
        selection = onlyCore(initial, next.worktreeId);
      }
      const value = await request<Review>(next.workspaceId, "plan", { selection }, scope.signal);
      requireCoreReview(value, selection);
      if (!scope.signal.aborted) setReview({ value, selection, repair: !!repair });
    } catch (cause) { if (!scope.signal.aborted && !isAuthRequiredRedirectError(cause)) setError(cause instanceof Error ? cause.message : "Core selection is unavailable."); }
    finally { if (lifetime.current === scope) { executing.current = false; if (!scope.signal.aborted) { setBusy(false); setReviewing(false); } } }
  };
  const selectedActive = recovery && observed && ownsCore(observed) ? { workspaceId: recovery.workspaceId, activation: observed }
    : retained.length === 1 ? retained[0] : null;
  const blockedByRecovery = awaitingLaunch || awaitingReleaseReturn || !!recovery?.release || !!recovery && !observed || !!recovery?.pending || !!observed && !terminal(observed) && observed.phase !== "active" && !observed.coreReturned;
  const choose = (next: Target) => {
    if (disabled || busy || loading || blockedByRecovery || !inventoryReady || retained.length > 1) return;
    setDetail(null);
    if (selectedActive) {
      const entry = { workspaceId: selectedActive.workspaceId, activationId: selectedActive.activation.id, target: next };
      remember(entry); setDetail({ status: { activation: selectedActive.activation } });
    } else if (!recovery?.pending) remember(null);
    if (selectedActive && next.kind === "release") { setNotice(""); setTarget(next); setReview(null); setRepairing(false); setAccept(false); setError(""); setErrorCode(null); setErrorStatus(null); setCompletion(""); setOpen(true); }
    else void prepareReview(next);
  };
  const apply = () => {
    if (disabled || !state?.manageable || !activeUser?.id || !target || target.kind !== "workspace" || !review || blockedByRecovery) return;
    const pending: Pending = { kind: "apply", workspaceId: target.workspaceId,
      body: { requestId: crypto.randomUUID(), selection: review.selection, planDigest: review.value.planDigest } };
    const entry: Recovery = { target, workspaceId: target.workspaceId, activationId: String(pending.body.requestId), originalApply: pending,
      expectedCoreProject: review.value.plan.participants.find(row => row.kind === "core")?.sourcePath ?? undefined };
    void run(pending, entry);
  };
  const returnCore = () => {
    if (disabled || !state?.manageable || !activeUser?.id || !selectedActive || !accept || blockedByRecovery) return;
    setReview(null);
    const pending: Pending = { kind: "return", workspaceId: selectedActive.workspaceId,
      body: { activationId: selectedActive.activation.id, return: { requestId: crypto.randomUUID(), apps: [], core: true, acceptDataChanges: true } } };
    void run(pending, { ...recoveryRef.current, target, workspaceId: selectedActive.workspaceId, activationId: selectedActive.activation.id });
  };
  const release = async () => {
    const scope = lifetime.current;
    if (executing.current || disabled || !state?.manageable || !activeUser?.id || selectedActive || blockedByRecovery || !inventoryReady || !scope || scope.signal.aborted) return;
    executing.current = true; setBusy(true); setError(""); setCompletion("");
    try {
      const response = await fetchCore(coreOrigin + "/api/core/development", { credentials: "include", cache: "no-store", signal: scope.signal });
      if (scope.signal.aborted) return;
      redirectToCoreLoginIfAuthRequired(response, coreOrigin);
      if (!response.ok) throw new Error(await readCoreError(response));
      const factual = await response.json() as CoreDevelopment;
      if (scope.signal.aborted) return;
      if (factual.launch.mode === "release") { remember(null); setCompletion("Core is already running the installed Release."); return; }
      const staged: Recovery = { target: { kind: "release" }, workspaceId: recovery?.workspaceId ?? "", activationId: recovery?.activationId ?? "",
        release: { fromInstance: factual.instance } };
      remember(staged); setDetail(null);
      const operationId = await onRelease(scope.signal);
      if (!scope.signal.aborted) remember({ ...staged, release: { ...staged.release!, operationId } });
    } catch (cause) {
      if (!scope.signal.aborted && !isAuthRequiredRedirectError(cause)) setError(cause instanceof Error ? cause.message : "Release restart could not be submitted. The selection is retained.");
    } finally { if (lifetime.current === scope) { executing.current = false; if (!scope.signal.aborted) { setBusy(false); setStatusRevision(value => value + 1); } } }
  };
  const releaseIdentity = recovery?.release ? JSON.stringify(recovery.release) : "";
  useEffect(() => {
    if (!releaseIdentity) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>; let reading = false;
    const poll = async () => {
      if (controller.signal.aborted || reading || executing.current || document.visibilityState === "hidden") return;
      const entry = recoveryRef.current;
      if (!entry?.release) return;
      reading = true;
      try {
        const response = await fetchCore(coreOrigin + "/api/core/development", { credentials: "include", cache: "no-store", signal: controller.signal });
        if (controller.signal.aborted) return;
        redirectToCoreLoginIfAuthRequired(response, coreOrigin);
        if (!response.ok) { const detail = await readCoreErrorDetail(response); throw new ActivationError(detail.message, detail.code, response.status); }
        const factual = await response.json() as CoreDevelopment;
        if (controller.signal.aborted) return;
        if (factual.launch.mode === "release" && factual.instance !== entry.release.fromInstance) {
          remember(null); setCompletion("Installed Release readiness is confirmed."); setError(""); return;
        }
        const operationId = entry.release.operationId || sessionStorage.getItem("hosty:core-operation:" + coreOrigin) || undefined;
        if (operationId && !entry.release.operationId) remember({ ...entry, release: { ...entry.release, operationId } });
        if (operationId) {
          const operationResponse = await fetchCore(coreOrigin + "/api/core/operations/" + encodeURIComponent(operationId), { credentials: "include", cache: "no-store", signal: controller.signal });
          if (controller.signal.aborted) return;
          redirectToCoreLoginIfAuthRequired(operationResponse, coreOrigin);
          if (!operationResponse.ok) { const detail = await readCoreErrorDetail(operationResponse); throw new ActivationError(detail.message, detail.code, operationResponse.status); }
          const operation = await operationResponse.json() as { status: string; error?: string; logPath?: string };
          if (controller.signal.aborted) return;
          if (operation.status === "failed") {
            const message = [operation.error || "Core restart failed.", operation.logPath && "Log: " + operation.logPath].filter(Boolean).join(" ");
            remember({ ...entry, release: { ...entry.release, operationId, status: "failed", error: message } }); setError(message); return;
          }
          setErrorCode(null); setErrorStatus(null);
          if (operation.status !== "completed") { setError(""); setStatusFailures(0); }
          if (operation.status === "completed") { setStatusFailures(value => value + 1); setError("The restart completed, but the selected Release launch has not been confirmed. Check progress before choosing another target."); }
        } else { setStatusFailures(value => value + 1); setError("Release dispatch has not been confirmed. The staged selection is retained; check progress before another restart."); }
      } catch (cause) {
        if (!controller.signal.aborted && !isAuthRequiredRedirectError(cause)) {
          setStatusFailures(value => value + 1);
          setErrorCode(cause instanceof ActivationError ? cause.code : coreErrorCode(cause));
          setErrorStatus(cause instanceof ActivationError || cause instanceof CoreRequestError ? cause.status : null);
          setError("Release status could not be confirmed. Its original operation is retained. " + (cause instanceof Error ? cause.message : ""));
        }
      } finally {
        reading = false;
        if (!controller.signal.aborted && recoveryRef.current?.release && recoveryRef.current.release.status !== "failed") timer = setTimeout(() => void poll(), 3000);
      }
    };
    const visible = () => { if (document.visibilityState === "visible") void poll(); };
    document.addEventListener("visibilitychange", visible); void poll();
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [coreOrigin, releaseIdentity, remember, statusRevision]);
  const dismissMissingWorkspace = async () => {
    const scope = lifetime.current;
    const entry = recoveryRef.current;
    if (!scope || scope.signal.aborted || !entry || errorCode !== "workspace_not_found" || busy || loading) return;
    const statusReads = successfulStatusReads.current;
    const catalog = await loadInventory();
    if (scope.signal.aborted || recoveryRef.current !== entry || successfulStatusReads.current !== statusReads || !catalog) return;
    if (catalog.targets.some(item => item.workspaceId === entry.workspaceId) ||
        catalog.activations.some(item => item.workspaceId === entry.workspaceId || item.activation.id === entry.activationId)) {
      setError("Core still lists this workspace or switch. Check its progress before dismissing the saved request.");
      return;
    }
    // Only the unavailable browser journal is removed. This never cancels or replays lifecycle work.
    remember(null); setDetail(null); setTarget(null); setReview(null); setAccept(false);
    setError(""); setErrorCode(null); setErrorStatus(null); setStatusFailures(0); setCompletion("");
    setNotice("The unavailable switch was removed from this browser. Core and applications were not changed.");
  };
  const recover = (entry?: Retained) => {
    if (!entry && !recovery && retained.length === 1) entry = retained[0];
    if (entry) { const value = { workspaceId: entry.workspaceId, activationId: entry.activation.id, target: null }; remember(value); setDetail({ status: { activation: entry.activation } }); setTarget(null); }
    else setTarget(recovery?.target ?? null);
    setOpen(true); setReview(null); setAccept(false); setStatusRevision(value => value + 1);
  };
  const unavailable = disabled || !state?.manageable || !activeUser?.id;
  const activeDone = observed?.phase === "active" && !observed.coreReturned && !!recovery && matchesTarget(observed, recovery, state) &&
    target?.kind === "workspace" && target.workspaceId === recovery.workspaceId && target.worktreeId === observed.coreWorktreeId;
  const returned = !!observed?.coreReturned || !!observed && terminal(observed);
  const releaseDone = !!completion || target?.kind === "release" && returned && state?.launch.mode === "release";
  const hardStopped = !!observed?.error || ["failed", "paused"].includes(helper?.state ?? "") || recovery?.release?.status === "failed";
  const transientError = errorStatus === null ? !errorCode : errorStatus >= 500 || [408, 429].includes(errorStatus);
  const stalled = hardStopped || !!error && (!transientError || statusFailures >= 3);
  const reconnecting = !!error && transition && !stalled;
  const showingProgress = reviewing || busy || transition && !stalled;
  const needsAttention = !!recovery && stalled;
  const progressLabel = reviewing ? "Checking workspace…" : reconnecting ? "Reconnecting to Core…" : recovery?.release ? "Restarting Core…" :
    observed?.phase.startsWith("return-") || recovery?.pending?.kind === "return" ? "Returning Core…" :
    observed?.phase === "preparing" ? "Building Core…" :
    observed?.phase === "core-starting" || awaitingLaunch || awaitingReleaseReturn ? "Waiting for Core to be ready…" :
    observed?.phase === "core-stopping" || observed?.phase === "apps-active" ? "Restarting Core…" : "Preparing the switch…";
  const needsRecovery = !!recovery && (blockedByRecovery || hardStopped) || retained.length > 1 ||
    retained.some(({ activation }) => activation.phase !== "active" || !!activation.error);
  const recoveryLabel = transition && !stalled ? "Switch progress…" : "Recover Core switch…";
  const currentLabel = workspace?.label || (state?.launch.mode === "release" ? "Release" : "Current development Core");
  const items = <>
    <DropdownMenuItem disabled={unavailable || busy || loading || !inventoryReady || state?.launch.mode === "release" && !retained.length || blockedByRecovery || retained.length > 1} onSelect={() => choose({ kind: "release" })}>
      <Check className={"size-4 " + (state?.launch.mode === "release" ? "opacity-100" : "opacity-0")} />Release
    </DropdownMenuItem>
    <DropdownMenuSeparator />
    {loading && <DropdownMenuItem disabled><HostyLoader label={null} className="size-4" />Loading workspaces…</DropdownMenuItem>}
    {!loading && !candidates.length && <DropdownMenuItem disabled>No matching Core workspaces</DropdownMenuItem>}
    {candidates.map(candidate => <DropdownMenuItem key={candidate.target.workspaceId + ":" + candidate.target.worktreeId}
      disabled={unavailable || busy || loading || !inventoryReady || !!candidate.unavailable || candidate.current || blockedByRecovery || retained.length > 1}
      title={candidate.unavailable} onSelect={() => choose(candidate.target)}>
      <Check className={"size-4 " + (candidate.current ? "opacity-100" : "opacity-0")} /><span className="min-w-0 flex-1"><span className="block whitespace-normal break-words">{candidate.target.label}</span>
        {candidate.unavailable && <span className="block max-w-72 whitespace-normal text-xs text-muted-foreground">{candidate.unavailable}</span>}</span>
    </DropdownMenuItem>)}
    {catalogError && <DropdownMenuItem disabled className="max-w-80 whitespace-normal text-xs text-destructive-foreground">{catalogError}</DropdownMenuItem>}
    {needsRecovery && <><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => recover()}>{recoveryLabel}</DropdownMenuItem></>}
  </>;
  const control = menu ? <DropdownMenuSub onOpenChange={value => { if (value) { positionSubmenu(); void loadInventory(); } }}>
    <DropdownMenuSubTrigger ref={submenuTrigger} disabled={unavailable && !recovery} aria-label="Switch runtime for Hosty Core" title={!state ? "Core launch information is unavailable." : !state.manageable ? state.launch.mode === "unmanaged" ? "Core was started outside the Hosty CLI. Start it through Hosty to select a workspace." : "The Hosty CLI is unavailable. Restore CLI access to select a workspace." : undefined}><Boxes />Runtime / workspace</DropdownMenuSubTrigger>
    <DropdownMenuSubContent sideOffset={submenuOffset} className="h-80 w-80 max-h-(--radix-dropdown-menu-content-available-height) max-w-[calc(100vw-2rem)] overflow-y-auto">{items}</DropdownMenuSubContent>
  </DropdownMenuSub> : <DropdownMenu onOpenChange={value => { if (value) void loadInventory(); }}>
    <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="sm" disabled={unavailable && !recovery} title={!state ? "Core launch information is unavailable." : !state.manageable ? "The Core launch is unmanaged or the Hosty CLI is unavailable." : undefined} aria-label="Switch runtime for Hosty Core">Runtime / workspace<ChevronDown className="size-4" /></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="h-80 w-80 max-h-(--radix-dropdown-menu-content-available-height) max-w-[calc(100vw-2rem)] overflow-y-auto">{items}</DropdownMenuContent>
  </DropdownMenu>;
  const dialog = <Dialog open={open} onOpenChange={setOpen}><DialogContent className="sm:max-w-xl">
    <DialogHeader><DialogTitle>Switch Core runtime</DialogTitle><DialogDescription>Core restarts briefly. Applications keep their selected runtimes and current data.</DialogDescription></DialogHeader>
    <DialogBody className="space-y-4 text-sm">
      <div className="flex min-w-0 items-center gap-3 rounded-lg border p-3" aria-label="Core switch selection">
        <span className="min-w-0 flex-1"><span className="block text-xs text-muted-foreground">Current Core</span><span className="block break-words font-medium">{currentLabel}</span></span>
        {target && <><ArrowRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block text-xs text-muted-foreground">Switch to</span><span className="block break-words font-medium">{target.kind === "release" ? "Release" : target.label}</span></span></>}
      </div>
      {error && !reconnecting && <InlineError message={error} />}
      {notice && <p role="status">{notice}</p>}
      {catalogError && <InlineError message={catalogError} />}
      {showingProgress && <div role="status" aria-live="polite" className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3 text-info-foreground">
        <LoaderCircle aria-hidden="true" className="size-5 shrink-0 animate-spin motion-reduce:animate-none" />
        <div><p className="font-medium">{progressLabel}</p><p className="text-xs text-muted-foreground">This can take a little while. Progress updates automatically.</p></div>
      </div>}
      {!showingProgress && !activeDone && !releaseDone && <p className="text-muted-foreground">Your source files and current data are kept. Switching does not restore an earlier backup.</p>}
      {!showingProgress && !recovery && retained.length > 1 && <p>Several saved switches still own Core. Choose one to review before continuing.</p>}
      {!showingProgress && retained.length > 1 && retained.map(entry => <Button key={entry.activation.id} type="button" variant="outline" size="sm" onClick={() => recover(entry)}>Review {workspaces.find(item => item.id === entry.workspaceId)?.name || "saved workspace"}</Button>)}
      {selectedActive && target?.kind === "release" && !returned && <section className="space-y-3 rounded-lg border p-3" aria-label="Return current Core">
        <p>Return Core to the version saved before this workspace was activated{(selectedActive.activation.coreReturnTarget?.launch ?? selectedActive.activation.previousCore)?.mode === "release" ? " (Release)" : ""}.</p>
        {(selectedActive.activation.coreReturnTarget?.launch ?? selectedActive.activation.previousCore)?.mode !== "release" && <p className="text-muted-foreground">The saved version is another development Core. After it is ready, you can continue to the installed Release.</p>}
        <CheckboxRow label="I understand that the previous Core version will use the current data." checked={accept} disabled={unavailable || busy || blockedByRecovery} onChange={setAccept} />
        <Button type="button" variant="outline" disabled={unavailable || !accept || busy || blockedByRecovery} onClick={returnCore}>Return Core</Button>
      </section>}
      {recovery && !recovery.release && stalled && <section className="space-y-2 rounded-lg border p-3" aria-label="Core switch recovery">
        <p>{reconnecting ? "Core has not confirmed the switch yet. The original request is retained so you can retry safely." : "The switch needs attention. Check its progress before starting another switch."}</p>
        {[observed?.error, helper?.error].filter(Boolean).map((message, index) => <p key={index} className="break-words text-destructive-foreground">{message}</p>)}
        {helper?.logPath && <p className="break-all text-xs text-muted-foreground">Build log: {helper.logPath}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setStatusRevision(value => value + 1)}>Check progress</Button>
          {errorCode === "workspace_not_found" && <Button type="button" variant="outline" size="sm" disabled={busy || loading} onClick={() => void dismissMissingWorkspace()}>Dismiss saved switch</Button>}
          {recovery.pending && errorCode !== "workspace_not_found" && <Button type="button" variant="outline" size="sm" disabled={unavailable || busy} onClick={() => void run(recovery.pending!, recovery)}>Retry switch</Button>}
          {!recovery.pending && recovery.originalApply && observed?.phase === "preparing" && <Button type="button" variant="outline" size="sm" disabled={unavailable || busy} onClick={() => void run(recovery.originalApply!, recovery)}>Retry preparation</Button>}
          {!recovery.pending && observed && !terminal(observed) && observed.phase !== "active" && <><Button type="button" variant="outline" size="sm" disabled={unavailable || busy} onClick={() => void run({ kind: "resume", workspaceId: recovery.workspaceId, body: { activationId: recovery.activationId } }, recovery)}>Continue switch</Button>
            <Button type="button" variant="outline" size="sm" disabled={unavailable || busy} onClick={() => void run({ kind: "cancel", workspaceId: recovery.workspaceId, body: { activationId: recovery.activationId } }, recovery)}>Pause switch</Button></>}
        </div>
      </section>}
      {recovery?.release && stalled && <section className="space-y-2 rounded-lg border p-3" aria-label="Release switch recovery">
        <p>{recovery.release.status === "failed" ? "Core could not switch to Release." : "Core has not confirmed the Release switch yet."}</p>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setStatusRevision(value => value + 1)}>Check progress</Button>
        {recovery.release.status === "failed" && <Button type="button" variant="outline" size="sm" onClick={() => { remember(null); setError(""); setTarget(null); }}>Dismiss failed switch</Button>}
      </section>}
      {target?.kind === "workspace" && recovery?.originalApply && (repairing || review?.repair || errorCode === "activation_review_changed" || observed?.phase === "preparing" && observed.preparationReleased) && <div className="space-y-2">
        <Button type="button" variant="outline" disabled={unavailable || busy} onClick={() => void prepareReview(target, recovery.originalApply!)}>Review workspace again</Button>
        {review && <Button type="button" disabled={unavailable || busy} onClick={() => void run({ ...recovery.originalApply!, body: { ...recovery.originalApply!.body, planDigest: review.value.planDigest } },
          { ...recovery, expectedCoreProject: review.value.plan.participants.find(row => row.kind === "core")?.sourcePath ?? undefined })}>Retry reviewed switch</Button>}
      </div>}
      {target?.kind === "workspace" && !blockedByRecovery && !activeDone && !showingProgress && <>
        {review ? <section className="space-y-2" aria-label="Reviewed Core target"><p className="text-muted-foreground">Core will start from <strong className="font-medium text-foreground">{target.label}</strong>. Applications stay on their current runtimes.</p></section>
          : <Button type="button" variant="outline" disabled={busy} onClick={() => void prepareReview(target)}>Review workspace target</Button>}
      </>}
      {activeDone && <p role="status">Core is now running from {target?.kind === "workspace" ? target.label : "the selected workspace"}.</p>}
      {releaseDone && <p role="status">Core is now running the installed Release.</p>}
      {!target && observed?.phase === "active" && !showingProgress && !stalled && <p role="status">{state?.launch.mode === "dev" && pathKey(observed.coreProject) === pathKey(state.launch.projectPath) ? "Core is running from " + currentLabel + "." : "Core is running a different version from this saved switch."}</p>}
    </DialogBody>
    <DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>{activeDone || releaseDone ? "Done" : "Close"}</Button>
      {target?.kind === "release" && !selectedActive && !blockedByRecovery && !releaseDone && <Button type="button" disabled={unavailable || busy || !inventoryReady} onClick={() => void release()}>{returned ? "Continue to Release" : "Use Release"}</Button>}
      {target?.kind === "workspace" && !blockedByRecovery && review && !activeDone && <Button type="button" disabled={unavailable || busy} onClick={apply}>Switch Core</Button>}
    </DialogFooter>
  </DialogContent></Dialog>;
  return { control, dialog, busy: busy || transition || needsAttention, needsAttention, showRecovery: () => recover() };
}

export function CoreWorkspaceControl(props: CoreWorkspaceControlProps) {
  const control = useCoreWorkspaceControl(props);
  return <>{control.control}{control.dialog}</>;
}
