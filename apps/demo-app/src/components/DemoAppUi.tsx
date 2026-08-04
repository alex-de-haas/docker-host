import type { ReactNode } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { SHELL_DUPLICATED_CHROME_CLASS } from "@hosty-sdk/app";
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
}> = [
  { id: "overview", label: "Overview", href: "/" },
  { id: "people", label: "People", href: "/people" },
  { id: "roles", label: "Roles", href: "/roles" },
  { id: "settings", label: "Settings", href: "/settings" },
];

export function DemoShell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-dvh bg-muted/30">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-6 sm:px-6 lg:px-8">
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
      <div className="min-w-0 space-y-1">
        <p className="truncate text-xs font-medium uppercase tracking-normal text-muted-foreground">
          {eyebrow}
        </p>
        <h1 className="truncate text-xl font-semibold leading-7">{title}</h1>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
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

// The manifest `ui.navigation` pages. A surrounding shell draws them in its own sidebar or pages
// menu, so this copy is hidden there; the page header beside it is not, because a page's own title
// is something no shell renders.
export function DemoNavigation({ active }: { active: DemoRoute }) {
  return (
    <nav
      aria-label="Demo app navigation"
      className={cn("rounded-lg border bg-card p-1 shadow-sm", SHELL_DUPLICATED_CHROME_CLASS)}
    >
      <div className="flex flex-col gap-1 sm:flex-row">
        {demoNavigationItems.map(item => {
          const isActive = item.id === active;

          return (
            <Button
              asChild
              className="w-full justify-start sm:w-auto"
              key={item.id}
              size="sm"
              variant={isActive ? "secondary" : "ghost"}
            >
              <Link href={item.href} aria-current={isActive ? "page" : undefined}>
                {item.label}
              </Link>
            </Button>
          );
        })}
      </div>
    </nav>
  );
}

export function JsonButton({ href }: { href: string }) {
  return (
    <Button asChild variant="outline" size="sm">
      <a href={href}>JSON</a>
    </Button>
  );
}

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
        <div className="break-all text-2xl font-semibold tracking-normal">
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
          <dt className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
            {item.label}
          </dt>
          <dd className="mt-1 break-all text-sm font-medium leading-6">
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
      className={cn("capitalize", className)}
      variant={tone === "danger" ? "destructive" : tone === "success" ? "secondary" : "outline"}
    >
      {children}
    </Badge>
  );
}

export function PeopleList({ users }: { users: AppDirectoryUser[] }) {
  return (
    <div className="grid gap-1">
      {users.map(user => (
        <div
          className="flex min-h-14 items-center justify-between gap-3 border-b py-3 last:border-b-0"
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
            {formatHostRole(user.hostRole)}
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
            <CardDescription className="break-all">{item.path}</CardDescription>
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
                  <li className="break-all rounded-md bg-muted px-2 py-1" key={entry}>
                    {entry}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm leading-6 text-muted-foreground">
                {item.error || "No visible entries."}
              </p>
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
