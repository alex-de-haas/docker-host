import type { ReactNode } from "react";

/** Shared two-line content; the owning surface supplies its navigation/disclosure button. */
export function PullRequestSummary({ icon, title, number, repository, identity, ci, ciColor, descriptionId, extra }: {
  icon: ReactNode; title: string; number: string | number; repository: string; identity: string;
  ci: string; ciColor: string; descriptionId?: string; extra?: ReactNode;
}) {
  return <>{icon}<span className="min-w-0 flex-1"><span className="flex min-w-0 items-start gap-2 text-xs font-medium">
    <span className="min-w-0 truncate" title={title}>{title}</span><span className="shrink-0 font-mono font-normal tabular-nums text-muted-foreground">#{number}</span>
  </span><span id={descriptionId} className="mt-1 flex min-w-0 items-center text-xs font-normal text-muted-foreground">
    <span className="min-w-0 flex-1 truncate" title={`${repository} · ${identity}`}><span className="font-mono">{repository}</span><span> · </span><span>{identity}</span></span><span className="shrink-0 whitespace-pre"> · </span><span className={`shrink-0 ${ciColor}`}>{ci}</span>{extra && <span className="min-w-0 truncate">{extra}</span>}
  </span></span></>;
}
