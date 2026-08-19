"use client";

import { Fragment, useMemo, useState } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import { askAssistant } from "@hosty-sdk/app";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { buildServiceAccents, SERVICE_ACCENTS } from "./service-accents";
import type { OtlpLogRecord } from "@/lib/types";

// Severity floors for the OTLP-logs filter, by OTLP SeverityNumber. Shared by the per-app
// observability dialog and the cross-resource Structured logs page.
export const SEVERITY_FILTERS: { label: string; floor: number }[] = [
  { label: "All", floor: 0 },
  { label: "Info+", floor: 9 },
  { label: "Warn+", floor: 13 },
  { label: "Error+", floor: 17 },
];

// A log row is an OTLP record optionally tagged with the source app it came from (set on the
// cross-resource Structured logs view; absent on the single-app dialog).
export type OtlpLogRow = OtlpLogRecord & { appId?: string; appName?: string };

// Structured OTLP logs as an expandable table, matching the trace-waterfall treatment: the message is
// shown inline; clicking a row reveals a details panel with the full body, timing/severity/correlation
// facts, and the raw attribute bag. When rows carry a source app, each gets a per-service color dot so
// resources are easy to tell apart in the merged stream.
export function OtlpLogTable({ records, showSource = false }: { records: OtlpLogRow[]; showSource?: boolean }) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  // Newest first so the latest line is visible without scrolling. Capture each record's original index
  // before reversing: the key uses that (not the reversed position), so appending newer records to the
  // stream doesn't shift existing rows' keys and collapse an expanded panel.
  const ordered = useMemo(
    () => records.map((record, originalIndex) => ({ record, originalIndex })).reverse(),
    [records],
  );
  const accents = useMemo(() => buildServiceAccents(ordered.map(({ record }) => record.appId ?? "")), [ordered]);
  const columnCount = showSource ? 5 : 4;

  return (
    <div className="overflow-hidden rounded-lg border">
      <table className="w-full border-collapse text-left text-xs">
        <thead className="bg-muted/30">
          <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="w-0 px-2 py-2" aria-hidden />
            <th className="px-2 py-2 font-medium">Time</th>
            {showSource && <th className="px-2 py-2 font-medium">Source</th>}
            <th className="px-2 py-2 font-medium">Level</th>
            <th className="px-2 py-2 font-medium">Message</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map(({ record, originalIndex }) => {
            // Records carry no server id, and the content key can still collide for chatty same-span
            // logs (e.g. EF Core DbCommand lines within one millisecond, differing only in SQL past the
            // body-prefix cutoff), so disambiguate with the record's original position to keep React
            // keys unique and stable as the stream grows.
            const key = `${logRowKey(record)}|${originalIndex}`;
            const expanded = expandedKey === key;
            const isError = record.severityNumber >= 17;
            const accent = accents.get(record.appId ?? "") ?? SERVICE_ACCENTS[0];
            const toggle = () => setExpandedKey(expanded ? null : key);
            return (
              <Fragment key={key}>
                <tr
                  tabIndex={0}
                  aria-expanded={expanded}
                  aria-label={`Toggle details of ${record.severityText || "log"} entry`}
                  className={cn(
                    "group cursor-pointer border-b align-top transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none",
                    expanded && "bg-muted/30",
                    isError && !expanded && "bg-red-500/[0.03]",
                  )}
                  onClick={toggle}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggle();
                    }
                  }}
                >
                  <td className="px-2 py-1.5">
                    <ChevronRight
                      className={cn(
                        "h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform group-hover:text-muted-foreground",
                        expanded && "rotate-90 text-muted-foreground",
                      )}
                    />
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 font-mono text-muted-foreground">
                    {new Date(record.timestampUnixMs).toLocaleTimeString()}
                  </td>
                  {showSource && (
                    <td className="whitespace-nowrap px-2 py-1.5">
                      <Badge variant="outline" className="gap-1.5 font-normal">
                        <span aria-hidden className={cn("h-2 w-2 rounded-full", accent)} />
                        {record.appName || record.appId || "—"}
                      </Badge>
                    </td>
                  )}
                  <td className="whitespace-nowrap px-2 py-1.5">
                    <Badge variant="outline" className={cn("border-transparent", severityClasses(record.severityNumber))}>
                      {record.severityText || "LOG"}
                    </Badge>
                  </td>
                  <td className="px-2 py-1.5">
                    <div className={cn("break-words font-mono", isError && "text-red-700 dark:text-red-300")}>
                      {record.body || "—"}
                    </div>
                  </td>
                </tr>
                {expanded && (
                  <tr className="border-b bg-muted/20">
                    <td colSpan={columnCount} className="px-2 pb-3 pt-0.5">
                      <LogDetails record={record} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Hands an error to the operator's assistant — as a **draft**, never a sent message.
 *
 * This app fills in what the operator would otherwise retype: which app, when, how severe, and the
 * message itself. It cannot send, and that is the contract rather than a limitation: text from a log
 * line entering a model that holds host shell is precisely the shape a prompt injection takes, so a
 * human reads it, sees where it came from, and decides.
 *
 * Rendered only for errors: an "ask about this" on every info line would be noise, and the button
 * exists for the moment an operator is already stuck.
 */
function AskAssistantButton({ record }: { record: OtlpLogRow }) {
  const [asked, setAsked] = useState(false);

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-6 shrink-0 px-2 text-[11px]"
      onClick={() => {
        const source = record.appName || record.appId || "unknown app";
        // Plain text, and everything the operator can see: a structured payload would let this app
        // smuggle shape past the glance the design depends on.
        setAsked(
          askAssistant(
            [
              `${source} logged ${record.severityText || "an error"} at ${new Date(record.timestampUnixMs).toLocaleString()}:`,
              record.body || "(no message)",
            ].join("\n\n"),
          ),
        );
      }}
    >
      <Sparkles className="h-3 w-3" aria-hidden />
      {asked ? "Sent to draft" : "Ask Assistant"}
    </Button>
  );
}

// Full-width detail panel for an expanded log entry: the full body, then correlation/severity facts,
// then the raw attribute bag as an aligned key/value list — mirroring the span-details panel.
function LogDetails({ record }: { record: OtlpLogRow }) {
  const attributes = Object.entries(record.attributes ?? {});
  const source = record.appName || record.appId;
  return (
    <div className="space-y-3 rounded-md border bg-card/60 p-3">
      <div className="space-y-1">
        <div className="flex items-start gap-2">
          <div className="flex-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Message</div>
          {record.severityNumber >= 17 && <AskAssistantButton record={record} />}
        </div>
        <div className="whitespace-pre-wrap break-words font-mono text-xs">{record.body || "—"}</div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
        <LogField label="Timestamp" value={new Date(record.timestampUnixMs).toLocaleString()} />
        <LogField label="Severity" value={`${record.severityText || "LOG"} · ${record.severityNumber}`} mono={false} />
        {source && <LogField label="Service" value={source} mono={false} />}
        {record.traceId && <LogField label="Trace ID" value={record.traceId} />}
        {record.spanId && <LogField label="Span ID" value={record.spanId} />}
      </dl>
      {attributes.length > 0 ? (
        <div className="space-y-1.5">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Attributes · {attributes.length}
          </div>
          <div className="overflow-hidden rounded border bg-background/60">
            {attributes.map(([key, value], index) => (
              <div
                key={key}
                className={cn("grid grid-cols-[minmax(0,12rem)_1fr] gap-3 px-2.5 py-1.5 text-[11px]", index > 0 && "border-t")}
              >
                <span className="truncate font-mono text-muted-foreground" title={key}>
                  {key}
                </span>
                <span className="break-all font-mono">{value}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="text-[11px] text-muted-foreground">No attributes recorded.</div>
      )}
    </div>
  );
}

function LogField({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn("break-all text-xs", mono && "font-mono")}>{value}</dd>
    </div>
  );
}

// Content portion of a row key (timestamp + source app + span/trace id + severity + a body prefix).
// The caller appends the ordered-list index to guarantee uniqueness, since records carry no server id
// and this content alone can collide for repeated same-span logs.
function logRowKey(record: OtlpLogRow): string {
  return [
    record.timestampUnixMs,
    record.appId ?? "",
    record.spanId ?? record.traceId ?? "",
    record.severityNumber,
    record.body.slice(0, 80),
  ].join("|");
}

export function severityClasses(severityNumber: number): string {
  if (severityNumber >= 17) {
    return "bg-red-500/10 text-red-700 dark:text-red-300";
  }
  if (severityNumber >= 13) {
    return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  if (severityNumber >= 9) {
    return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  return "bg-muted text-muted-foreground";
}
