import { CircleAlert, CircleHelp, Diamond, Loader2 } from "lucide-react";
import type { AssistantSession } from "@/lib/assistant-api";
import { activityTime, isWaiting } from "@/lib/attention";

function statusLabel(status: string) {
  const labels: Record<string, string> = { idle: "Idle", completed: "Completed", running: "Working", failed: "Failed",
    awaiting_approval: "Awaiting approval", awaiting_question: "Awaiting answer", stopping: "Stopping", unknown: "Activity unknown" };
  return labels[status] ?? status.replaceAll("_", " ").replace(/^./, c => c.toUpperCase());
}

export function SessionActivityIndicator({ status }: { status: string }) {
  const indicator = status === "running" ? { label: "Working", Icon: Loader2, tone: "text-info-foreground motion-safe:animate-spin" }
    : isWaiting(status) ? { label: "Needs attention", Icon: Diamond, tone: "text-warning-foreground" }
    : status === "failed" ? { label: "Failed", Icon: CircleAlert, tone: "text-destructive-foreground" }
    : ["unknown", "stopping"].includes(status) ? { label: "Activity unconfirmed or stopping", Icon: CircleHelp, tone: "text-muted-foreground" }
    : null;
  return indicator && <span className="inline-flex shrink-0" aria-label={indicator.label} title={indicator.label}>
    <indicator.Icon aria-hidden="true" className={`size-3.5 ${indicator.tone}`} />
  </span>;
}

export function SessionRowStatus({ session, now }: { session: AssistantSession; now: number }) {
  const at = activityTime(session);
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  const relative = seconds < 60 ? "Just now" : seconds < 3600 ? `${Math.floor(seconds / 60)} min ago`
    : seconds < 86400 ? `${Math.floor(seconds / 3600)} h ago` : `${Math.floor(seconds / 86400)} d ago`;
  const label = statusLabel(session.status);
  return <span className="block truncate text-xs font-normal leading-5 text-muted-foreground">
    {label}<span aria-hidden> · </span>{at > 0
      ? <time dateTime={new Date(at).toISOString()} title={`Last activity: ${new Date(at).toLocaleString()}`}>{relative}</time>
      : <span>Activity time unavailable</span>}
  </span>;
}
