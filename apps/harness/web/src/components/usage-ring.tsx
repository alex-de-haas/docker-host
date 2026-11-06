import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function UsageRing({ value, label, valueText, className, children }: {
  value: number | null; label: string; valueText?: string; className?: string; children: ReactNode;
}) {
  const percentage = value !== null && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
  return <span data-slot="usage-ring" role={percentage === null ? undefined : "meter"} aria-label={label}
    aria-valuemin={percentage === null ? undefined : 0} aria-valuemax={percentage === null ? undefined : 100}
    aria-valuenow={percentage ?? undefined} aria-valuetext={percentage === null ? undefined : valueText}
    className={cn("relative block size-6 shrink-0", className)}>
    <svg viewBox="0 0 28 28" className="size-6 -rotate-90" aria-hidden="true">
      <circle cx="14" cy="14" r="11" fill="none" stroke="currentColor" strokeWidth="2"
        className="text-muted-foreground/25" strokeDasharray={percentage === null ? "2 3" : undefined} />
      {percentage !== null && <circle cx="14" cy="14" r="11" fill="none" stroke="currentColor" strokeWidth="2" pathLength="100"
        strokeDasharray="100" strokeDashoffset={100 - percentage} />}
    </svg>
    <span data-slot="usage-ring-icon" aria-hidden="true" className="absolute inset-0 flex items-center justify-center [&_svg]:size-3">{children}</span>
  </span>;
}
