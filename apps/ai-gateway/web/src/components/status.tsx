import { CircleAlert, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

// Ported from Shell alongside the assistant panel, so the moved surface keeps the shapes an operator
// already reads: one box for "something is wrong", one badge for a run state.

export function InlineError({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {message}
    </div>
  );
}

/** `error` means broken; `warning` means it needs attention but may still work. */
export function Alert({ severity, title, detail }: { severity: "error" | "warning"; title: string; detail?: string }) {
  const Icon = severity === "error" ? CircleAlert : TriangleAlert;
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-xs",
        severity === "error"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200",
      )}
    >
      {/* Decorative: the title and detail carry the meaning already. */}
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-0.5">
        <div className="font-medium">{title}</div>
        {detail && <div className="break-words opacity-90">{detail}</div>}
      </div>
    </div>
  );
}

export function StatusBadge({ value }: { value: string }) {
  const normalized = value.toLowerCase();
  // "healthy" is matched exactly so it does not also light up on "unhealthy".
  const running = normalized.includes("running") || normalized.includes("ok") || normalized.includes("ready") || normalized === "healthy";
  const attention = normalized.includes("error") || normalized.includes("failed") || normalized.includes("unknown") || normalized.includes("offline") || normalized.includes("unhealthy") || normalized.includes("degraded");
  // A transitional state is neither good news nor bad news, so it gets its own tone and a pulsing dot.
  const transitional = !running && (normalized.includes("starting") || normalized.includes("stopping") || normalized.includes("thinking") || normalized.includes("working"));
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5",
        (running || attention || transitional) && "border-transparent",
        running && "bg-emerald-500/10 text-emerald-700",
        attention && "bg-amber-500/10 text-amber-700",
        transitional && "bg-sky-500/10 text-sky-700 dark:text-sky-300",
      )}
    >
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          running ? "bg-emerald-500" : attention ? "bg-amber-500" : transitional ? "animate-pulse bg-sky-500" : "bg-muted-foreground",
        )}
      />
      {value}
    </Badge>
  );
}
