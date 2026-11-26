import { Circle, CircleAlert, Diamond, Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

export function InlineError({ message, className, role = "alert" }: { message: string; className?: string; role?: "alert" | "none" }) {
  return <Alert variant="destructive" role={role} className={className}>
    <CircleAlert aria-hidden />
    <AlertDescription>{message}</AlertDescription>
  </Alert>;
}

export function StatusBadge({ value, label }: { value: string; label?: string }) {
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
      {label ?? value}
    </Badge>
  );
}
