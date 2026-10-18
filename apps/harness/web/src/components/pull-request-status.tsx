import { CircleHelp, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import type { PullRequest } from "@/lib/development-api";

const passed = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const failed = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STALE", "STARTUP_FAILURE"]);
const pending = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);

export function PullRequestStatus({ pr, stale }: { pr: PullRequest; stale: boolean }) {
  const observation = pr.observation;
  let Icon = CircleHelp;
  let color = "text-muted-foreground";
  let label = "Pull request status unknown";
  let dot: string | undefined;
  if (observation && !pr.unavailable) {
    if (observation.state === "merged") {
      Icon = GitMerge; color = "text-violet-500"; label = "Merged pull request";
    } else if (observation.state === "closed") {
      Icon = GitPullRequestClosed; color = "text-red-600 dark:text-red-400"; label = "Closed without merging";
    } else if (observation.state === "open") {
      if (observation.draft) {
        Icon = GitPullRequestDraft; label = "Draft pull request";
      } else {
        Icon = GitPullRequest; color = "text-foreground";
        const states = observation.checks?.map(check => check.state.toUpperCase());
        let ci = "CI unknown";
        dot = "bg-muted-foreground";
        if (stale) ci = "CI status outdated";
        else if (!observation.error && states) {
          if (states.length === 0) ci = "No CI checks reported";
          else if (states.some(state => failed.has(state))) { ci = "CI failed"; dot = "bg-red-500"; }
          else if (states.some(state => pending.has(state))) { ci = "CI in progress"; dot = "bg-amber-500"; }
          else if (states.every(state => passed.has(state))) { ci = "CI passed"; dot = "bg-emerald-500"; }
        }
        label = `Open pull request · ${ci}`;
      }
    }
  }
  return <span role="img" aria-label={label} title={label} className={`relative mt-0.5 inline-flex size-4 shrink-0 ${color}`}>
    <Icon aria-hidden="true" className="size-4" />
    {dot && <span aria-hidden="true" className={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background ${dot}`} />}
  </span>;
}
