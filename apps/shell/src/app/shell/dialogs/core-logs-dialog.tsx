"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { isAuthRequiredRedirectError, readCoreError, redirectToCoreLoginIfAuthRequired } from "../core-api";
import type { CoreLogRecord, CoreLogsResponse } from "../types";
import { InlineError } from "../ui";

// Core's own recent log records — the one stream Shell could not show, because Core is not an
// installed app and has no console-logs dialog. Read from Core's in-memory rings rather than
// `~/.hosty/core/logs/core.log`: that file does not exist under a foreground or `npm run dev` Core,
// and the next background start rotates it away.
//
// Two rings, because they have wildly different densities. Measured on a live host over 26.6 h, the
// ASP.NET request pipeline wrote ~96 % of all records and Core's own code ~0.06 % — so "Core" is the
// default view and the request trail is opt-in, rather than the other way round. Severity is the
// secondary control on purpose: every record in that sample was Information, so a severity floor
// alone would have hidden nothing at all.

type Ring = "hosty" | "framework";
type Level = "trace" | "warning" | "error";

const RINGS: { value: Ring; label: string; hint: string }[] = [
  { value: "hosty", label: "Core", hint: "What Core itself decided and did" },
  { value: "framework", label: "Requests", hint: "The HTTP request trail and framework chatter" },
];

const LEVELS: { value: Level; label: string }[] = [
  { value: "trace", label: "All levels" },
  { value: "warning", label: "Warnings+" },
  { value: "error", label: "Errors" },
];

type State = { loading: boolean; error: string | null; records: CoreLogRecord[]; runId: string | null };

export function CoreLogsDialog({
  open,
  coreOrigin,
  onOpenChange,
}: {
  open: boolean;
  coreOrigin: string;
  onOpenChange: (open: boolean) => void;
}) {
  const [ring, setRing] = useState<Ring>("hosty");
  const [level, setLevel] = useState<Level>("trace");
  const [state, setState] = useState<State>({ loading: false, error: null, records: [], runId: null });

  const loadLogs = useCallback(
    async (signal?: AbortSignal) => {
      setState((current) => ({ ...current, loading: true, error: null }));
      try {
        const response = await fetch(
          `${coreOrigin}/api/core/logs?ring=${ring}&level=${level}&tail=500`,
          { credentials: "include", signal },
        );
        redirectToCoreLoginIfAuthRequired(response, coreOrigin);
        if (!response.ok) {
          throw new Error(await readCoreError(response));
        }
        const payload = (await response.json()) as CoreLogsResponse;
        setState({ loading: false, error: null, records: payload.records ?? [], runId: payload.runId ?? null });
      } catch (error) {
        // A superseded request (ring switched, dialog closed) aborts — leave the newer request's state.
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        if (isAuthRequiredRedirectError(error)) {
          return;
        }
        setState({
          loading: false,
          error: error instanceof Error ? error.message : "Core logs are unavailable.",
          records: [],
          runId: null,
        });
      }
    },
    [coreOrigin, level, ring],
  );

  // Refetch on every axis change, and abort the in-flight read so a slow response for the previous
  // ring cannot overwrite the current one.
  useEffect(() => {
    if (!open) {
      return;
    }
    const controller = new AbortController();
    void loadLogs(controller.signal);
    return () => controller.abort();
  }, [loadLogs, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Core logs</DialogTitle>
          <DialogDescription>
            Recent records from the running Core process. Held in memory, so they start at the last
            restart — earlier runs are on the host in <code>core.log</code>.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex min-h-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void loadLogs()} disabled={state.loading}>
              <RefreshCw className={cn("h-4 w-4", state.loading && "animate-spin")} />
              Refresh
            </Button>
            <div className="flex items-center gap-1">
              {RINGS.map((option) => (
                <Button
                  key={option.value}
                  variant={option.value === ring ? "secondary" : "ghost"}
                  size="sm"
                  title={option.hint}
                  onClick={() => setRing(option.value)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              {LEVELS.map((option) => (
                <Button
                  key={option.value}
                  variant={option.value === level ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setLevel(option.value)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>

          {state.error && <InlineError message={state.error} />}

          <div className="min-h-[20rem] min-w-0 max-w-full flex-1 overflow-auto rounded-md bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-50">
            {state.loading && state.records.length === 0 ? (
              <div className="text-zinc-400">Loading logs…</div>
            ) : state.records.length === 0 ? (
              <div className="text-zinc-400">
                {ring === "hosty"
                  ? "Core has not logged anything at this level since it started."
                  : "No requests recorded since Core started."}
              </div>
            ) : (
              state.records.map((record) => <CoreLogLine key={record.sequence} record={record} />)
            )}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function CoreLogLine({ record }: { record: CoreLogRecord }) {
  return (
    <div className="whitespace-pre-wrap break-words">
      <span className="text-zinc-500">{formatTimestamp(record.timestamp)}</span>{" "}
      <span className={levelClass(record.level)}>{record.level.toLowerCase()}</span>{" "}
      <span className="text-zinc-400">{shortCategory(record.category)}</span>{" "}
      <span>{record.message}</span>
      {/* A folded run of identical records: one line, with how many times it happened and when it
          last did. Without this a failing 10-second tick would be the only thing in the ring. */}
      {record.count > 1 && (
        <span className="text-amber-300">
          {" "}
          ×{record.count} (last {formatTimestamp(record.lastSeen)})
        </span>
      )}
      {record.exception && <div className="mt-1 text-rose-300">{record.exception}</div>}
    </div>
  );
}

function levelClass(level: string): string {
  switch (level.toLowerCase()) {
    case "critical":
    case "error":
      return "text-rose-400";
    case "warning":
      return "text-amber-300";
    case "debug":
    case "trace":
      return "text-zinc-500";
    default:
      return "text-sky-300";
  }
}

// `Haas.Hosty.Core.RuntimeAppSupervisorService` is the same fact as `RuntimeAppSupervisorService` and
// costs a third of the line to say.
function shortCategory(category: string): string {
  const parts = category.split(".");
  return parts.length > 1 ? parts[parts.length - 1] : category;
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleTimeString(undefined, { hour12: false });
}
