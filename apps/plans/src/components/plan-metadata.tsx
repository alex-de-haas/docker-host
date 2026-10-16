"use client";
import type { ReactNode } from "react";
import { componentApps } from "@/lib/model";
import type { ParsedDocument, SourceRepository, WorkspacePlan } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Progress as ProgressBar } from "@/components/ui/progress";

export function DocumentMetadata({ document, repository }: { document: ParsedDocument; repository: SourceRepository }) {
  const apps = componentApps(repository, document);
  const fields: { label: string; value: ReactNode }[] = [
    { label: "Created", value: document.created && <time dateTime={document.created} className="tabular-nums">{document.created}</time> },
    { label: "Updated", value: document.updated && <time dateTime={document.updated} className="tabular-nums">{document.updated}</time> },
    { label: "Summary", value: document.summary },
    { label: "Related apps", value: apps.length > 0 && <div className="flex flex-wrap gap-1.5">{apps.map(app => <Badge key={app.appId} variant="secondary" className="max-w-full rounded-md whitespace-normal text-left wrap-anywhere" title={app.appId}>{app.name}</Badge>)}</div> },
    { label: "Components", value: document.components.length > 0 && <div className="flex flex-wrap gap-1.5">{document.components.map((component, index) => <code key={`${component}:${index}`} className="max-w-full rounded-md bg-muted px-2 py-0.5 text-xs wrap-anywhere">{component}</code>)}</div> },
  ];
  const visible = fields.filter(field => Boolean(field.value));
  if (!visible.length) return null;
  return <section aria-label="Document metadata" className="@container rounded-lg border bg-muted/30 p-3">
    <p className="mb-2 text-xs font-medium text-muted-foreground">Metadata</p>
    <dl className="space-y-2 text-sm leading-5">
      {visible.map(field => <div key={field.label} className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-0.5 @sm:grid-cols-[7rem_minmax(0,1fr)]">
        <dt className="text-muted-foreground">{field.label}</dt>
        <dd className="min-w-0 wrap-anywhere">{field.value}</dd>
      </div>)}
    </dl>
  </section>;
}

export function Progress({ document }: { document: ParsedDocument | null }) {
  if (!document?.progress) return <span className="text-muted-foreground">Progress unknown</span>;
  const value = document.progress.total ? 100 * document.progress.done / document.progress.total : 0;
  return <div className="inline-flex items-center gap-2"><span className="tabular-nums">{document.progress.done}/{document.progress.total}</span><ProgressBar value={value} aria-label="Deliverable progress" className="w-20" /></div>;
}
export function VersionBrief({ version }: { version: WorkspacePlan }) {
  if (version.label === "completing") return <span>Completing: plan deleted, feature.md updated</span>;
  if (version.label === "removed") return <span>Removed: feature.md unchanged</span>;
  if (version.error) return <span>Version unavailable: {version.error}</span>;
  if (version.document?.errors.length) return <span>Document error; progress unknown</span>;
  return <span>{version.label === "new" ? "New plan; " : ""}{version.document?.status ?? "Status unknown"}{version.document?.progress ? `, ${version.document.progress.done}/${version.document.progress.total}` : ", progress unknown"}</span>;
}
export function formatTime(value: string | null): string { return value ? new Date(value).toLocaleString() : "unknown"; }
