"use client";

import { ContextAppIcon } from "@/components/context-app-icon";
import type { ContextApp } from "@/lib/assistant-api";

/** Display metadata never determines which apps belong to the session. */
export function AppContextIcons({ ids, apps = [] }: { ids: string[]; apps?: ContextApp[] }) {
  if (!ids.length) return null;
  const labels = new Map(apps.map(app => [app.id, app]));
  const names = ids.map(id => `${labels.get(id)?.displayName ?? id}${labels.get(id)?.available === false ? " · Unavailable" : ""}`);
  return <span className="flex shrink-0 items-center [&>*+*]:-ml-2" role="img" aria-label={`App context: ${names.join(", ")}`} title={names.join(", ")}>
    {ids.slice(0, 3).map((id, index) => <span key={id} data-slot="context-app-preview" aria-hidden="true"
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-background bg-muted"
      title={names[index]}>
      <ContextAppIcon app={labels.get(id)} className="size-5" />
    </span>)}
    {ids.length > 3 && <span aria-hidden="true" className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-background bg-muted text-xs font-medium">+{ids.length - 3}</span>}
  </span>;
}
