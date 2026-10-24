import type { CSSProperties } from "react";

// Down the left host, through Core, then up the right host.
const cells = [[10, 10], [10, 39], [10, 68], [39, 39], [68, 68], [68, 39], [68, 10]];

/** A loading mark only; working-state labels and dots keep their own Info-blue semantics. */
export function HostyLoader({ className, label = "Loading" }: { className?: string; label?: string | null }) {
  return <svg viewBox="0 0 100 100" width="24" height="24" className={`hosty-grid-loader ${className ?? ""}`}
    role={label ? "img" : undefined} aria-label={label ?? undefined} aria-hidden={label ? undefined : true}>
    {cells.map(([x, y], index) => <rect key={index} x={x} y={y} width="22" height="22" strokeWidth="3"
      data-core={index === 3 ? "true" : undefined} style={{ "--cell-order": index } as CSSProperties} />)}
  </svg>;
}

/** Empty Shell slots; an action remains an ordinary, accessible button beside the explanation. */
export function HostyEmptySlots({ className }: { className?: string }) {
  return <svg viewBox="0 0 100 100" width="64" height="64" className={`hosty-empty-slots ${className ?? ""}`} aria-hidden="true">
    {cells.map(([x, y], index) => <rect key={index} x={x} y={y} width="22" height="22" strokeWidth="2"
      data-core={index === 3 ? "true" : undefined} strokeDasharray={index === 3 ? undefined : "4 4"} />)}
  </svg>;
}
