"use client";

import { useMemo, useState } from "react";
import { HelpCircle, Loader2, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/status";
import { Markdown } from "@/components/markdown";
import { cn } from "@/lib/utils";
import type { AssistantEvent, AssistantQuestion } from "@/lib/assistant-api";

// The transcript, moved out of Shell with the rest of the panel. The gateway's event log is the
// source: every proposed write pauses as an inline approval card until the operator decides.
//
// Assistant prose is markdown; the operator's own message is not. What they typed is shown back to
// them exactly as they typed it — a message that reformatted itself on send would leave them unsure
// which of the two texts the harness actually received.

export function TranscriptEvent({
  event,
  decision,
  answers,
  onDecide,
  onAnswer,
}: {
  event: AssistantEvent;
  decision: string | null;
  answers: Record<string, string> | null;
  onDecide: (approvalId: string, decision: "allow" | "deny") => Promise<void>;
  onAnswer: (questionId: string, answers: Record<string, string>) => Promise<void>;
}) {
  switch (event.type) {
    case "user_message":
      return (
        <div className="ml-8 rounded-lg bg-primary/10 px-3 py-2 text-sm whitespace-pre-wrap">
          {String(event.text ?? "")}
        </div>
      );
    case "assistant_text":
      return (
        <div className="rounded-lg bg-muted/60 px-3 py-2">
          <Markdown text={String(event.text ?? "")} />
        </div>
      );
    case "tool_use":
      return (
        <div className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
          <Wrench className="h-3 w-3" aria-hidden />
          {String(event.toolName ?? "tool")}
        </div>
      );
    case "approval_request": {
      const approvalId = String(event.approvalId);
      return (
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <div className="font-medium">Approve {String(event.toolName ?? "action")}?</div>
          <pre className="max-h-32 overflow-auto rounded bg-background/60 p-2 text-xs whitespace-pre-wrap">
            {JSON.stringify(event.input ?? {}, null, 2)}
          </pre>
          {decision ? (
            <Badge variant="outline" className={cn(decision === "allow" ? "text-emerald-700" : "text-destructive")}>
              {decision === "allow" ? "Allowed" : "Denied"}
            </Badge>
          ) : (
            <div className="flex gap-2">
              <Button type="button" size="sm" onClick={() => void onDecide(approvalId, "allow")}>
                Allow
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => void onDecide(approvalId, "deny")}>
                Deny
              </Button>
            </div>
          )}
        </div>
      );
    }
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
