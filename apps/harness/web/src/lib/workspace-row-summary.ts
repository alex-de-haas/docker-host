import { changeTotals, workflowIsActive, workflowLabel, type DevelopmentWorkspace } from "./development-api";

type Fact = { label: string; tone: "muted" | "success" | "warning" | "danger" | "info"; detail: string;
  lineStats?: { additions: number; deletions: number }; refreshing?: boolean };
const fact = (label: string, detail = label, tone: Fact["tone"] = "muted"): Fact => ({ label, detail, tone });
const fresh = (at: string | null | undefined, now: number, maxAge = 90_000) => !!at && Number.isFinite(Date.parse(at)) && now - Date.parse(at) <= maxAge;

export function workspaceRowSummary(workspace: DevelopmentWorkspace, now: number): Fact[] {
  const label = typeof workspace.workflow.state === "string"
    ? workflowLabel(workspace.workflow).replace(/^./, c => c.toUpperCase()) : "Unavailable";
  const facts = [fact(label, `Workspace: ${label}`, workspace.workflow.state === "completed" ? "success" : "muted")];
  const trees = workspace.worktrees;
  if (workflowIsActive(workspace.workflow) && trees.length) {
    const readable = trees.filter(t => t.state === "active" && t.observation?.state === "ok" && t.observation.local
      && (t.observationHealth === "watching" || t.observationHealth === "pending" || !t.observationHealth && fresh(t.observation.at, now)));
    const sourceStart = facts.length;
    const count = readable.reduce((n, t) => n + t.observation!.local!.files.length, 0);
    const partial = readable.length !== trees.length || readable.some(t => t.observation!.local!.truncated);
    if (readable.some(t => t.observation!.conflict)) facts.push(fact("Conflicts", "Unresolved source conflicts", "danger"));
    else if (count) {
      facts.push(fact(`${count}${partial ? "+" : ""} ${count === 1 && !partial ? "file" : "files"}`,
        `${partial ? "At least " : ""}${count} uncommitted ${count === 1 ? "file" : "files"}`, "warning"));
      if (!partial) {
        const stats = readable.map(t => t.observation!.local!.lineStats ?? changeTotals(t.observation!.local!.files));
        if (stats.every(value => value !== null)) {
          const totals = stats.reduce((sum, value) => ({ additions: sum.additions + value.additions, deletions: sum.deletions + value.deletions }), { additions: 0, deletions: 0 });
          facts.push({ ...fact(`+${totals.additions} −${totals.deletions}`, `${totals.additions} added and ${totals.deletions} deleted lines in uncommitted changes`), lineStats: totals });
        }
      }
    }
    else facts.push(fact(partial ? "Changes unknown" : "Clean", partial ? "Local changes are not fully observed" : "No uncommitted changes in the latest source observation"));
    // Pending retains a successful snapshot while the watcher queues its next scan.
    // Recovery and unavailable snapshots remain unknown rather than reusing clean facts.
    if (readable.some(t => t.observationHealth === "pending")) {
      facts[sourceStart].refreshing = true;
      for (const item of facts.slice(sourceStart)) item.detail += "; showing the last successful source observation while checking for updates";
    }
  }
  // List rows use the shared five-minute background cadence, without promoting every PR to visible demand.
  const pr = workspace.pullRequestSummary;
  if (!pr) {
    if (trees.some(t => t.pullRequests.length)) facts.push(fact("PR unknown", "Pull request summary is unavailable"));
    return facts;
  }
  const observed = pr.observedAt && Number.isFinite(Date.parse(pr.observedAt)) ? `; last observed ${new Date(pr.observedAt).toLocaleString()}` : "";
  const detail = `${pr.count} linked pull ${pr.count === 1 ? "request" : "requests"}${observed}`;
  if (!pr.partial && pr.state === "merged") return [...facts, fact("Merged", `All ${pr.count} pull requests are merged${observed}`, "success")];
  if (!pr.partial && pr.state === "closed") return [...facts, fact("Closed", `Some pull requests closed without merging; ${detail}`)];
  if (pr.state === "unknown") return [...facts, fact("PR unknown", `Incomplete pull request observations; ${detail}`)];
  const open = pr.state === "open" || pr.state === "draft";
  // Total links also include merged history; older Core responses cannot supply an exact open count.
  const count = typeof pr.openCount === "number" && Number.isSafeInteger(pr.openCount) && pr.openCount > 0 && pr.openCount <= pr.count ? pr.openCount : null;
  const drafts = typeof pr.draftCount === "number" && Number.isSafeInteger(pr.draftCount) && pr.draftCount >= 0 && count !== null && pr.draftCount <= count ? pr.draftCount : null;
  const observedOpen = count === null ? "Open pull requests" : `${pr.partial ? "At least " : ""}${count} observed open pull ${count === 1 ? "request" : "requests"}`;
  const draftDetail = drafts ? `, including ${drafts} ${drafts === 1 ? "draft" : "drafts"}` : "";
  if (!fresh(pr.observedAt, now, 6 * 60_000)) {
    const lastKnown = open ? `Last known: ${count === null && pr.state === "draft" ? "Draft pull requests" : observedOpen}${draftDetail}; ` : "";
    return [...facts, fact("PR outdated", `${lastKnown}Pull request and CI status need a new observation; ${detail}${observed ? "" : "; observation time unavailable"}`)];
  }
  if (open) {
    const allDrafts = pr.state === "draft" && !pr.partial;
    const kind = allDrafts ? "draft" : "open";
    const label = count === null ? allDrafts ? "Draft PR" : "PR open" : `${count}${pr.partial ? "+" : ""} ${kind} ${count === 1 && !pr.partial ? "PR" : "PRs"}`;
    const ciDetail = pr.checks === "unknown" ? "CI status is unknown; " : pr.checks === "none" ? "No active CI checks; " : "";
    facts.push(fact(label, `${observedOpen}${draftDetail}; ${ciDetail}${detail}`, allDrafts ? "muted" : "info"));
  }
  if (pr.checks === "failed") facts.push(fact("CI failed", `At least one open pull request has failing checks; ${detail}`, "danger"));
  else if (pr.checks === "running") facts.push(fact("CI running", `Open pull request checks are running or queued; ${detail}`, "info"));
  else if (pr.partial) facts.push(fact("PR unknown", `Incomplete pull request observations; ${detail}`));
  else if (pr.checks === "passed") facts.push(fact("CI passed", `Open pull request checks passed; ${detail}`, "success"));
  else if (!open) facts.push(fact("PR unknown", `Pull request state is unavailable; ${detail}`));
  return facts;
}
