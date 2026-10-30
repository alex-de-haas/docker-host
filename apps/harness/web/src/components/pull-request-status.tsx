import { CircleHelp, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import type { PullRequest } from "@/lib/development-api";
import { ciPresentation } from "@/lib/pull-request-presentation";
export function PullRequestStatus({ pr, stale }: { pr: PullRequest; stale: boolean }) {
  const ci = ciPresentation(pr, stale);
  return <PullRequestStateIcon state={!pr.unavailable ? pr.observation?.state : undefined} draft={pr.observation?.draft} ci={ci.label} ciColor={ci.color} stale={stale && !pr.historical} />;
}
export function PullRequestStateIcon({ state, draft, ci, ciColor, stale }: { state?: string; draft?: boolean; ci: string; ciColor: string; stale: boolean }) {
  let Icon = CircleHelp, color = "text-muted-foreground", label = "Pull request status unknown";
  if (state) {
    if (state === "merged") {
      Icon = GitMerge; color = !stale ? "text-violet-600 dark:text-violet-400" : color; label = "Merged pull request";
    } else if (state === "closed") { Icon = GitPullRequestClosed; label = "Closed without merging"; }
    else if (state === "open") {
      if (draft) { Icon = GitPullRequestDraft; label = "Draft pull request"; }
      else { Icon = GitPullRequest; color = ciColor; label = `Open pull request · ${ci}`; }
    }
  }
  return <span role="img" aria-label={label} title={label} className={`mt-0.5 inline-flex size-4 shrink-0 ${color}`}><Icon aria-hidden="true" className="size-4" /></span>;
}
