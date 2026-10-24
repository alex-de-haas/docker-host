import type { ReactNode } from "react";
import { CheckCircle2, CircleAlert, Diamond } from "lucide-react";
import { cn } from "@/lib/utils";
import { DemoMark } from "./DemoMark";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty";
import { HostyLoader } from "../../../../shared/web/hosty-states";

export function DemoLoading({ label = "Loading app data…" }: { label?: string }) {
  return <div role="status" className="flex min-h-48 flex-col items-center justify-center gap-3 p-6">
    <HostyLoader label={null} className="size-8" /><span className="text-sm text-muted-foreground">{label}</span>
  </div>;
}

export function DemoEmpty({ title, children }: { title: string; children?: ReactNode }) {
  return <Empty className="gap-3 px-3 py-6 md:p-6"><EmptyHeader>
    <EmptyMedia><DemoMark className="size-12 text-muted-foreground" /></EmptyMedia>
    <EmptyTitle>{title}</EmptyTitle>{children && <EmptyDescription>{children}</EmptyDescription>}
  </EmptyHeader></Empty>;
}

export function DemoAlert({ children, tone = "danger", action }: {
  children: ReactNode; tone?: "danger" | "warning" | "success"; action?: ReactNode;
}) {
  const Icon = tone === "warning" ? Diamond : tone === "success" ? CheckCircle2 : CircleAlert;
  return <div role={tone === "danger" ? "alert" : "status"} data-slot="alert" className={cn(
    "flex min-w-0 flex-wrap items-start gap-3 rounded-lg border p-3 text-sm",
    tone === "danger" ? "border-destructive/30 bg-destructive-soft text-destructive-foreground"
      : tone === "warning" ? "border-warning/30 bg-warning-soft text-warning-foreground"
      : "border-success/30 bg-success-soft text-success-foreground",
  )}><Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
    <div className="min-w-0 flex-1 wrap-anywhere">{children}</div>{action}
  </div>;
}
