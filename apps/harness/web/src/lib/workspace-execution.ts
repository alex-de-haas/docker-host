"use client";

import { useEffect, useRef, useState } from "react";
import { presentInstallationConfirmation } from "@hosty-sdk/app/install";
import { approveWorkspaceAccess, type RetainedAccessReview, type WorkspaceAccessReview } from "./workspace-access-review";
import { developmentRequest, DevelopmentRequestError } from "./development-api";
import type { WorkspaceApplication } from "./workspace-applications";

type Selection = { requestId: string; kind: "workspace" | "package"; appId?: string; workspaceId?: string; worktreeId?: string; runtime?: string; paused?: boolean;
  review?: { candidate: string; request: RetainedAccessReview } };
type Result = { requestId: string; state: string; error?: string; apps: { appId: string; state: string; error?: string; code?: string; review?: WorkspaceAccessReview }[] };
type Phase = "idle" | "checking" | "switching" | "approval" | "failed";
const terminalCode = (code?: string) => ["dev_selection_changed", "dev_installation_changed", "execution_request_conflict", "selection_changed", "installation_changed"].includes(code || "");
function savedSelection(key: string, workspaceId: string): Selection | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!value || typeof value.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(value.requestId) || !["workspace", "package"].includes(value.kind)) return null;
    if (value.appId !== undefined && (typeof value.appId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(value.appId)
      || value.kind !== "workspace" || value.workspaceId !== workspaceId || typeof value.worktreeId !== "string"
      || !/^[a-f0-9]{64}$/.test(value.worktreeId) || value.runtime !== undefined && typeof value.runtime !== "string")) return null;
    if (value.review && (typeof value.review.candidate !== "string" || typeof value.review.request?.id !== "string" || typeof value.review.request?.expiresAt !== "string")) delete value.review;
    return value;
  } catch { return null; }
}
function selectionPath(workspaceId: string, selection: Selection) {
  return `/${workspaceId}${selection.appId ? `/applications/${encodeURIComponent(selection.appId)}` : ""}/execution-target`;
}
function selectionBody(selection: Selection) {
  return { requestId: selection.requestId, kind: selection.kind,
    ...(selection.appId ? { workspaceId: selection.workspaceId, worktreeId: selection.worktreeId,
      ...(selection.runtime !== undefined ? { runtime: selection.runtime } : {}) } : {}) };
}
function selectionResult(selection: Selection, value: Result | Omit<Result, "apps"> & { code?: string; review?: WorkspaceAccessReview }): Result {
  return selection.appId ? { requestId: value.requestId, state: value.state, apps: [{ ...value, appId: selection.appId }] } : value as Result;
}

/** The journal is recovery data, never evidence of the currently selected runtime. */
export function useWorkspaceExecution(workspaceId: string, options: { disabled?: boolean; canUse: boolean; refresh(): void }) {
  const storageKey = `hosty.workspace.execution:${location.origin}:${workspaceId}`;
  const [pending, setPending] = useState<Selection | null>(() => savedSelection(storageKey, workspaceId));
  const [phase, setPhase] = useState<Phase>(() => pending ? "checking" : "idle");
  const [error, setError] = useState("");
  const [approvalLink, setApprovalLink] = useState<string | null>(null);
  const current = useRef(options); current.current = options;
  const active = useRef<AbortController | null>(null);
  const record = (selection: Selection | null) => {
    setPending(selection);
    try { if (selection) localStorage.setItem(storageKey, JSON.stringify(selection)); else localStorage.removeItem(storageKey); }
    catch { /* Core retains the authoritative operation. */ }
  };
  const execute = async (initial: Selection, inspect: boolean, replay = false) => {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    const alive = () => !controller.signal.aborted;
    let selection = replay ? { ...initial, paused: undefined } : initial;
    const save = (next: Selection) => { selection = next; if (alive()) record(next); };
    const request = async (read: boolean) => selectionResult(selection, await developmentRequest<Result>(
      selectionPath(workspaceId, selection) + (read ? `/${selection.requestId}` : ""), read ? undefined : selectionBody(selection), controller.signal));
    setPhase(inspect ? "checking" : "switching"); setError(""); setApprovalLink(null); save(selection);
    try {
      let next: Result;
      try { next = await request(inspect); }
      catch (cause) {
        if (!inspect || !(cause instanceof DevelopmentRequestError) || cause.code !== "execution_not_found") throw cause;
        if (current.current.disabled || selection.kind === "workspace" && !current.current.canUse) throw new Error("Resume this workspace before switching its applications.");
        next = await request(false);
      }
      if (replay && ["failed", "review-required"].includes(next.state) && !next.apps?.some(app => terminalCode(app.code))) next = await request(false);
      const approved = new Set<string>();
      for (;;) {
        if (!alive()) return;
        if (next.state === "running") {
          setPhase("switching");
          await new Promise(resolve => setTimeout(resolve, 1500));
          if (!alive()) return;
          next = await request(true); continue;
        }
        if (next.state === "completed") { record(null); setPhase("idle"); return; }
        if (next.state === "review-required") {
          if (selection.paused) { setError("Access confirmation paused. Try again to continue."); setPhase("failed"); return; }
          if (current.current.disabled || !current.current.canUse) throw new Error("Resume this workspace before approving its switch.");
          const reviews = next.apps.filter(app => app.state === "review-required");
          if (!reviews.length || reviews.some(app => !app.review)) throw new Error("Core did not provide an access confirmation. Try again.");
          for (const app of reviews) {
            const review = app.review!;
            const candidate = JSON.stringify(review.workspaceManifest);
            if (approved.has(candidate)) throw new Error("Core has not applied the confirmed access. Try again.");
            setPhase("approval");
            const retained = selection.review?.candidate === candidate && Date.parse(selection.review.request.expiresAt) > Date.now()
              ? selection.review.request : undefined;
            const approval = await approveWorkspaceAccess(review, value => {
              if (!alive() || !["pending", "executing"].includes(value.status)) return;
              const url = new URL(value.approvalUrl);
              if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid Core confirmation URL.");
              // Core isolates confirmation with COOP. The host presents embedded requests;
              // standalone pages open the final URL. A detached window handle is not consent.
              setApprovalLink(url.href);
              presentInstallationConfirmation(value);
            }, { retained, remember: request => save({ ...selection, review: request ? { candidate, request } : undefined }),
              cancelled: () => !alive() || !!current.current.disabled || !current.current.canUse });
            if (!alive()) return;
            setApprovalLink(null);
            if (approval.status !== "succeeded") {
              save({ ...selection, review: undefined, paused: true });
              throw new Error("Access was not approved. The switch did not continue.");
            }
            approved.add(candidate);
          }
          if (!alive()) return;
          setPhase("switching"); next = await request(false); continue;
        }
        if (next.apps?.some(app => terminalCode(app.code))) record(null);
        throw new Error(next.apps?.filter(app => !["completed", "skipped"].includes(app.state))
          .map(app => `${app.appId}: ${app.error || "Switch failed."}`).join("\n") || next.error || "Core could not complete the switch.");
      }
    } catch (cause) {
      if (!alive()) return;
      if (cause instanceof DevelopmentRequestError && terminalCode(cause.code)) record(null);
      const closed = !!cause && typeof cause === "object" && "name" in cause && cause.name === "AbortError";
      if (closed) save({ ...selection, paused: true });
      setError(closed ? "Access confirmation was closed. Try again to continue." : cause instanceof Error ? cause.message : String(cause));
      setPhase("failed");
    } finally {
      if (active.current === controller) active.current = null;
      if (alive()) { setApprovalLink(null); current.current.refresh(); }
    }
  };
  // Resume observation on mount, including operations which were still running when Harness restarted.
  const recover = useRef(execute); recover.current = execute;
  useEffect(() => {
    const saved = savedSelection(storageKey, workspaceId);
    if (saved) void recover.current(saved, true);
    return () => { active.current?.abort(); active.current = null; };
  }, [storageKey, workspaceId]);
  const run = (kind: Selection["kind"], application?: WorkspaceApplication) => {
    if (current.current.disabled || kind === "workspace" && !current.current.canUse) return;
    const same = pending?.kind === kind && pending.appId === application?.appId;
    const selection: Selection = same ? pending : application
      ? { kind, requestId: crypto.randomUUID(), appId: application.appId, workspaceId,
        worktreeId: application.target!.worktreeId!, ...(application.target?.runtime ? { runtime: application.target.runtime } : {}) }
      : { kind, requestId: crypto.randomUUID() };
    void execute(selection, !!same, !!same);
  };
  const retry = () => {
    if (!pending || current.current.disabled || pending.kind === "workspace" && !current.current.canUse) return;
    // A settled failure can be replayed; uncertain responses are first resolved by GET.
    void execute(pending, true, true);
  };
  const cancelReview = () => {
    active.current?.abort(); active.current = null;
    if (pending) record({ ...pending, paused: true });
    setPhase("failed"); setApprovalLink(null); setError("Access confirmation paused. Try again to continue.");
  };
  const reopenReview = () => {
    if (approvalLink && pending?.review) presentInstallationConfirmation({ id: pending.review.request.id, approvalUrl: approvalLink });
  };
  return { phase, pending, error, approvalLink, reopenReview, busy: ["checking", "switching", "approval"].includes(phase), run, retry, cancelReview };
}
