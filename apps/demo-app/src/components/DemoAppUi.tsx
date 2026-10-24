import type { ReactNode } from "react";
import Link from "next/link";
import { CircleAlert, Diamond, LayoutGrid, Settings, ShieldCheck, Users, type LucideIcon } from "lucide-react";
import { DemoMark } from "./DemoMark";
import { DemoAlert, DemoEmpty } from "./DemoFeedback";
import { HostyNavigationBoundary } from "@hosty-sdk/app/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { StorageInspection } from "@/lib/demo-config";
import type { AppDirectoryUser } from "@/lib/host-auth";

export type DetailItem = {
  label: string;
  value: ReactNode;
};

export type StateTone = "neutral" | "success" | "warning" | "danger";
export type DemoRoute = "overview" | "people" | "roles" | "settings";

const demoNavigationItems: Array<{
  id: DemoRoute;
  label: string;
  href: string;
  icon: LucideIcon;
}> = [
  { id: "overview", label: "Overview", href: "/", icon: LayoutGrid },
  { id: "people", label: "People", href: "/people", icon: Users },
  { id: "roles", label: "Roles", href: "/roles", icon: ShieldCheck },
  { id: "settings", label: "Settings", href: "/settings", icon: Settings },
];

export function DemoShell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-dvh bg-background">
      <div className="mx-auto flex w-full max-w-7xl min-w-0 flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        {children}
      </div>
    </main>
  );
}

export function DemoPageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <HostyNavigationBoundary><div className="mb-2 flex items-center gap-2 text-sm font-medium">
          <DemoMark tile className="size-7" /><span>Demo App</span>
          <span className="truncate font-mono text-xs font-normal text-muted-foreground">{eyebrow}</span>
        </div></HostyNavigationBoundary>
        <h1 className="wrap-anywhere text-2xl font-semibold">{title}</h1>
        {description && (
          <p className="max-w-[72ch] text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          {actions}
        </div>
      )}
    </section>
  );
}

// Custom page navigation obeys the host policy independently of the surrounding frame.
// Contextual page titles and actions remain outside this boundary.
export function DemoNavigation({ active }: { active: DemoRoute }) {
  return (
    <HostyNavigationBoundary><nav
      aria-label="Demo app navigation"
      className="demo-navigation -mt-2 border-b"
    >
      <div className="flex gap-1 overflow-x-auto pb-2">
        {demoNavigationItems.map(item => {
          const isActive = item.id === active;

          return (
            <Button
              asChild
              className="justify-start"
              key={item.id}
              size="sm"
              variant="ghost"
            >
              <Link href={item.href} aria-current={isActive ? "page" : undefined}>
                <item.icon data-icon="inline-start" aria-hidden="true" />{item.label}
              </Link>
            </Button>
          );
        })}
      </div>
    </nav></HostyNavigationBoundary>
  );
}

export { JsonButton } from "./JsonInspector";

export function MetricCard({
  label,
  value,
  icon: Icon,
  description,
}: {
  label: string;
  value: ReactNode;
  icon: LucideIcon;
  description?: ReactNode;
}) {
  return (
    <Card className="gap-3">
      <CardHeader className="flex flex-row items-center justify-between gap-3 pb-0">
        <CardTitle className="text-sm font-medium">{label}</CardTitle>
        <div className="rounded-lg bg-muted p-2 text-muted-foreground">
          <Icon className="size-4" aria-hidden="true" />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        <div className="wrap-anywhere font-mono text-xl font-semibold tabular-nums">
          {value}
        </div>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </CardContent>
    </Card>
  );
}

export function SectionCard({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function DetailList({ items }: { items: DetailItem[] }) {
  return (
    <dl className="grid gap-4">
      {items.map(item => (
        <div
          className="border-b pb-4 last:border-b-0 last:pb-0"
          key={item.label}
        >
          <dt className="text-xs font-medium text-muted-foreground">
            {item.label}
          </dt>
          <dd className="mt-1 wrap-anywhere font-mono text-xs leading-5">
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function StateBadge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: StateTone;
  className?: string;
}) {
  return (
    <Badge
      className={cn("max-w-full whitespace-normal text-left", className)}
      variant={tone === "danger" ? "destructive" : tone === "success" ? "success" : tone === "warning" ? "warning" : "secondary"}
    >
      {tone === "danger" ? <CircleAlert aria-hidden="true" /> : tone === "warning" ? <Diamond aria-hidden="true" /> : null}
      {children}
    </Badge>
  );
}

export function PeopleList({ users }: { users: AppDirectoryUser[] }) {
  return (
    <div className="grid gap-1">
      {users.map(user => (
        <div
          className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b py-3 last:border-b-0"
          key={user.id}
        >
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">
              {user.displayName || user.email || user.id}
            </div>
            <div className="truncate text-sm text-muted-foreground">
              {user.email || user.id}
            </div>
          </div>
          <StateBadge tone={user.hostRole === "host.admin" ? "success" : "neutral"}>
            {user.sandboxRole ? `Sandbox · ${user.sandboxRole}` : formatHostRole(user.hostRole ?? "unknown")}
          </StateBadge>
        </div>
      ))}
    </div>
  );
}

export function StorageGrid({ storage }: { storage: StorageInspection[] }) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {storage.map(item => (
        <Card className="gap-4" key={item.key}>
          <CardHeader>
            <CardTitle>{item.label}</CardTitle>
            <CardDescription className="wrap-anywhere font-mono text-xs">{item.path}</CardDescription>
            <CardAction>
              <StateBadge tone={item.exists ? "success" : "danger"}>
                {item.exists ? "mounted" : "missing"}
              </StateBadge>
            </CardAction>
          </CardHeader>
          <CardContent>
            {item.entries.length > 0 ? (
              <ul className="grid gap-2 text-sm">
                {item.entries.map(entry => (
                  <li className="wrap-anywhere rounded-md bg-muted px-2 py-1 font-mono text-xs" key={entry}>
                    {entry}
                  </li>
                ))}
              </ul>
            ) : (
              item.error ? <DemoAlert>{item.error}</DemoAlert> : <DemoEmpty title="No visible entries" />
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function formatHostRole(role: string) {
  switch (role) {
    case "host.admin":
      return "Host admin";
    case "host.user":
      return "Host user";
    default:
      return role;
  }
}
