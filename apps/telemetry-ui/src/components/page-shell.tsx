import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// Page heading with an optional right-aligned action cluster. Ported from the Shell `ui.tsx` so the
// observability pages keep their exact layout.
export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <h1 className="truncate text-xl font-semibold leading-7">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2 sm:justify-end">{actions}</div>}
    </section>
  );
}

// Centered empty/loading state card. Ported from the Shell `ui.tsx`.
export function EmptyState({
  icon: Icon,
  title,
  description,
  iconClassName,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  iconClassName?: string;
}) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center rounded-lg border bg-card p-6 text-center">
      <Icon className={cn("mb-3 h-6 w-6 text-muted-foreground", iconClassName)} />
      <div className="font-medium">{title}</div>
      {description && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
    </div>
  );
}
