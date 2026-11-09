"use client";

import { useState, type ReactNode } from "react";
import { ChevronRight, MessageSquare } from "lucide-react";
import type { FeedbackTranscriptCard } from "../../../src/feedback/presentation";
import { Markdown } from "./markdown";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";

type FeedbackMessageCardProps = { card?: FeedbackTranscriptCard; originalText: string; loading?: boolean };
const count = (value: number, noun: string) => `${value} ${noun}${value === 1 ? "" : "s"}`;
const application = (report: FeedbackTranscriptCard["reports"][number]) => `${report.appName || report.appId} · ${report.version ?? "Version unknown"}`;
function summary(report: FeedbackTranscriptCard["reports"][number]) {
  const text = (report.comment.trim() || report.annotations.find(note => note.text.trim())?.text || "No comment").replace(/\s+/g, " ").trim();
  const characters = Array.from(text);
  return characters.length > 180 ? characters.slice(0, 179).join("") + "…" : text;
}

/** A reviewed feedback snapshot; evidence stays outside the transcript's rendering path. */
export function FeedbackMessageCard({ card, originalText, loading = false }: FeedbackMessageCardProps) {
  const annotationCount = card?.reports.reduce((total, report) => total + report.annotations.length, 0) ?? 0;
  const screenshotCount = card?.reports.reduce((total, report) => total + report.annotations.filter(note => note.hasImage).length, 0) ?? 0;
  return <article aria-label="Submitted feedback" data-slot="feedback-message-card" className="ml-3 min-w-0 space-y-2 rounded-lg bg-primary/10 px-3 py-2 text-sm sm:ml-8">
    <header className="flex items-center gap-1.5 font-medium"><MessageSquare className="size-3.5 shrink-0" aria-hidden />Feedback submitted</header>
    {card ? <>
      <p className="text-xs text-muted-foreground">{count(card.reports.length, "report")} · {count(annotationCount, "annotation")} · {count(screenshotCount, "screenshot")}</p>
      <ul aria-label="Feedback summary" className="space-y-2">{card.reports.slice(0, 3).map(report => <li key={report.id} className="min-w-0">
        <p className="truncate text-xs text-muted-foreground">{application(report)}</p>
        <p className="line-clamp-2 wrap-anywhere">{summary(report)}</p>
      </li>)}</ul>
      {card.reports.length > 3 && <p className="text-xs text-muted-foreground">{count(card.reports.length - 3, "more report")}</p>}
      <FeedbackDisclosure label="Details">
        <div aria-label="Feedback details" className="space-y-4 border-t border-primary/10 pt-3">
          {card.instruction.trim() && <section className="min-w-0 space-y-1"><h4 className="text-xs font-medium text-muted-foreground">Additional instructions</h4><Markdown text={card.instruction} /></section>}
          <ol className="space-y-4">{card.reports.map((report, index) => <li key={report.id} className="min-w-0 space-y-2">
            <h4 className="text-sm font-medium wrap-anywhere">Report {index + 1}: {application(report)}</h4>
            {report.comment.trim() && <Markdown text={report.comment} />}
            <ol className="space-y-3">{report.annotations.map((note, noteIndex) => <li key={note.id} className="min-w-0 space-y-1 border-l border-primary/20 pl-3">
              <p className="text-xs font-medium text-muted-foreground">Annotation {noteIndex + 1}</p>
              <Markdown text={note.text} />
              {note.route && <p className="text-xs text-muted-foreground wrap-anywhere">Route: {note.route}</p>}
            </li>)}</ol>
          </li>)}</ol>
        </div>
      </FeedbackDisclosure>
    </> : <p role="status" className="text-xs text-muted-foreground">{loading ? "Loading feedback details…" : "Feedback details are unavailable."}</p>}
    <FeedbackDisclosure label="Original request"><pre aria-label="Original feedback request" className="max-h-80 overflow-auto rounded-md border border-primary/10 bg-background/50 p-3 font-mono text-xs whitespace-pre-wrap wrap-anywhere">{originalText}</pre></FeedbackDisclosure>
  </article>;
}

function FeedbackDisclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <Collapsible open={open} onOpenChange={setOpen}>
    <CollapsibleTrigger asChild><Button type="button" variant="ghost" size="sm" className="h-auto min-h-7 justify-start gap-1 px-1 py-1 text-xs text-muted-foreground"><ChevronRight className={`size-3 shrink-0 ${open ? "rotate-90" : ""}`} aria-hidden />{label}</Button></CollapsibleTrigger>
    <CollapsibleContent className="pt-2">{open && children}</CollapsibleContent>
  </Collapsible>;
}
