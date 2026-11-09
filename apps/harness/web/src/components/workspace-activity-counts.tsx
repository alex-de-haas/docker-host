import { CircleAlert, CircleHelp, Diamond, Loader2 } from "lucide-react";
import type { ActivityCounts } from "@/lib/workspace-navigation";
const groups = [
  { key: "working", label: "Working", Icon: Loader2, tone: "text-info-foreground", spin: true },
  { key: "waiting", label: "Needs attention", Icon: Diamond, tone: "text-warning-foreground" },
  { key: "failed", label: "Failed", Icon: CircleAlert, tone: "text-destructive-foreground" },
  { key: "unknown", label: "Activity unconfirmed or stopping", Icon: CircleHelp, tone: "text-muted-foreground" },
] as const;
export function WorkspaceActivityCounts({ counts }: { counts: ActivityCounts }) {
  if (!Object.values(counts).some(count => count > 0)) return null;
  return <span className="inline-flex shrink-0 flex-wrap items-center gap-2">{groups.map(group => counts[group.key] > 0 ?
    <span key={group.key} className={`inline-flex items-center gap-1 ${group.tone}`} aria-label={`${group.label}: ${counts[group.key]}`} title={`${group.label}: ${counts[group.key]} ${counts[group.key] === 1 ? "session" : "sessions"}`}>
      <group.Icon aria-hidden="true" className={`size-3.5 ${group.key === "working" ? "motion-safe:animate-spin" : ""}`} /><span aria-hidden="true" className="font-mono text-xs tabular-nums">{counts[group.key]}</span>
    </span> : null)}</span>;
}
