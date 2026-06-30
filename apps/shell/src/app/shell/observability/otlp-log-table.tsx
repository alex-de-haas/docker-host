"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { OtlpLogRecord } from "../types";

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

export function OtlpLogTable({ records, showSource = false }: { records: OtlpLogRow[]; showSource?: boolean }) {
  // Newest first so the latest line is visible without scrolling.
  const ordered = records.slice().reverse();
  return (
    <div className="max-h-[28rem] min-h-0 overflow-auto rounded-md border">
      <table className="w-full border-collapse text-left text-xs">
        <tbody>
          {ordered.map((record) => (
            <tr key={logRowKey(record)} className="border-b align-top last:border-b-0">
              <td className="whitespace-nowrap px-2 py-1.5 font-mono text-muted-foreground">
                {new Date(record.timestampUnixMs).toLocaleTimeString()}
              </td>
              {showSource && (
                <td className="whitespace-nowrap px-2 py-1.5">
                  <Badge variant="outline" className="font-normal">
                    {record.appName || record.appId || "—"}
                  </Badge>
                </td>
              )}
              <td className="px-2 py-1.5">
                <Badge variant="outline" className={cn("border-transparent", severityClasses(record.severityNumber))}>
                  {record.severityText || "LOG"}
                </Badge>
              </td>
              <td className="px-2 py-1.5">
                <div className="break-words font-mono">{record.body || "—"}</div>
                <LogMeta record={record} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LogMeta({ record }: { record: OtlpLogRow }) {
  const attributes = Object.entries(record.attributes ?? {});
  const hasMeta = attributes.length > 0 || Boolean(record.traceId);
  if (!hasMeta) {
    return null;
  }

  return (
    <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
      {record.traceId && <span className="font-mono">trace={record.traceId.slice(0, 8)}…</span>}
      {attributes.map(([key, value]) => (
        <span key={key} className="font-mono">
          {key}={value}
        </span>
      ))}
    </div>
  );
}

// Stable per-row key derived from record fields rather than the array index (which shifts when rows
// are reversed/filtered or new records arrive): timestamp + source app + span/trace id + severity +
// a body prefix. Distinct enough to key a logs table without an explicit record id.
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
