import { workflowIsActive, workflowLabel, type DevelopmentWorkspace } from "./development-api";

type Fact = { label: string; tone: "muted" | "success" | "warning" | "danger" | "info"; detail: string };
const fact = (label: string, detail = label, tone: Fact["tone"] = "muted"): Fact => ({ label, detail, tone });
const fresh = (at: string | null | undefined, now: number, maxAge = 90_000) => !!at && Number.isFinite(Date.parse(at)) && now - Date.parse(at) <= maxAge;

export function workspaceRowSummary(workspace: DevelopmentWorkspace, now: number): Fact[] {
  const label = typeof workspace.workflow.state === "string"
    ? workflowLabel(workspace.workflow).replace(/^./, c => c.toUpperCase()) : "Unavailable";
  const facts = [fact(label, `Workspace: ${label}`, workspace.workflow.state === "completed" ? "success" : "muted")];
  const trees = workspace.worktrees;
  if (workflowIsActive(workspace.workflow) && trees.length) {
    const readable = trees.filter(t => t.state === "active" && t.observation?.state === "ok" && t.observation.local
      && (t.observationHealth === "watching" || !t.observationHealth && fresh(t.observation.at, now)));
    const count = readable.reduce((n, t) => n + t.observation!.local!.files.length, 0);
    const partial = readable.length !== trees.length || readable.some(t => t.observation!.local!.truncated);
    if (readable.some(t => t.observation!.conflict)) facts.push(fact("Conflicts", "Unresolved source conflicts", "danger"));
    else if (count) facts.push(fact(`${count}${partial ? "+" : ""} ${count === 1 && !partial ? "file" : "files"}`,
      `${partial ? "At least " : ""}${count} uncommitted ${count === 1 ? "file" : "files"}`, "warning"));
    else facts.push(fact(partial ? "Changes unknown" : "Clean", partial ? "Local changes are not fully observed" : "No uncommitted changes in the latest source observation"));
  }
  // List rows use the shared five-minute background cadence, without promoting every PR to visible demand.
  const pr = workspace.pullRequestSummary;
  if (!pr) {
    if (trees.some(t => t.pullRequests.length)) facts.push(fact("PR unknown", "Pull request summary is unavailable"));
    return facts;
  }
  const observed = pr.observedAt && Number.isFinite(Date.parse(pr.observedAt)) ? `; last observed ${new Date(pr.observedAt).toLocaleString()}` : "";
  const detail = `${pr.count} pull ${pr.count === 1 ? "request" : "requests"}${observed}`;
  if (!pr.partial && pr.state === "merged") facts.push(fact("Merged", `All ${pr.count} pull requests are merged${observed}`, "success"));
  else if (!pr.partial && pr.state === "closed") facts.push(fact("Closed", `Some pull requests closed without merging; ${detail}`));
  else if (pr.state === "unknown") facts.push(fact("PR unknown", `Incomplete pull request observations; ${detail}`));
  else if (!fresh(pr.observedAt, now, 6 * 60_000)) facts.push(fact("PR outdated", `Pull request and CI status need a new observation; ${detail}`));
  else if (pr.checks === "failed") facts.push(fact("CI failed", `At least one open pull request has failing checks; ${detail}`, "danger"));
  else if (pr.checks === "running") facts.push(fact("CI running", `Open pull request checks are running or queued; ${detail}`, "info"));
  else if (pr.partial) facts.push(fact("PR unknown", `Incomplete pull request observations; ${detail}`));
  else if (pr.state === "draft") facts.push(fact("Draft PR", `Open pull requests are drafts; ${detail}`));
  else if (pr.checks === "passed") facts.push(fact("CI passed", `Open pull request checks passed; ${detail}`, "success"));
  else facts.push(fact("PR open", `${pr.checks === "unknown" ? "CI status is unknown" : "No active CI checks"}; ${detail}`));
  return facts;
}
