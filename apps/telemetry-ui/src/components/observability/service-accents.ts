// Theme-aware per-resource data colors for observability visuals — trace-waterfall bars, service dots, and the
// structured-logs source markers. Assigned by first appearance so a given resource keeps its color
// within one view; error/severity styling overrides these where it applies. Colors won't match across
// different views (each assigns by its own appearance order), which is fine — they only disambiguate
// resources within a single list.
export const SERVICE_ACCENTS = [
  "bg-chart-1",
  "bg-chart-2",
  "bg-chart-3",
  "bg-chart-4",
  "bg-chart-5",
];

// Build a stable id→accent map in first-appearance order; later duplicates reuse the first color.
export function buildServiceAccents(ids: Iterable<string>): Map<string, string> {
  const accents = new Map<string, string>();
  for (const id of ids) {
    if (!accents.has(id)) {
      accents.set(id, SERVICE_ACCENTS[accents.size % SERVICE_ACCENTS.length]);
    }
  }
  return accents;
}
