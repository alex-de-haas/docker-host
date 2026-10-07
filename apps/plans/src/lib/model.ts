import { STATUSES, type ParsedDocument, type PlanCard, type SourceApp, type SourceRepository, type Workspace, type DocumentChange } from "./types";

export type PlanFilters = { search: string; repository: string; app: string; status: string };
export function readFilters(query: URLSearchParams): PlanFilters {
  return { search: query.get("q") ?? "", repository: query.get("repository") ?? "", app: query.get("app") ?? "", status: query.get("status") ?? "" };
}
export function writeFilters(query: URLSearchParams, filters: PlanFilters): URLSearchParams {
  const result = new URLSearchParams(query);
  result.delete("age");
  for (const [key, value] of Object.entries({ q: filters.search, repository: filters.repository, app: filters.app, status: filters.status })) {
    if (value) result.set(key, value); else result.delete(key);
  }
  return result;
}
export function planLink(repositoryId: string, path: string, workspaceId?: string): string {
  const query = new URLSearchParams({ repository: repositoryId, document: path });
  if (workspaceId) query.set("workspace", workspaceId);
  return `/?${query}`;
}
export function documentForCard(card: PlanCard): ParsedDocument | null { return card.document ?? card.workspaces.find(item => item.document)?.document ?? null; }
export function filterPlans(plans: PlanCard[], filters: PlanFilters): PlanCard[] {
  const search = filters.search.trim().toLocaleLowerCase();
  return plans.filter(card => {
    const document = documentForCard(card);
    if (filters.repository && card.repository.id !== filters.repository) return false;
    if (filters.app && !card.apps.some(app => app.appId === filters.app)) return false;
    if (filters.status && (document?.errors.length || document?.status !== filters.status)) return false;
    if (search && !`${document?.title ?? card.path} ${document?.summary ?? ""}`.toLocaleLowerCase().includes(search)) return false;
    return true;
  });
}
export function statusCounts(plans: PlanCard[]) {
  return Object.fromEntries(STATUSES.map(status => [status, plans.filter(card => { const doc = documentForCard(card); return doc?.status === status && !doc.errors.length; }).length]));
}
function normalizePath(path: string): string { return path.replace(/^\.\//, "").replace(/\/+$/, ""); }
function overlaps(left: string, right: string): boolean { return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`); }
export function componentApps(repository: SourceRepository, document: ParsedDocument | null): SourceApp[] {
  if (repository.apps.length === 1) return repository.apps;
  if (!document?.components.length) return repository.apps;
  return repository.apps.filter(app => {
    const paths = [app.manifestSubpath, ...app.paths].filter((item): item is string => Boolean(item)).map(normalizePath);
    return paths.some(path => document.components.some(component => overlaps(normalizePath(component), path)));
  });
}
export function workspaceLabel(workspace: Workspace, change: DocumentChange, featureUpdated?: boolean): "changed" | "new" | "completing" | "removed" {
  if (change.kind === "added") return "new";
  if (change.kind !== "deleted") return "changed";
  const featurePath = change.path.replace(/plan\.md$/, "feature.md");
  const updated = featureUpdated ?? workspace.changes?.some(item => item.path === featurePath && (item.kind === "added" || item.kind === "modified"));
  return updated ? "completing" : "removed";
}
export type DeliverableChange = { id: string; text: string; kind: "added" | "removed" | "completed" | "reopened" | "modified"; previousText?: string };
export function deliverableChanges(base: ParsedDocument | null, current: ParsedDocument | null): DeliverableChange[] | null {
  if (!base || !current || base.errors.length || current.errors.length) return null;
  const before = new Map(base.deliverables.map(item => [item.id, item]));
  const changes: DeliverableChange[] = [];
  const after = new Set(current.deliverables.map(item => item.id));
  for (const item of current.deliverables) {
    const original = before.get(item.id);
    if (!original) { changes.push({ id: item.id, text: item.text, kind: "added" }); continue; }
    const textChanged = original.text !== item.text;
    const kind = !original.done && item.done ? "completed" : original.done && !item.done ? "reopened" : textChanged ? "modified" : null;
    if (kind) changes.push({ id: item.id, text: item.text, kind, ...(textChanged ? { previousText: original.text } : {}) });
  }
  for (const item of base.deliverables) if (!after.has(item.id)) changes.push({ id: item.id, text: item.text, kind: "removed" });
  return changes;
}
export async function mapBounded<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (index < items.length) { const next = index++; results[next] = await work(items[next]); }
  }));
  return results;
}
export type DiffLine = { kind: "same" | "added" | "removed"; text: string };
export function lineDiff(before: string, after: string): { lines: DiffLine[]; abbreviated: boolean } {
  const allA = before.split("\n"), allB = after.split("\n");
  let prefix = 0;
  while (prefix < allA.length && prefix < allB.length && allA[prefix] === allB[prefix]) prefix++;
  let suffix = 0;
  while (suffix < allA.length - prefix && suffix < allB.length - prefix && allA.at(-1 - suffix) === allB.at(-1 - suffix)) suffix++;
  const a = allA.slice(prefix, allA.length - suffix), b = allB.slice(prefix, allB.length - suffix);
  const lines: DiffLine[] = allA.slice(Math.max(0, prefix - 3), prefix).map(text => ({ kind: "same", text }));
  const abbreviated = a.length * b.length > 1_000_000;
  if (abbreviated) { lines.push(...a.slice(0, 1000).map(text => ({ kind: "removed" as const, text })), ...b.slice(0, 1000).map(text => ({ kind: "added" as const, text }))); }
  else {
    const width = b.length + 1;
    const table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i * width + j] = a[i] === b[j] ? 1 + table[(i + 1) * width + j + 1] : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { lines.push({ kind: "same", text: a[i++] }); j++; }
      else if (j < b.length && (i === a.length || table[i * width + j + 1] >= table[(i + 1) * width + j])) lines.push({ kind: "added", text: b[j++] });
      else lines.push({ kind: "removed", text: a[i++] });
    }
  }
  lines.push(...allA.slice(allA.length - suffix, allA.length - suffix + 3).map(text => ({ kind: "same" as const, text })));
  return { lines: lines.slice(0, 2500), abbreviated: abbreviated || lines.length > 2500 };
}
