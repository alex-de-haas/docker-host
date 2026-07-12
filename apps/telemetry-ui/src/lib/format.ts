// B / KB / MB formatter for metric byte values (ported from the Shell app-helpers). Kept tiny and
// dependency-free so the metric card can import it without dragging in Shell internals.
export function formatBytes(value: number) {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
