"use client";
import type { ParsedDocument, WorkspacePlan } from "@/lib/types";
import { Progress as ProgressBar } from "@/components/ui/progress";

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
