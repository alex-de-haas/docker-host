import { CircleHelp, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import type { PullRequest } from "@/lib/development-api";
import { ciPresentation } from "@/lib/pull-request-presentation";
export function PullRequestStatus({ pr, stale }: { pr: PullRequest; stale: boolean }) {
  const observation = pr.observation;
  let Icon = CircleHelp, color = "text-muted-foreground", label = "Pull request status unknown";
  if (observation && !pr.unavailable) {
    if (observation.state === "merged") {
      Icon = GitMerge; color = !stale || pr.historical ? "text-violet-600 dark:text-violet-400" : color; label = "Merged pull request";
    } else if (observation.state === "closed") { Icon = GitPullRequestClosed; label = "Closed without merging"; }
    else if (observation.state === "open") {
      if (observation.draft) { Icon = GitPullRequestDraft; label = "Draft pull request"; }
      else { Icon = GitPullRequest; const ci = ciPresentation(pr, stale); color = ci.color; label = `Open pull request · ${ci.label}`; }
    }
  }
  return <span role="img" aria-label={label} title={label} className={`mt-0.5 inline-flex size-4 shrink-0 ${color}`}><Icon aria-hidden="true" className="size-4" /></span>;
}
