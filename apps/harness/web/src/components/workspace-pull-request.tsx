"use client";
import { PullRequestSummary } from "./pull-request-summary";
import { useId, useState } from "react";
import { ChevronDown, ExternalLink, FileDiff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { PullRequestStatus } from "./pull-request-status";
import { PullRequestChecks } from "./pull-request-checks";
import { ciPresentation, prStateLabel, reviewDecisionLabel } from "@/lib/pull-request-presentation";
import { repositoryName, type PullRequest, type Worktree } from "@/lib/development-api";
const webLink = (value: string) => { try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; } };
export function WorkspacePullRequest({ tree, pr, now, onReview }: { tree: Worktree; pr: PullRequest; now: number; onReview: (button: HTMLButtonElement) => void }) {
  const [open, setOpen] = useState(false), summaryId = useId();
  const observation = pr.observation, observed = observation?.at && Number.isFinite(Date.parse(observation.at)) ? observation.at : null;
  const stale = !observed || now - Date.parse(observed) > 90_000;
  const number = pr.url.match(/\/pull\/(\d+)(?:[/?#]|$)/)?.[1], repository = repositoryName(pr.url.split("/pull/")[0]);
  const name = `${repository}${number ? ` #${number}` : ""}`, state = prStateLabel(pr), ci = ciPresentation(pr, stale);
  const canInspect = tree.state === "active", activePr = !observation || observation.state === "open";
  const unpublished = observation?.head && tree.observation?.head && (observation.head !== tree.observation.head || (tree.observation?.local?.files.length ?? 0) > 0);
  const href = webLink(pr.url);
  return <Collapsible open={open} onOpenChange={setOpen} className="min-w-0 overflow-hidden rounded-xl border bg-card" data-slot="pull-request-card">
    <CollapsibleTrigger asChild><Button type="button" variant="ghost" className="h-auto w-full min-w-0 justify-start gap-2 rounded-none px-3 py-3 text-left" aria-describedby={summaryId} aria-label={`${open ? "Collapse" : "Expand"} ${name}: ${observation?.title || "Pull request"}`}>
      <PullRequestSummary icon={<PullRequestStatus pr={pr} stale={stale} />} title={observation?.title || "Pull request"} number={number || "?"} repository={repository} identity={state} ci={ci.label} ciColor={ci.color} descriptionId={summaryId}
        extra={<>{observation?.unresolvedThreads !== undefined && observation.unresolvedThreads >= 0 && <span> · {observation.unresolvedThreads} unresolved {observation.unresolvedThreads === 1 ? "thread" : "threads"}</span>}{observation?.draft && <span> · not ready for review</span>}</>} /><ChevronDown className={`size-3.5 shrink-0 text-muted-foreground ${open ? "rotate-180" : ""}`} aria-hidden />
    </Button></CollapsibleTrigger>
    <CollapsibleContent className="space-y-3 border-t p-3">
      <div className="flex flex-wrap gap-1.5"><Badge variant="outline">{state}</Badge>{observation?.reviewDecision && <Badge variant="outline">{reviewDecisionLabel(observation.reviewDecision)}</Badge>}{pr.historical && <Badge variant="outline">Historical</Badge>}{stale && !pr.historical && <Badge variant="outline">Outdated</Badge>}</div>
      <p className="break-all font-mono text-xs text-muted-foreground">{repository}</p>
      <PullRequestChecks pr={pr} stale={stale} label={name} segmented />
      <p className="text-xs text-muted-foreground">{observation?.commentCount === undefined ? "Discussion comments unknown" : `${observation.commentCount} discussion comments`}</p>
      <p className="text-xs text-muted-foreground">{pr.historical ? "Last observed" : "Observed"}: {observed ? <time dateTime={observed} className="tabular-nums">{new Date(observed).toLocaleString()}</time> : "unavailable"}{pr.historical ? ". Cached check results describe this observation." : stale ? ". Refresh to observe current PR and CI state." : ""}</p>
      {observation?.mergedAt && Number.isFinite(Date.parse(observation.mergedAt)) && <p className="text-xs text-muted-foreground">Merged <time dateTime={observation.mergedAt} className="tabular-nums">{new Date(observation.mergedAt).toLocaleString()}</time></p>}
      {unpublished && activePr && <p className="text-xs text-muted-foreground">Workspace changes are not all in this published PR head.</p>}
      {(pr.unavailable || observation?.error) && <p role="status" className="text-xs text-destructive-foreground">{pr.unavailable || observation?.error}</p>}
      <div className="flex flex-wrap items-center gap-2"><Button type="button" variant="outline" size="sm" aria-label={`Review changes for ${name}`} disabled={!canInspect} title={!canInspect ? "Workspace source is no longer available. Open this pull request on GitHub." : undefined} onClick={event => onReview(event.currentTarget)}><FileDiff className="size-3.5" />{activePr ? "Review changes" : "Inspect published changes"}</Button>
        {href && <Button asChild variant="ghost" size="sm"><a href={href} target="_blank" rel="noopener noreferrer">GitHub<ExternalLink className="size-3" /></a></Button>}
      </div>
    </CollapsibleContent>
  </Collapsible>;
}
