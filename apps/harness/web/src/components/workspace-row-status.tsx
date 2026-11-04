import { Fragment } from "react";
import type { DevelopmentWorkspace } from "@/lib/development-api";
import { workspaceRowSummary } from "@/lib/workspace-row-summary";

const tones = { muted: "text-muted-foreground", success: "text-success-foreground", warning: "text-warning-foreground",
  danger: "text-destructive-foreground", info: "text-info-foreground" };
export function WorkspaceRowStatus({ workspace, now }: { workspace: DevelopmentWorkspace; now: number }) {
  const facts = workspaceRowSummary(workspace, now);
  const description = facts.map(f => f.detail).join(". ");
  return <span className="block truncate text-xs font-normal leading-5 text-muted-foreground" title={description}>
    <span className="sr-only">{description}</span>
    {facts.map((item, i) => <Fragment key={i}>{i > 0 && <span aria-hidden> · </span>}<span className={tones[item.tone]} aria-hidden>{item.label}</span></Fragment>)}
  </span>;
}
