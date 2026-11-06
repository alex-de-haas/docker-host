export const DOCUMENT_VIEWS = [
  ["home", "Home"],
  ["vision", "Vision"],
  ["ideas", "Ideas"],
  ["features", "Features"],
  ["plans", "Plans"],
  ["reviews", "Reviews"],
  ["tooling", "Tooling"],
] as const;
export type DocumentView = typeof DOCUMENT_VIEWS[number][0];
export function isDocumentView(value: string): value is DocumentView {
  return DOCUMENT_VIEWS.some(([key]) => key === value);
}
export function documentView(pathname: string, query: URLSearchParams): DocumentView {
  const segment = pathname.replace(/^\/|\/$/g, "");
  if (isDocumentView(segment)) return segment;
  const legacy = query.get("view") ?? "";
  return isDocumentView(legacy) ? legacy : "home";
}
export function catalogUrl(query: URLSearchParams): string {
  const next = new URLSearchParams(query);
  const view = documentView("/", next);
  next.delete("view");
  const search = next.toString();
  return `${view === "home" ? "/" : `/${view}`}${search ? `?${search}` : ""}`;
}
export const CATALOG_SCOPE_KEY = "hosty.documents.catalog-scope";
// Explicit empty values preserve All repositories/All apps through browser history.
// Only selectors are retained; searches, status and pagination belong to their URL.
export function restoreCatalogScope(query: URLSearchParams, stored: string | null): URLSearchParams {
  let saved: Record<string, unknown> = {};
  try { const value: unknown = JSON.parse(stored ?? "{}"); if (value && typeof value === "object" && !Array.isArray(value)) saved = value as Record<string, unknown>; } catch { /* Ignore unavailable or malformed preferences. */ }
  const next = new URLSearchParams(query);
  for (const key of ["repository", "app"]) {
    if (!next.has(key)) next.set(key, typeof saved[key] === "string" && saved[key].length <= 2048 ? saved[key] : "");
  }
  return next;
}
