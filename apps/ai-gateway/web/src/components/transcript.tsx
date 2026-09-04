"use client";

import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, HelpCircle, Loader2, Paperclip, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/status";
import { Markdown } from "@/components/markdown";
import { cn } from "@/lib/utils";
import {
  describeApproval,
  isListedToolUse,
  summarizeToolUse,
  type ApprovalView,
  type FileChangeView,
} from "@/lib/tool-display";
import type { AssistantEvent, AssistantQuestion } from "@/lib/assistant-api";

// The transcript, moved out of Shell with the rest of the panel. The gateway's event log is the
// source: every proposed write pauses as an inline approval card until the operator decides.
//
// Assistant prose is markdown; the operator's own message is not. What they typed is shown back to
// them exactly as they typed it — a message that reformatted itself on send would leave them unsure
// which of the two texts the harness actually received.

/** How a card was resolved: the verdict, and the operator's reason when a deny carried one. */
export type ApprovalDecision = { decision: string; message: string | null };

export function TranscriptEvent({
  event,
  decision,
  answers,
  denyReason,
  onDecide,
  onAnswer,
  appNames,
}: {
  event: AssistantEvent;
  decision: ApprovalDecision | null;
  answers: Record<string, string> | null;
  /** Whether the harness can deliver a deny reason; the card offers the box only when it can. */
  denyReason: boolean;
  onDecide: (approvalId: string, decision: "allow" | "deny", message?: string) => Promise<void>;
  onAnswer: (questionId: string, answers: Record<string, string>) => Promise<void>;
  /** Display name per MCP server name; absent entries fall back to the wire name. */
  appNames?: Record<string, string>;
}) {
  switch (event.type) {
    case "user_message":
      // The attachment names the event also carries are deliberately not drawn here. Each file
      // already has its own `attachment_added` row immediately above, and printing both put the same
      // long name on screen twice for every attachment.
      return (
        <div className="ml-8 rounded-lg bg-primary/10 px-3 py-2 text-sm whitespace-pre-wrap">
          {String(event.text ?? "")}
        </div>
      );
    case "attachment_added":
      // Its own row, so a session restored from a backup — records back, cache not — still shows
      // that a file was here, even though the file itself is gone.
      return <AttachmentRow name={String(event.name ?? "")} size={Number(event.size ?? 0)} />;
    case "assistant_text":
      return (
        <div className="rounded-lg bg-muted/60 px-3 py-2">
          <Markdown text={String(event.text ?? "")} />
        </div>
      );
    case "tool_use": {
      const toolName = String(event.toolName ?? "tool");
      return isListedToolUse(toolName) ? <ToolRow toolName={toolName} input={event.input} appNames={appNames} /> : null;
    }
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
          onAnswer={onAnswer}
        />
      );
    case "notice":
      // Something degraded while the session stayed usable, so it reads as information rather than
      // as the failure styling — which would say the run is over when it is not.
      return (
        <div className="rounded-md border border-muted-foreground/30 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {String(event.message ?? "")}
        </div>
      );
    case "error":
      return <InlineError message={String(event.message ?? "Assistant error")} />;
    default:
      return null;
  }
}

// One line per tool call: what it was for, not what it was called. A run that reads thirty files is
// thirty rows, so the row carries the model's own description (or the path, the pattern, the query)
// and the raw input waits behind a click — a transcript that showed every input would be a wall of
// JSON with the conversation somewhere inside it.
/**
 * One attached file, collapsed to a paperclip and a truncated name.
 *
 * Shaped like {@link ToolRow} on purpose: the transcript already teaches that a small row with a
 * chevron opens, and a second idiom for the same gesture would be one more thing to learn. Names
 * here are the operator's own file names — long, and often longer than the column — so the row
 * truncates and the full name is one click away, with the size beside it.
 */
function AttachmentRow({ name, size }: { name: string; size: number }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="ml-8 px-1 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1.5 text-left hover:text-foreground"
      >
        <Paperclip className="h-3 w-3 shrink-0" aria-hidden />
        <span className="shrink-0 font-medium">Attachment</span>
        <span className="min-w-0 truncate">{name}</span>
        <Chevron className="ml-auto h-3 w-3 shrink-0" aria-hidden />
      </button>
      {open && (
        <div className="mt-1 rounded bg-muted/60 p-2 break-all">
          {name} <span className="text-muted-foreground">({formatBytes(size)})</span>
        </div>
      )}
    </div>
  );
}

function ToolRow({ toolName, input, appNames }: { toolName: string; input: unknown; appNames?: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => summarizeToolUse(toolName, input, appNames), [toolName, input, appNames]);
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="px-1 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1.5 text-left hover:text-foreground"
      >
        <Wrench className="h-3 w-3 shrink-0" aria-hidden />
        <span className="shrink-0 font-medium">{summary.label}</span>
        {summary.detail && <span className="min-w-0 truncate">{summary.detail}</span>}
        <Chevron className="ml-auto h-3 w-3 shrink-0" aria-hidden />
      </button>
      {open && (
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted/60 p-2 break-all whitespace-pre-wrap">
          {JSON.stringify(input ?? {}, null, 2)}
        </pre>
      )}
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
  const [busy, setBusy] = useState(false);

  const category =
    view.kind === "mcp"
      ? `App tool · ${view.server}`
      : view.kind === "command"
        ? "Shell"
        : view.kind === "file"
          ? "Files"
          : toolName;

  const decide = (verdict: "allow" | "deny") => {
    setBusy(true);
    const message = verdict === "deny" && why.trim() ? why.trim() : undefined;
    void onDecide(approvalId, verdict, message).finally(() => setBusy(false));
  };

  return (
    <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
      <div className="text-[11px] tracking-wide text-muted-foreground uppercase">Approve · {category}</div>
      <div className="font-medium">{view.heading}</div>
      {title && title !== view.heading && <div className="text-xs text-muted-foreground">{title}</div>}
      <ApprovalBody view={view} />
      {reason && <div className="text-xs text-muted-foreground">{reason}</div>}
      {decision ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className={cn(decision.decision === "allow" ? "text-emerald-700" : "text-destructive")}
          >
            {decision.decision === "allow" ? "Allowed" : "Denied"}
          </Badge>
          {decision.message && <span className="text-xs text-muted-foreground">{decision.message}</span>}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={busy} onClick={() => decide("allow")}>
            Allow
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => decide("deny")}>
            Deny
          </Button>
          {/* Enter here is a deny: typing a reason is already the decision, and a reason that had to
              be followed by a second click would be the one nobody types. */}
          {reasonBox && (
            <>
              <input
                value={why}
                disabled={busy}
                onChange={(event) => setWhy(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    decide("deny");
                  }
                }}
                // Short enough to survive the panel at its narrowest — the sentence that was here
                // truncated to "Sent to the assist…", which told the operator less than nothing.
                // What it was saying moves to the description below, which every reader gets: a
                // `title` alone reaches a mouse and leaves out the keyboard and the screen reader.
                placeholder="Why not? (optional)"
                title="Sent to the assistant with your denial."
                aria-label="Reason for denying"
                aria-describedby={`${approvalId}-reason-hint`}
                className="min-w-40 flex-1 rounded-md border bg-transparent px-2 py-1 text-xs outline-none focus-visible:border-ring"
              />
              {/* The accessible description, keyed by the approval so several open cards cannot
                  share one id. Not the label: the label names the field, this says where the words
                  go, and folding the two together would have the name read as a sentence. */}
              <span id={`${approvalId}-reason-hint`} className="sr-only">
                Sent to the assistant with your denial.
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ApprovalBody({ view }: { view: ApprovalView }) {
  switch (view.kind) {
    case "command":
      return (
        <div className="space-y-1">
          {/* No wrapping on purpose: a command is read left to right, and a digest or a long path
              broken across lines is a command the operator has to reassemble before approving. */}
          <pre className="max-h-48 overflow-auto rounded bg-background/60 p-2 font-mono text-xs whitespace-pre">
            {view.command}
          </pre>
          {view.cwd && <div className="text-xs text-muted-foreground">in {view.cwd}</div>}
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
              <dd className="min-w-0 break-all whitespace-pre-wrap">{value}</dd>
            </Fragment>
          ))}
        </dl>
      );
    default:
      return (
        <pre className="max-h-48 overflow-auto rounded bg-background/60 p-2 text-xs break-all whitespace-pre-wrap">
          {view.json}
        </pre>
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
          <Badge variant="outline" className="font-normal">
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

// Deliberately not styled like the amber approval card: an approval asks the operator to authorize
// something the agent wants to do, a question asks them to decide something the agent cannot. Making
// them look alike would train the operator to treat both as "click to make it go away", which is
// exactly the reflex an approval gate must not build.
function QuestionCard({
  questionId,
  questions,
  answers,
  onAnswer,
}: {
  questionId: string;
  questions: AssistantQuestion[];
  /** Non-null once answered: the card collapses to what was chosen. */
  answers: Record<string, string> | null;
  onAnswer: (questionId: string, answers: Record<string, string>) => Promise<void>;
}) {
  // Selections are per question text — the same keying the gateway and harness use end to end.
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const toggle = (question: AssistantQuestion, label: string) => {
    setSelected((current) => {
      const previous = current[question.question] ?? [];
      if (!question.multiSelect) {
        return { ...current, [question.question]: [label] };
      }
      return {
        ...current,
        [question.question]: previous.includes(label)
          ? previous.filter((entry) => entry !== label)
          : [...previous, label],
      };
    });
  };

  // A question counts as answered when an option is picked or free text is typed. Multi-select
  // answers are joined into one comma-separated value, the shape the tool contract expects.
  const collected = useMemo(() => {
    const result: Record<string, string> = {};
    for (const question of questions) {
      const picks = [...(selected[question.question] ?? [])];
      const free = (other[question.question] ?? "").trim();
      if (free) {
        picks.push(free);
      }
      if (picks.length > 0) {
        result[question.question] = picks.join(", ");
      }
    }
    return result;
  }, [questions, selected, other]);

  const complete = questions.length > 0 && questions.every((question) => collected[question.question]);

  if (answers) {
    return (
      <div className="space-y-1.5 rounded-lg border border-sky-500/40 bg-sky-500/5 px-3 py-2 text-sm">
        {questions.map((question) => (
          <div key={question.question} className="flex flex-wrap items-baseline gap-1.5">
            <span className="text-muted-foreground text-xs">{question.question}</span>
            <Badge variant="outline">{answers[question.question] ?? "—"}</Badge>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm">
      {questions.map((question) => {
        const picks = selected[question.question] ?? [];
        return (
          <div key={question.question} className="space-y-2">
            <div className="flex items-center gap-1.5">
              <HelpCircle className="h-3.5 w-3.5 shrink-0 text-sky-600" aria-hidden />
              <span className="font-medium">{question.question}</span>
              {question.multiSelect && (
                <Badge variant="outline" className="font-normal">
                  choose any
                </Badge>
              )}
            </div>
            <div className="space-y-1">
              {question.options.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  onClick={() => toggle(question, option.label)}
                  className={cn(
                    "w-full rounded-md border px-2 py-1.5 text-left transition-colors",
                    picks.includes(option.label)
                      ? "border-sky-500 bg-sky-500/20"
                      : "border-transparent bg-background/60 hover:border-sky-500/40",
                  )}
                >
                  <div className="text-sm font-medium">{option.label}</div>
                  {option.description && <div className="text-muted-foreground text-xs">{option.description}</div>}
                </button>
              ))}
            </div>
            {/* "Other" is part of the tool contract, not a nicety: the model is told an Other option
                is provided automatically, so it never lists one and the card must supply it. */}
            <input
              value={other[question.question] ?? ""}
              onChange={(event) => setOther((current) => ({ ...current, [question.question]: event.target.value }))}
              placeholder="Other…"
              className="w-full rounded-md border bg-transparent px-2 py-1 text-xs outline-none focus-visible:border-ring"
            />
          </div>
        );
      })}
      <Button
        type="button"
        size="sm"
        disabled={!complete || submitting}
        onClick={() => {
          setSubmitting(true);
          void onAnswer(questionId, collected).finally(() => setSubmitting(false));
        }}
      >
        {submitting ? <Loader2 className="animate-spin" /> : null}
        Answer
      </Button>
    </div>
  );
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
