import { CirclePause, Loader2, WifiOff } from "lucide-react";
import type { HarnessActivity } from "../../../src/harness/activity";
import type { StreamConnection } from "@/lib/assistant-api";
import { summarizeToolUse } from "@/lib/tool-display";

export function AssistantActivity({ status, activity, connection, stopping, appNames }: {
  status: string;
  activity: HarnessActivity | null;
  connection: StreamConnection;
  stopping: boolean;
  appNames: Record<string, string>;
}) {
  const active = ["running", "awaiting_approval", "awaiting_question"].includes(status);
  if ((!active && !stopping) || connection === "disconnected") return null;
  let label = "Working…";
  let detail: string | undefined;
  let waiting = false;
  if (connection !== "connected") label = connection === "connecting" ? "Connecting…" : "Reconnecting…";
  else if (stopping) label = "Stopping…";
  else if (status === "awaiting_approval" || status === "awaiting_question") {
    label = status === "awaiting_approval" ? "Waiting for approval…" : "Waiting for your answer…";
    waiting = true;
  } else if (activity?.tool) {
    const tool = activity.tool;
    const labels: Record<string, string> = {
      Read: "Reading file…", Write: "Writing file…", Edit: "Editing file…", MultiEdit: "Editing files…",
      FileChange: "Editing files…", Command: "Running command…", Bash: "Running command…",
      Grep: "Searching…", Glob: "Finding files…", WebSearch: "Searching the web…", WebFetch: "Reading web page…",
      ToolSearch: "Finding tools…",
    };
    label = labels[tool.toolName] ?? `Running ${summarizeToolUse(tool.toolName, undefined, appNames, tool.mcp).label}…`;
    detail = tool.detail;
    if (activity.toolCount > 1) label += ` (+${activity.toolCount - 1} active)`;
  } else if (activity?.phase === "thinking") label = "Thinking…";
  else if (activity?.phase === "responding") label = "Writing response…";

  return <div role="status" aria-live="polite" aria-atomic="true" data-slot="assistant-activity"
    className="flex min-w-0 items-start gap-2 px-3 py-2 text-xs text-muted-foreground">
    {waiting ? <CirclePause className="size-3.5 shrink-0" aria-hidden /> : connection === "reconnecting"
      ? <WifiOff className="size-3.5 shrink-0" aria-hidden />
      : <span className="motion-safe:animate-spin shrink-0" aria-hidden><Loader2 className="size-3.5" /></span>}
    <span className="min-w-0 wrap-anywhere">{label}{detail && <span className="mt-1 block">{detail}</span>}</span>
  </div>;
}
