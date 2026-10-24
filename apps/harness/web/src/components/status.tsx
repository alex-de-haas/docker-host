import { Circle, CircleAlert, Diamond, Loader2, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

// Ported from Shell alongside the assistant panel, so the moved surface keeps the shapes an operator
// already reads: one box for "something is wrong", one badge for a run state.

export function InlineError({ message }: { message: string }) {
  return (
    <div className="min-w-0 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm wrap-anywhere text-destructive-foreground">
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
          ? "border-destructive/30 bg-destructive/10 text-destructive-foreground"
          : "border-warning-foreground/30 bg-warning-soft text-warning-foreground",
      )}
    >
      {/* Decorative: the title and detail carry the meaning already. */}
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-0.5">
        <div className="font-medium">{title}</div>
        {detail && <div className="wrap-anywhere">{detail}</div>}
      </div>
    </div>
  );
}

export function StatusBadge({ value }: { value: string }) {
  const normalized = value.toLowerCase();
  // "healthy" is matched exactly so it does not also light up on "unhealthy".
  const working = ["running", "starting", "stopping", "thinking", "working"].some(state => normalized.includes(state));
  const waiting = ["awaiting_approval", "awaiting_question"].includes(normalized);
  const running = !working && (normalized.includes("ok") || normalized.includes("ready") || normalized === "healthy");
  const failed = normalized.includes("error") || normalized.includes("failed") || normalized.includes("unhealthy");
  const attention = waiting || normalized.includes("unknown") || normalized.includes("offline") || normalized.includes("degraded");
  // A working ring remains distinct from a ready/idle dot when motion is reduced.
  const transitional = working;
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5",
        (running || attention || transitional || failed) && "border-transparent",
        running && "bg-success-soft text-success-foreground",
        failed && "bg-destructive/10 text-destructive-foreground",
        attention && "bg-warning-soft text-warning-foreground",
        transitional && "bg-info-soft text-info-foreground",
      )}
    >
      {failed ? <CircleAlert className="size-3 shrink-0" aria-hidden="true" />
        : running ? <span className="size-2 shrink-0 rounded-full bg-success-foreground" aria-hidden="true" />
        : normalized.includes("offline") ? <Circle className="size-3 shrink-0" aria-hidden="true" />
        : attention ? <Diamond className="size-3 shrink-0" aria-hidden="true" />
        : transitional ? <span className="inline-flex shrink-0 motion-safe:animate-spin" aria-hidden="true"><Loader2 className="size-3" /></span>
        : <span className="size-2 shrink-0 rounded-full bg-muted-foreground" aria-hidden="true" />}
      {value}
    </Badge>
  );
}
