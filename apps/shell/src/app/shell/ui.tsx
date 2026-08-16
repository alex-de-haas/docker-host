"use client";

import type { ComponentProps, ReactNode } from "react";
import { Check, CircleAlert, Copy, LoaderCircle, TriangleAlert } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { AlertSeverity } from "./types";

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

export function IconButton({ title, children, onClick, disabled, destructive }: { title: string; children: ReactNode; onClick: () => void; disabled?: boolean; destructive?: boolean }) {
  return (
    <Button type="button" variant="ghost" size="icon-sm" title={title} aria-label={title} disabled={disabled} onClick={onClick} className={cn(destructive && "text-destructive hover:text-destructive")}>
      {children}
    </Button>
  );
}

// An action button whose in-flight state costs no geometry. Putting the spinner in front of the label
// grows the button by the spinner's width and swaps the Button's padding at the same time (`has-[>svg]`),
// so pressing it shifts the label sideways — and while the two states are both on screen the label reads
// as doubled. Here the label keeps its box and the spinner sits over it, so nothing moves.
export function BusyButton({ busy, children, className, disabled, ...props }: ComponentProps<typeof Button> & { busy?: boolean }) {
  return (
    <Button {...props} aria-busy={busy} disabled={disabled || busy} className={cn("relative", className)}>
      {busy && (
        <span className="absolute inset-0 flex items-center justify-center" aria-hidden>
          <LoaderCircle className="h-4 w-4 animate-spin" />
        </span>
      )}
      {/* Kept in flow rather than replaced, so the button never resizes mid-action. Faded rather than
          hidden: `invisible` would drop the label out of the accessibility tree and leave the button
          nameless for exactly as long as it is working. */}
      <span className={cn("inline-flex items-center gap-2", busy && "opacity-0")}>{children}</span>
    </Button>
  );
}

export function CheckboxRow({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

export function InlineError({ message }: { message: string }) {
  return <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{message}</div>;
}

// One shape for every "something is wrong here" block, so a failed start, an unbound port, and a stale
// manifest do not each invent their own box. `error` means the app is broken; `warning` means it needs
// attention but may still work. The detail keeps the title's colour rather than muted-foreground, which
// washes out against the tinted background.
export function Alert({ severity, title, detail }: { severity: AlertSeverity; title: string; detail?: string }) {
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
      {/* Decorative: the title and detail already carry the meaning, and the severity is conveyed by them
          rather than by the glyph. Announcing it would just prepend a meaningless "graphic". */}
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-0.5">
        <div className="font-medium">{title}</div>
        {detail && <div className="break-words opacity-90">{detail}</div>}
      </div>
    </div>
  );
}

export function EmptyState({ icon: Icon, title, description, iconClassName }: { icon: LucideIcon; title: string; description?: string; iconClassName?: string }) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center rounded-lg border bg-card p-6 text-center">
      <Icon className={cn("mb-3 h-6 w-6 text-muted-foreground", iconClassName)} />
      <div className="font-medium">{title}</div>
      {description && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
    </div>
  );
}

export function StatusBadge({ value }: { value: string }) {
  const normalized = value.toLowerCase();
  // "healthy" is matched exactly so it does not also light up on "unhealthy" (substring match).
  const running = normalized.includes("running") || normalized.includes("ok") || normalized.includes("ready") || normalized === "healthy";
  const attention = normalized.includes("error") || normalized.includes("failed") || normalized.includes("unknown") || normalized.includes("offline") || normalized.includes("unhealthy") || normalized.includes("degraded");
  // A transitional state is neither good news nor bad news, so it gets its own tone and a pulsing dot
  // rather than the neutral grey a terminal "stopped" gets — the point is that something is happening.
  // Container health also reports "starting" (HEALTHCHECK pending), which reads correctly here too, so
  // this branch serves the service rows as well as the app row. `running` is tested first because
  // "healthy"/"running" always win when both could match.
  const transitional = !running && (normalized.includes("starting") || normalized.includes("stopping") || normalized.includes("restarting"));
  return (
    <Badge variant="outline" className={cn("gap-1.5", (running || attention || transitional) && "border-transparent", running && "bg-emerald-500/10 text-emerald-700", attention && "bg-amber-500/10 text-amber-700", transitional && "bg-sky-500/10 text-sky-700 dark:text-sky-300")}>
      <span className={cn("h-2 w-2 rounded-full", running ? "bg-emerald-500" : attention ? "bg-amber-500" : transitional ? "animate-pulse bg-sky-500" : "bg-muted-foreground")} />
      {value}
    </Badge>
  );
}

export function RoleBadge({ role, disabled }: { role: "host.admin" | "host.user"; disabled?: boolean }) {
  if (disabled) {
    return <Badge variant="secondary">Disabled</Badge>;
  }

  return <Badge variant={role === "host.admin" ? "default" : "outline"}>{role === "host.admin" ? "Admin" : "User"}</Badge>;
}

export function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="truncate text-sm font-medium">{value}</div>
    </div>
  );
}

export function FactCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <Fact label={label} value={value} />
    </div>
  );
}

export function CopyField({ label, value, copied, onCopy }: { label: string; value: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <Input value={value} readOnly />
        <Button type="button" variant="outline" onClick={onCopy}>
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
