import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

const stages = ["Choose apps", "Install", "Administrator", "Open"];
/** Stages follow existing Core observations; they do not estimate an installation percentage. */
export function EnvironmentStages({ current }: { current: 0 | 1 | 2 | 3 | null }) {
  return <ol aria-label="Environment setup stages" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
    {stages.map((label, index) => <li key={label} aria-current={index === current ? "step" : undefined}
      className={cn("flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-xs", index === current ? "border-brand-strong bg-brand-soft text-foreground" : "text-muted-foreground")}>
      <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-[10px]", current !== null && index < current && "border-brand-strong text-foreground")}>{current !== null && index < current ? <Check className="size-3" aria-hidden /> : index + 1}</span><span>{label}</span>
    </li>)}
  </ol>;
}
