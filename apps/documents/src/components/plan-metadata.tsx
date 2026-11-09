"use client";
import type { ReactNode } from "react";
import { componentApps } from "@/lib/model";
import type {
  ParsedDocument,
  SourceRepository,
  WorkspacePlan,
} from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Progress as ProgressBar } from "@/components/ui/progress";

export function DocumentMetadata({
  document,
  repository,
}: {
  document: ParsedDocument;
  repository: SourceRepository;
}) {
  const apps = componentApps(repository, document);
  const fields: { label: string; value: ReactNode }[] = [
    {
      label: "Created",
      value: document.created && (
        <time dateTime={document.created} className="tabular-nums">
          {document.created}
        </time>
      ),
    },
    {
      label: "Updated",
      value: document.updated && (
        <time dateTime={document.updated} className="tabular-nums">
          {document.updated}
        </time>
      ),
    },
    { label: "Summary", value: document.summary },
    {
      label: "Related apps",
      value: apps.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {apps.map((app) => (
            <Badge
              key={app.appId}
              variant="secondary"
              className="max-w-full rounded-md whitespace-normal text-left wrap-anywhere"
              title={app.appId}
            >
              {app.name}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      label: "Components",
      value: document.components.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {document.components.map((component, index) => (
            <code
              key={`${component}:${index}`}
              className="max-w-full rounded-md bg-muted px-2 py-0.5 text-xs wrap-anywhere"
            >
              {component}
            </code>
          ))}
        </div>
      ),
    },
  ];
  const visible = fields.filter((field) => Boolean(field.value));
  if (!visible.length) return null;
  return (
    <section
      aria-label="Document metadata"
      className="@container rounded-lg border bg-muted/30 p-3"
    >
      <p className="mb-2 text-xs font-medium text-muted-foreground">Metadata</p>
      <dl className="space-y-2 text-sm leading-5">
        {visible.map((field) => (
          <div
            key={field.label}
            className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-0.5 @sm:grid-cols-[7rem_minmax(0,1fr)]"
          >
            <dt className="text-muted-foreground">{field.label}</dt>
            <dd className="min-w-0 wrap-anywhere">{field.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function Progress({ document }: { document: ParsedDocument | null }) {
  if (document?.kind && document.kind !== "plan") return null;
  if (!document?.progress)
    return <span className="text-muted-foreground">Progress unknown</span>;
  const value = document.progress.total
    ? (100 * document.progress.done) / document.progress.total
    : 0;
  return (
    <div className="inline-flex items-center gap-2">
      <span className="tabular-nums">
        {document.progress.done}/{document.progress.total}
      </span>
      <ProgressBar
        value={value}
        aria-label="Deliverable progress"
        className="w-20"
      />
    </div>
  );
}
export function VersionBrief({ version }: { version: WorkspacePlan }) {
  if (version.label === "completing")
    return <span>Completing: plan deleted, feature.md updated</span>;
  if (version.label === "removed")
    return <span>Document removed in this workspace</span>;
  if (version.error) return <span>Version unavailable: {version.error}</span>;
  if (version.document?.errors.length)
    return <span>Document error; progress unknown</span>;
  if (version.document?.kind && version.document.kind !== "plan")
    return (
      <span>
        {version.label === "new" ? "New document" : "Document changed"}
      </span>
    );
  return (
    <span>
      {version.label === "new" ? "New plan; " : ""}
      {version.document?.status ?? "Status unknown"}
      {version.document?.progress
        ? `, ${version.document.progress.done}/${version.document.progress.total}`
        : ", progress unknown"}
    </span>
  );
}
export function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "unknown";
}

export function DeliverableSummary({ document }: { document: ParsedDocument }) {
  if (!document.progress || !document.deliverables.length) return null;
  const remaining = document.deliverables.filter((item) => !item.done);
  const completed = document.deliverables.filter((item) => item.done);
  const items = (values: typeof remaining) => (
    <ul className="space-y-2 text-sm">
      {values.map((item) => (
        <li key={item.id} className="flex gap-2">
          <Badge
            variant="outline"
            className="h-6 shrink-0 self-start rounded-md font-mono"
          >
            {item.id}
          </Badge>
          <span>{item.text}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <section
      aria-label="Deliverables"
      className="space-y-4 rounded-lg border p-4"
    >
      <h2 className="text-sm font-semibold">
        Remaining deliverables · {remaining.length}
      </h2>
      {remaining.length ? (
        items(remaining)
      ) : (
        <p className="text-sm text-muted-foreground">
          All deliverables are marked complete in this version.
        </p>
      )}
      {!!completed.length && (
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground">
            Completed · {completed.length}
          </summary>
          <div className="mt-3">{items(completed)}</div>
        </details>
      )}
    </section>
  );
}
