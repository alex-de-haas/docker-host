"use client";

import { Fragment, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Clock3, HelpCircle, ShieldCheck, Wrench, X, FileCode2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { HostyLoader } from "../../../../../shared/web/hosty-states";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/status";
import { Markdown } from "@/components/markdown";
import { ChatAttachment } from "@/components/chat-attachment";
import { ChatCodeBlock } from "@/components/chat-code-block";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  describeApproval,
  isListedToolUse,
  summarizeToolUse,
  type ApprovalView,
  type FileChangeView,
} from "@/lib/tool-display";
import type { AssistantEvent, AssistantQuestion } from "@/lib/assistant-api";
import type { AttachmentIndex } from "@/lib/attachments";
import { repositoryName, type DevelopmentWorkspace } from "@/lib/development-api";
import { resolveTranscriptReview, type TranscriptReviewReference } from "@/lib/transcript-edits";
import { commandDuration, commandOutcome, isCommandTool, recordedEditGroups, recordedEditTotals, recordedFileEdits, type CommandOutcome, type RecordedFileEdit } from "@/lib/transcript-activity";
import type { ToolOutput } from "@/lib/tool-output";
export type TranscriptReviewContext = {
  sessionId: string; workspaces: readonly DevelopmentWorkspace[]; onOpen: (reference: TranscriptReviewReference) => void;
};

// The transcript, moved out of Shell with the rest of the panel. The gateway's event log is the
// source: every proposed write pauses as an inline approval card until the operator decides.
//
// Assistant prose is markdown; the operator's own message is not. What they typed is shown back to
// them exactly as they typed it — a message that reformatted itself on send would leave them unsure
// which of the two texts the harness actually received.

/** How a card was resolved: the verdict, and the operator's reason when a deny carried one. */
export type ApprovalDecision = { decision: string; message: string | null };

/** Resolve only requests preceding a recorded cancellation; later turns remain actionable. */
export function approvalDecisions(events: readonly AssistantEvent[]): Map<string, ApprovalDecision> {
  const decisions = new Map<string, ApprovalDecision>();
  const pending = new Set<string>();
  for (const event of events) {
    const id = String(event.approvalId);
    if (event.type === "approval_request") {
      if (!decisions.has(id)) pending.add(id);
    } else if (event.type === "approval_decision") {
      pending.delete(id);
      decisions.set(id, {
        decision: String(event.decision),
        message: typeof event.message === "string" && event.message ? event.message : null,
      });
    } else if (event.type === "session_status" && event.status === "cancelled") {
      for (const approvalId of pending) {
        decisions.set(approvalId, { decision: "cancelled", message: "The session stopped before this request was decided." });
      }
      pending.clear();
    }
  }
  return decisions;
}

/** Pending questions expire on cancellation, including when the transcript is replayed. */
export function cancelledQuestions(events: readonly AssistantEvent[]): Set<string> {
  const cancelled = new Set<string>();
  const pending = new Set<string>();
  for (const event of events) {
    if (event.type === "question_request") {
      pending.add(String(event.questionId));
    } else if (event.type === "question_answered") {
      pending.delete(String(event.questionId));
      cancelled.delete(String(event.questionId));
    } else if (event.type === "session_status" && event.status === "cancelled") {
      for (const id of pending) cancelled.add(id);
      pending.clear();
    }
  }
  return cancelled;
}

export function TranscriptEvent({
  event,
  decision,
  answers,
  questionCancelled = false,
  denyReason,
  onDecide,
  onAnswer,
  appNames,
  attachments,
  reviewContext,
}: {
  event: AssistantEvent;
  decision: ApprovalDecision | null;
  answers: Record<string, string> | null;
  questionCancelled?: boolean;
  /** Whether the harness can deliver a deny reason; the card offers the box only when it can. */
  denyReason: boolean;
  onDecide: (approvalId: string, decision: "allow" | "deny", message?: string) => Promise<void>;
  onAnswer: (questionId: string, answers: Record<string, string>) => Promise<void>;
  /** Display name per MCP server name; absent entries fall back to the wire name. */
  appNames?: Record<string, string>;
  /** Every upload in the log; absent, each upload simply draws its own row. */
  attachments?: AttachmentIndex;
  reviewContext?: TranscriptReviewContext;
}) {
  switch (event.type) {
    case "app_context_changed": {
      const ids = Array.isArray(event.appIds) ? event.appIds.map(String) : [];
      return <div className="px-3 py-1 text-xs text-muted-foreground">{event.origin === "agent" ? "Assistant updated app context" : "App context"}: {ids.length ? ids.join(", ") : "General context"}</div>;
    }
    case "user_message": {
      // The files this turn carried are named here, under the message that carried them, because
      // this event is the only one that knows which message they belong to. Their upload rows draw
      // nothing in return, so no name reaches the screen twice.
      const names = (Array.isArray(event.attachments) ? event.attachments : []).map(String);
      return (
        <div className="space-y-1">
          {String(event.text ?? "").trim() && <div className="ml-3 min-w-0 rounded-lg bg-primary/10 px-3 py-2 text-sm whitespace-pre-wrap wrap-anywhere sm:ml-8">
            {String(event.text ?? "")}
          </div>}
          {names.length > 0 && (
            <AttachmentRow files={names.map((name) => ({ name, size: attachments?.sizes.get(name) ?? null }))} />
          )}
        </div>
      );
    }
    case "attachment_added": {
      // A row of its own for an upload no message claims — it is in the workspace and against the
      // session's quota either way — and so that a session restored from a backup (records back,
      // cache not) still shows a file was here, even though the file itself is gone.
      const name = String(event.name ?? "");
      return attachments?.claimed.has(name) ? null : (
        <AttachmentRow files={[{ name, size: Number(event.size ?? 0) }]} />
      );
    }
    case "assistant_text":
      return (
        <div className="rounded-lg bg-muted/60 px-3 py-2">
          <Markdown text={String(event.text ?? "")} />
        </div>
      );
    case "tool_use": {
      const toolName = String(event.toolName ?? "tool");
      return isListedToolUse(toolName) ? <><ToolRow toolName={toolName} input={event.input} appNames={appNames} mcp={event.mcp} /><TranscriptChanges events={[event]} reviewContext={reviewContext} /></> : null;
    }
    case "tool_result":
      return <p className="p-2 text-xs text-muted-foreground">Tool output has no unique matching call in this turn.</p>;
    case "command_result":
      return <div className="space-y-1 rounded-md border border-muted-foreground/25 p-2 text-xs"><p className="text-muted-foreground">Command result has no unique matching call in this turn.</p><InvocationResult outcome={commandOutcome(event)} /></div>;
    case "approval_request":
      return (
        <ApprovalCard
          approvalId={String(event.approvalId)}
          toolName={String(event.toolName ?? "action")}
          input={event.input}
          appNames={appNames}
          title={typeof event.title === "string" ? event.title : null}
          reason={typeof event.reason === "string" ? event.reason : null}
          decision={decision}
          reasonBox={denyReason}
          onDecide={onDecide}
        />
      );
    case "question_request":
      return (
        <QuestionCard
          questionId={String(event.questionId)}
          questions={(event.questions ?? []) as AssistantQuestion[]}
          answers={answers}
          cancelled={questionCancelled}
          onAnswer={onAnswer}
        />
      );
    case "notice":
      // Something degraded while the session stayed usable, so it reads as information rather than
      // as the failure styling — which would say the run is over when it is not.
      return (
        <div className="min-w-0 rounded-md border border-muted-foreground/30 bg-muted/40 px-3 py-2 text-xs wrap-anywhere text-muted-foreground">
          {String(event.message ?? "")}
        </div>
      );
    case "error":
      return <InlineError message={String(event.message ?? "Assistant error")} />;
    default:
      return null;
  }
}

/** Stored metadata remains visible even when the session cache no longer contains the file. */
function AttachmentRow({ files }: { files: { name: string; size: number | null }[] }) {
  return (
    <div className="ml-3 flex min-w-0 flex-col sm:ml-8 gap-2" aria-label="Message attachments">
      {files.map((file, index) => <ChatAttachment key={`${file.name}-${index}`} name={file.name} size={file.size} />)}
    </div>
  );
}

/** Recorded outcomes belong to their factual command; a turn result cannot establish one. */
export function ToolActivity({ events, appNames, reviewContext, commandResults = {}, toolResults = {} }: {
  events: AssistantEvent[]; appNames?: Record<string, string>; reviewContext?: TranscriptReviewContext; commandResults?: Readonly<Record<number, CommandOutcome>>; toolResults?: Readonly<Record<number, ToolOutput>>;
}) {
  const [open, setOpen] = useState(false);
  const failedCalls = events.filter(event => {
    const outcome = isCommandTool(event) ? commandResults[event.seq] : toolResults[event.seq];
    return outcome?.status === "failed" && !outcome.conflict;
  }).length;
  return <div className="flex min-w-0 flex-col gap-2">
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0" data-slot="tool-activity">
      <CollapsibleTrigger asChild><Button type="button" variant="ghost" size="sm" className="h-auto min-h-8 w-full min-w-0 justify-start gap-2 px-2 text-left text-xs text-muted-foreground">
        <Wrench className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 font-medium tabular-nums">{events.length} tool {events.length === 1 ? "call" : "calls"}</span>
        {failedCalls > 0 && <Badge variant="outline" className="shrink-0 tabular-nums text-destructive-foreground">{failedCalls} failed</Badge>}
        <ChevronDown className={cn("ml-auto size-3.5 shrink-0", open && "rotate-180")} aria-hidden />
      </Button></CollapsibleTrigger>
      <CollapsibleContent className="ml-3 flex min-w-0 flex-col gap-2 border-l pl-3 pt-1">
        {events.map(event => <ToolRow key={event.seq} toolName={String(event.toolName ?? "tool")} input={event.input} appNames={appNames} mcp={event.mcp} output={toolResults[event.seq]}
          command={isCommandTool(event) ? { outcome: commandResults[event.seq], legacy: !event.toolUseId } : undefined} />)}
      </CollapsibleContent>
    </Collapsible>
    <TranscriptChanges events={events} reviewContext={reviewContext} />
  </div>;
}
function TranscriptChanges({ events, reviewContext }: { events: AssistantEvent[]; reviewContext?: TranscriptReviewContext }) {
  const [open, setOpen] = useState(false);
  const edits = recordedFileEdits(events);
  if (!edits.length) return null;
  const totals = recordedEditTotals(edits);
  const entries = edits.some(edit => !edit.review);
  return <Collapsible open={open} onOpenChange={setOpen} className="min-w-0" data-slot="transcript-changes">
    <CollapsibleTrigger asChild><Button type="button" variant="ghost" size="sm" className="h-auto min-h-8 w-full min-w-0 justify-start gap-2 px-2 text-left text-xs text-muted-foreground">
      <FileCode2 className="size-3.5 shrink-0" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium tabular-nums">Changes · {edits.length} {entries ? edits.length === 1 ? "file entry" : "file entries" : edits.length === 1 ? "file" : "files"}</span>
        {totals.additions !== undefined && <span className="font-mono font-normal tabular-nums text-success-foreground" aria-label={`${totals.additions} recorded additions`}>+{totals.additions}</span>}
        {totals.deletions !== undefined && <span className="font-mono font-normal tabular-nums text-destructive-foreground" aria-label={`${totals.deletions} recorded deletions`}>−{totals.deletions}</span>}
        {(totals.additions === undefined || totals.deletions === undefined) && <span className="text-muted-foreground">Line totals unavailable</span>}
      </span>
      <ChevronDown className={cn("ml-auto size-3.5 shrink-0", open && "rotate-180")} aria-hidden />
    </Button></CollapsibleTrigger>
    <CollapsibleContent className="min-w-0 pt-1">
      <TranscriptEditFiles edits={edits} reviewContext={reviewContext} />
    </CollapsibleContent>
  </Collapsible>;
}
function InvocationResult({ outcome, legacy = false, compact = false }: { outcome?: CommandOutcome; legacy?: boolean; compact?: boolean }) {
  const Tag = compact ? "span" : "div";
  return <Tag data-slot="command-result" className={cn("min-w-0 items-center text-xs font-normal tabular-nums", compact ? "ml-auto inline-flex shrink-0 gap-x-1 whitespace-nowrap @sm:gap-x-2" : "flex flex-wrap gap-x-2 gap-y-1 px-1")} aria-label={compact ? undefined : "Recorded command result"}>
    <Badge variant="outline" className={cn(outcome?.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground", compact && "px-1.5 py-0 @sm:px-2")}>
      {outcome?.conflict ? "Conflicting recorded results" : outcome?.status === "completed" ? "Completed" : outcome?.status === "failed" ? "Failed" : outcome?.status === "cancelled" ? "Cancelled" : "Outcome unavailable"}
    </Badge>
    {outcome?.exitCode !== undefined && <span className="font-mono text-muted-foreground">Exit {outcome.exitCode}</span>}
    {outcome?.durationMs !== undefined && <Badge variant="secondary" className="shrink-0 gap-1 px-1.5 py-0 font-mono font-normal text-muted-foreground @sm:px-2"
      aria-label={"Execution time: " + commandDuration(outcome.durationMs)} title="Provider-reported execution time">
      <Clock3 className="size-3" aria-hidden />{commandDuration(outcome.durationMs)}
    </Badge>}
    {!compact && outcome?.summary && <span className="min-w-0 basis-full break-words text-muted-foreground">{outcome.summary}</span>}
    {!compact && !outcome && legacy && <span className="text-muted-foreground">This older call has no recorded result identity.</span>}
  </Tag>;
}
function TranscriptEditFiles({ edits, reviewContext }: { edits: RecordedFileEdit[]; reviewContext?: TranscriptReviewContext }) {
  const id = useId();
  if (!edits.length) return null;
  return <div className="ml-3 flex min-w-0 flex-col gap-2 border-l pl-3" aria-label="File edits">
    {recordedEditGroups(edits).map((group, groupIndex) => <section key={group.key} className="min-w-0 space-y-1"
      aria-label={group.repository ? `Changes in ${group.repository}` : "Unbound file edit"}>
      {group.repository && <h4 className="truncate px-2 text-xs font-semibold text-muted-foreground" title={group.repository}>{repositoryName(group.repository)}</h4>}
      {group.edits.map((edit, index) => {
        const target = edit.review && reviewContext && resolveTranscriptReview(edit.review, reviewContext.sessionId, reviewContext.workspaces);
        const unavailable = !edit.review ? edit.unavailable : !target ? "This file's recorded workspace is unavailable in this session." : undefined;
        const hintId = `${id}-${groupIndex}-${index}-source`;
        return <div key={edit.key} className="min-w-0">
          <Button type="button" variant="ghost" size="sm" className="h-auto min-h-8 w-full justify-start gap-2 px-2 text-xs" disabled={!target}
            aria-label={`Review ${edit.path}`} aria-describedby={unavailable ? hintId : undefined}
            onClick={() => edit.review && target && reviewContext?.onOpen(edit.review)}>
            <FileCode2 className="size-3.5 shrink-0" aria-hidden /><span className="min-w-0 flex-1 break-all whitespace-normal text-left font-mono font-normal">{edit.path}</span>
            {edit.additions !== undefined && <span className="shrink-0 font-mono font-normal tabular-nums text-success-foreground" aria-label={`${edit.additions} recorded additions`}>+{edit.additions}</span>}
            {edit.deletions !== undefined && <span className="shrink-0 font-mono font-normal tabular-nums text-destructive-foreground" aria-label={`${edit.deletions} recorded deletions`}>−{edit.deletions}</span>}
          </Button>
          {(edit.additions === undefined || edit.deletions === undefined) && <p className="px-2 text-xs text-muted-foreground">Recorded line totals unavailable.</p>}
          {unavailable && <p id={hintId} className="px-2 pb-1 text-xs text-muted-foreground">{unavailable}</p>}
        </div>;
      })}
    </section>)}
  </div>;
}

// One line per tool call: what it was for, not what it was called. A run that reads thirty files is
// thirty rows, so the row carries the model's own description (or the path, the pattern, the query)
// and the raw input waits behind a click — a transcript that showed every input would be a wall of
// JSON with the conversation somewhere inside it.
function ToolRow({ toolName, input, appNames, mcp, output, command }: {
  toolName: string; input: unknown; appNames?: Record<string, string>; mcp?: unknown; output?: ToolOutput; command?: { outcome?: CommandOutcome; legacy: boolean };
}) {
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => summarizeToolUse(toolName, input, appNames, mcp), [toolName, input, appNames, mcp]);
  const description = input && typeof input === "object" && "description" in input ? input.description : undefined;
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="@container min-w-0 text-xs text-muted-foreground">
      <Button
        type="button" variant="ghost" size="sm"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="h-auto min-h-8 w-full min-w-0 justify-start gap-1.5 px-1 py-1 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        <Wrench className="size-3 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{summary.label}</span>
          {summary.detail && <span className={cn("ml-1 font-normal", (["Command", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "WebFetch", "FileChange"].includes(toolName) || toolName === "Bash" && !(typeof description === "string" && description.length > 0)) && "font-mono")}>{summary.detail}</span>}
        </span>
        {command ? <InvocationResult outcome={command.outcome && {
          ...command.outcome,
          ...(!command.outcome.conflict && command.outcome.durationMs === undefined && !output?.conflict && output?.durationMs !== undefined ? { durationMs: output.durationMs } : {}),
        }} compact /> : output && <InvocationResult outcome={output} compact />}
        <Chevron className="ml-auto size-3 shrink-0" aria-hidden />
      </Button>
      {open && <div className="min-w-0">
        {command?.outcome?.summary && <p className="py-1 font-mono text-xs tabular-nums text-muted-foreground">{command.outcome.summary}</p>}
        {command?.legacy && !command.outcome && <p className="py-1 text-xs text-muted-foreground">This older call has no recorded result identity.</p>}
        <ChatCodeBlock code={JSON.stringify(input ?? {}, null, 2)} language="json" title="Tool input" />
        {!output ? <p className="py-2 text-xs text-muted-foreground">Tool output was not recorded for this call.</p>
          : output.conflict ? <p className="py-2 text-xs text-warning-foreground">Conflicting recorded outputs; the result is unavailable.</p>
          : <>
            {!command && output.status !== "completed" && <p className={cn("pt-2 text-xs", output.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground")}>{output.status === "failed" ? "Tool failed" : output.status === "cancelled" ? "Tool cancelled" : "Tool outcome unavailable"}</p>}
            <ChatCodeBlock code={output.output} title="Tool output" />
            {!output.output && <p className="pb-2 text-xs text-muted-foreground">Empty output.</p>}
            {output.truncated && <p className="pb-2 text-xs text-muted-foreground">Output truncated to the recorded limit.</p>}
          </>}
      </div>}
    </div>
  );
}

// The card is typed by what is being asked, because an operator approves consequences, not JSON: a
// command shows its description over the command, an edit shows what leaves and what arrives, an
// app tool shows which app and which arguments. The fallback is the JSON the card always showed.
//
// A deny may carry a reason. It goes to the model behind a fixed prefix, so a refusal stays a
// refusal whatever was typed, and it is kept on the decision so a replayed transcript shows not only
// that a card was refused but why — which is the half a later reader actually wants.
function ApprovalCard({
  approvalId,
  toolName,
  input,
  title,
  reason,
  decision,
  reasonBox,
  onDecide,
  appNames,
}: {
  approvalId: string;
  toolName: string;
  input: unknown;
  /** The harness's own sentence for the prompt, when it sent one. */
  title: string | null;
  /** Why the harness raised the request, when it said. */
  reason: string | null;
  decision: ApprovalDecision | null;
  /** Offer a reason with a deny — only on a harness whose decline can carry one. */
  reasonBox: boolean;
  onDecide: (approvalId: string, decision: "allow" | "deny", message?: string) => Promise<void>;
  appNames?: Record<string, string>;
}) {
  const view = useMemo(() => describeApproval(toolName, input, appNames), [toolName, input, appNames]);
  const [why, setWhy] = useState("");
  const [denyOpen, setDenyOpen] = useState(false);
  const reasonInput = useRef<HTMLInputElement>(null), denyButton = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const category = view.kind === "mcp" ? view.server : view.kind === "command" ? "Command" : view.kind === "file" ? "File changes" : "Tool";
  const disabled = busy || submitted;

  const decide = async (verdict: "allow" | "deny") => {
    if (locked.current || decision) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      await onDecide(approvalId, verdict, verdict === "deny" && why.trim() ? why.trim() : undefined);
      setSubmitted(true);
    } catch (cause) {
      locked.current = false;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  return (
    <Card className={cn("min-w-0 gap-3 overflow-hidden py-0", !decision && "border-warning-foreground/40")} data-slot="approval-card" aria-busy={busy}>
      <CardHeader className={cn("gap-2 border-b px-3 py-3", !decision ? "border-warning-foreground/25 bg-warning-soft" : "bg-muted/35")}>
        <div className="flex flex-wrap items-center gap-2">
          <ShieldCheck className={cn("size-4", !decision ? "text-warning-foreground" : "text-muted-foreground")} aria-hidden />
          <span className="text-xs text-muted-foreground">{category}</span>
          <Badge variant={decision ? "outline" : "secondary"} className={cn("ml-auto", !decision && "border-warning-foreground/30 bg-warning-soft text-warning-foreground")}>
            {decision ? (decision.decision === "allow" ? "Allowed" : decision.decision === "cancelled" ? "Cancelled" : "Denied") : submitted ? "Decision sent" : "Needs approval"}
          </Badge>
        </div>
        <CardTitle className="text-sm font-semibold wrap-anywhere">{view.heading}</CardTitle>
        {title && title !== view.heading && <CardDescription className="wrap-anywhere">{title}</CardDescription>}
      </CardHeader>
      <CardContent className={cn("flex min-w-0 flex-col gap-2 px-3", decision && "pb-3")}>
        <ApprovalBody view={view} />
        {reason && <p className="text-xs text-muted-foreground wrap-anywhere">{reason}</p>}
        {decision?.message && <p className="text-sm wrap-anywhere">{decision.message}</p>}
        {!decision && reasonBox && denyOpen && <FieldGroup className="gap-2"><Field>
          <FieldLabel htmlFor={`${approvalId}-reason`} className="text-xs">Reason for denying (optional)</FieldLabel>
          <Input ref={reasonInput} id={`${approvalId}-reason`} value={why} disabled={disabled}
            aria-describedby={`${approvalId}-reason-hint`} placeholder="Explain what should change…"
            onChange={event => setWhy(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault(); void decide("deny");
              }
            }} />
          <FieldDescription id={`${approvalId}-reason-hint`} className="text-xs">Sent to the assistant with your denial.</FieldDescription>
        </Field></FieldGroup>}
        {error && <div role="alert"><InlineError message={error} /></div>}
      </CardContent>
      {!decision && <CardFooter className="flex-wrap justify-end gap-2 border-t px-3 py-3">
        {submitted ? <span role="status" className="mr-auto text-xs text-muted-foreground">Waiting for confirmation…</span> : <>
          {reasonBox && denyOpen && <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => { setDenyOpen(false); requestAnimationFrame(() => denyButton.current?.focus()); }}>Cancel denial</Button>}
          <Button ref={denyButton} type="button" size="sm" variant="outline" disabled={disabled} aria-expanded={reasonBox ? denyOpen : undefined} aria-controls={reasonBox ? `${approvalId}-reason` : undefined} onClick={() => {
            if (reasonBox && !denyOpen) { setDenyOpen(true); requestAnimationFrame(() => reasonInput.current?.focus()); }
            else void decide("deny");
          }}><X data-icon="inline-start" />{reasonBox && !denyOpen ? "Deny…" : "Deny"}</Button>
          <Button type="button" size="sm" disabled={disabled} onClick={() => void decide("allow")}>{busy ? <HostyLoader label={null} className="size-4" /> : <Check data-icon="inline-start" />}Allow once</Button>
        </>}
      </CardFooter>}
    </Card>
  );
}

function ApprovalBody({ view }: { view: ApprovalView }) {
  switch (view.kind) {
    case "command":
      return (
        <div className="flex min-w-0 flex-col gap-2">
          {/* Commands start unwrapped so paths stay on one line; Wrap is an explicit reader choice. */}
          <ChatCodeBlock code={view.command} language="shell" title="Command" tone="ink" />
          {view.cwd && <div className="font-mono text-xs break-all text-muted-foreground">in {view.cwd}</div>}
        </div>
      );
    case "file":
      return (
        <div className="space-y-2">
          {view.changes.map((change, index) => (
            <FileChange key={index} change={change} />
          ))}
        </div>
      );
    case "mcp":
      return view.args.length === 0 ? (
        <div className="text-xs text-muted-foreground">No arguments.</div>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {view.args.map(([key, value]) => (
            <Fragment key={key}>
              <dt className="font-mono text-muted-foreground">{key}</dt>
              <dd className="min-w-0 break-all font-mono whitespace-pre-wrap">{value}</dd>
            </Fragment>
          ))}
        </dl>
      );
    default:
      return (
        <ChatCodeBlock code={view.json} language="json" title="Tool input" />
      );
  }
}

/** Longest preview of file content a card shows; a whole written file is not what is being decided. */
const MAX_PREVIEW_CHARS = 4_000;

function FileChange({ change }: { change: FileChangeView }) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline gap-2 text-xs">
        <span className="font-mono break-all">{change.path ?? "(unnamed file)"}</span>
        {change.kind && (
          <Badge variant="outline" className="font-medium">
            {change.kind}
          </Badge>
        )}
      </div>
      {change.diff !== null && (
        <pre className="max-h-48 overflow-auto rounded bg-background/60 p-2 font-mono text-xs whitespace-pre">
          {clip(change.diff)}
        </pre>
      )}
      {change.before !== null && (
        <pre className="max-h-40 overflow-auto rounded border-l-2 border-destructive/60 bg-destructive/5 p-2 font-mono text-xs break-all whitespace-pre-wrap">
          {clip(change.before)}
        </pre>
      )}
      {change.after !== null && (
        <pre className="max-h-40 overflow-auto rounded border-l-2 border-emerald-500/60 bg-emerald-500/5 p-2 font-mono text-xs break-all whitespace-pre-wrap">
          {clip(change.after)}
        </pre>
      )}
    </div>
  );
}

function clip(content: string): string {
  return content.length > MAX_PREVIEW_CHARS
    ? `${content.slice(0, MAX_PREVIEW_CHARS)}\n… ${content.length - MAX_PREVIEW_CHARS} more characters`
    : content;
}

/** Questions choose an answer; they never authorize an operation. */
function QuestionCard({ questionId, questions, answers, cancelled, onAnswer }: {
  questionId: string;
  questions: AssistantQuestion[];
  cancelled: boolean;
  answers: Record<string, string> | null;
  onAnswer: (questionId: string, answers: Record<string, string>) => Promise<void>;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const disabled = submitting || submitted;
  const collected = useMemo(() => {
    const result: Record<string, string> = {};
    for (const question of questions) {
      const picks = [...(selected[question.question] ?? [])];
      const free = (other[question.question] ?? "").trim();
      if (free) picks.push(free);
      if (picks.length) result[question.question] = picks.join(", ");
    }
    return result;
  }, [questions, selected, other]);
  const complete = questions.length > 0 && questions.every(question => collected[question.question]);
  const submit = async () => {
    if (locked.current || !complete || answers || cancelled) return;
    locked.current = true;
    setSubmitting(true); setError(null);
    try {
      await onAnswer(questionId, collected);
      setSubmitted(true);
    } catch (cause) {
      locked.current = false;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setSubmitting(false); }
  };

  return <Card className="min-w-0 gap-3 py-3" data-slot="question-card" aria-busy={submitting}>
    <CardHeader className="px-3">
      <div className="flex flex-wrap items-center gap-2">
        <HelpCircle className="size-4 text-muted-foreground" aria-hidden />
        <CardTitle className="text-sm font-semibold">{answers ? "Your answers" : cancelled ? "Question cancelled" : "Your input is needed"}</CardTitle>
        <Badge variant="outline" className="ml-auto">{answers ? "Answered" : cancelled ? "Cancelled" : submitted ? "Answer sent" : "Question"}</Badge>
      </div>
    </CardHeader>
    <CardContent className="min-w-0 px-3">
      {answers || cancelled ? <dl className="flex flex-col gap-3">{questions.map(question => <div key={question.question} className="min-w-0">
        <dt className="text-xs text-muted-foreground wrap-anywhere">{question.question}</dt>
        <dd className="mt-1 text-sm whitespace-pre-wrap wrap-anywhere">{answers?.[question.question] ?? (cancelled ? "The session stopped before this question was answered." : "—")}</dd>
      </div>)}</dl> : <FieldGroup className="gap-5">{questions.map((question, questionIndex) => {
        const picks = selected[question.question] ?? [];
        const baseId = `${questionId}-${questionIndex}`;
        const choose = (label: string, checked = true) => {
          setSelected(current => ({ ...current, [question.question]: question.multiSelect
            ? checked ? [...(current[question.question] ?? []), label] : (current[question.question] ?? []).filter(value => value !== label)
            : [label] }));
          if (!question.multiSelect) setOther(current => ({ ...current, [question.question]: "" }));
        };
        const options = question.options.map((option, index) => <Field key={option.label} orientation="horizontal"
          className="items-start rounded-md border p-2.5 has-data-[state=checked]:border-brand-strong has-data-[state=checked]:bg-brand-soft" data-disabled={disabled}>
          {question.multiSelect ? <Checkbox id={`${baseId}-${index}`} checked={picks.includes(option.label)} disabled={disabled}
            onCheckedChange={checked => choose(option.label, checked === true)} />
            : <RadioGroupItem id={`${baseId}-${index}`} value={String(index)} disabled={disabled} />}
          <FieldContent className="min-w-0 gap-1">
            <FieldLabel htmlFor={`${baseId}-${index}`} className="wrap-anywhere">{option.label}</FieldLabel>
            {option.description && <FieldDescription className="text-xs wrap-anywhere">{option.description}</FieldDescription>}
          </FieldContent>
        </Field>);
        return <FieldSet key={question.question} className="min-w-0 gap-2">
          <FieldLegend id={`${baseId}-legend`} className="mb-0 text-sm font-semibold wrap-anywhere">{question.question}</FieldLegend>
          <FieldDescription className="text-xs">{question.multiSelect ? "Choose one or more, or add your own answer." : "Choose one, or write your own answer."}</FieldDescription>
          {question.multiSelect ? <div className="flex flex-col gap-2">{options}</div>
            : <RadioGroup aria-labelledby={`${baseId}-legend`} className="gap-2"
              value={picks.length ? String(question.options.findIndex(option => option.label === picks[0])) : ""}
              onValueChange={value => choose(question.options[Number(value)].label)}>{options}</RadioGroup>}
          <Field className="gap-1.5" data-disabled={disabled}>
            <FieldLabel htmlFor={`${baseId}-other`} className="text-xs">Your own answer</FieldLabel>
            <Input id={`${baseId}-other`} value={other[question.question] ?? ""} disabled={disabled} placeholder="Other…"
              onChange={event => {
                setOther(current => ({ ...current, [question.question]: event.target.value }));
                if (!question.multiSelect) setSelected(current => ({ ...current, [question.question]: [] }));
              }} />
          </Field>
        </FieldSet>;
      })}</FieldGroup>}
      {error && !cancelled && <div className="mt-3" role="alert"><InlineError message={error} /></div>}
    </CardContent>
    {!answers && !cancelled && <CardFooter className="justify-end border-t px-3 pt-3">
      {submitted ? <span role="status" className="mr-auto text-xs text-muted-foreground">Waiting for confirmation…</span>
        : <Button type="button" size="sm" disabled={!complete || disabled} onClick={() => void submit()}>
          {submitting && <HostyLoader label={null} className="size-4" />}Send answer
        </Button>}
    </CardFooter>}
  </Card>;
}
