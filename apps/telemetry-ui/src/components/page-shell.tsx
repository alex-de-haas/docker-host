import type { ReactNode } from "react";
import { CircleAlert, type LucideIcon } from "lucide-react";
import { HostyLoader } from "../../../../shared/web/hosty-states";
import { TelemetryMark } from "@/components/telemetry-mark";

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1 sm:basis-64 sm:grow">
        <h1 className="truncate text-2xl font-semibold leading-8">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex min-w-0 max-w-full shrink-0 flex-wrap items-center gap-2 sm:justify-end">{actions}</div>}
    </section>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  loading = false,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  loading?: boolean;
}) {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center gap-3 rounded-xl border bg-card p-6 text-center"
      role={loading ? "status" : undefined}>
      {loading ? <HostyLoader className="size-8" label={null} /> : (
        <div className="relative mb-1">
          <TelemetryMark className="size-14" />
          <span className="absolute -bottom-1 -right-2 flex size-6 items-center justify-center rounded-md border bg-card text-muted-foreground">
            <Icon className="size-3.5" aria-hidden="true" />
          </span>
        </div>
      )}
      <div className="flex max-w-lg flex-col gap-1">
        <div className="text-base font-medium">{title}</div>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
    </div>
  );
}

export function RequestError({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive-soft px-3 py-2 text-sm text-destructive-foreground">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

export function RetainedResults({ children }: { children: ReactNode }) {
  return <p role="status" className="break-words text-sm text-muted-foreground">Showing previously loaded {children}.</p>;
}
