import type { ComponentProps, HTMLAttributes } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type StatusProps = ComponentProps<typeof Badge> & { status: "online" | "offline" | "maintenance" | "degraded" };
export const Status = ({ className, status, ...props }: StatusProps) => <Badge
  className={cn("group gap-1.5", status, className)} variant={status === "online" ? "success" : status === "maintenance" ? "info" : status === "degraded" ? "warning" : "secondary"} {...props} />;

export function StatusIndicator({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span aria-hidden="true" className={cn("inline-flex shrink-0", className)} {...props}>
    <span className="size-2 rounded-full bg-current group-[.maintenance]:hidden group-[.degraded]:hidden group-[.offline]:bg-transparent group-[.offline]:ring-1 group-[.offline]:ring-current" />
    <span className="hidden size-3 rounded-full border-2 border-current border-t-transparent group-[.maintenance]:inline-block motion-safe:animate-spin" />
    <span className="hidden size-2 rotate-45 border border-current group-[.degraded]:inline-block" />
  </span>;
}
export function StatusLabel({ className, children, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={className} {...props}>{children ?? <>
    <span className="hidden group-[.online]:block">Running</span><span className="hidden group-[.offline]:block">Stopped</span>
    <span className="hidden group-[.maintenance]:block">Restarting</span><span className="hidden group-[.degraded]:block">Degraded</span>
  </>}</span>;
}
