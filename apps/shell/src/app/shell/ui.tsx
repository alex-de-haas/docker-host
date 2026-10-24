"use client";

import type { ReactNode } from "react";
import { Check, CircleAlert, Copy, LoaderCircle, TriangleAlert } from "lucide-react";
import { HostyEmptySlots, HostyLoader } from "../../../../../shared/web/hosty-states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AlertSeverity } from "./types";

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <h1 className="break-words text-xl font-semibold leading-7">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2 sm:justify-end">{actions}</div>}
    </section>
  );
}

export function IconButton({ title, children, onClick, disabled, destructive }: { title: string; children: ReactNode; onClick: () => void; disabled?: boolean; destructive?: boolean }) {
  return (
    <Button type="button" variant="ghost" size="icon-sm" title={title} aria-label={title} disabled={disabled} onClick={onClick} className={cn(destructive && "text-destructive-foreground hover:text-destructive-foreground")}>
      {children}
    </Button>
  );
}

export function CheckboxRow({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={value => onChange(value === true)} />
      {label}
    </label>
  );
}

export function InlineError({ message }: { message: string }) {
  return <div className="rounded-md border border-destructive/30 bg-destructive-soft px-3 py-2 text-sm text-destructive-foreground">{message}</div>;
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
          ? "border-destructive/30 bg-destructive-soft text-destructive-foreground"
          : "border-warning/30 bg-warning-soft text-warning-foreground",
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

export function EmptyState({ title, description, loading = false, className }: { title: string; description?: string; loading?: boolean; className?: string }) {
  return (
    <div role={loading ? "status" : undefined} aria-busy={loading || undefined} className={cn("flex min-h-32 flex-col items-center justify-center rounded-lg border bg-card p-6 text-center", className)}>
      {loading ? <HostyLoader className="mb-3 size-8" label={null} /> : <HostyEmptySlots className="mb-3 size-12" />}
      <div className="font-medium">{title}</div>
      {description && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
    </div>
  );
}

// `health` composes the app's health fold onto its lifecycle state the way Aspire's dashboard does —
// `running · degraded` — with the *health's* tone, since that is the news. Omitted, or `healthy`,
// and the badge is the lifecycle state alone.
export function StatusBadge({ value, health, compact = false, className, label }: { value: string; health?: string | null; compact?: boolean; className?: string; label?: string }) {
  if (health && health !== "healthy" && health !== "stopped" && health !== "unknown") {
    return <StatusBadge value={`${value} · ${health}`} compact={compact} className={className} label={label} />;
  }

  const normalized = value.toLowerCase();
  const failed = /error|failed|unhealthy|offline/.test(normalized);
  const attention = /degraded|unknown|configuration|approval|needs-attention|quota-exceeded/.test(normalized);
  const transitional = !failed && !attention && /starting|stopping|restarting|updating|preparing|building|installing|finishing|resetting|provisioning/.test(normalized);
  const running = !failed && !attention && !transitional && /running|ready|healthy|^ok$/.test(normalized);
  const tone = failed ? "text-destructive-foreground" : attention ? "text-warning-foreground" : transitional ? "text-info-foreground" : running ? "text-success-foreground" : "text-muted-foreground";
  const glyph = failed ? <CircleAlert aria-hidden className="size-3.5 shrink-0" />
    : attention ? <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
    : transitional ? <LoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
    : <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />;
  if (compact) return <TooltipProvider delayDuration={150}><Tooltip>
    <TooltipTrigger asChild><span role="img" aria-label={value} tabIndex={0} className={cn("inline-flex size-6 items-center justify-center rounded-sm", tone, className)}>{glyph}</span></TooltipTrigger>
    <TooltipContent>{value}</TooltipContent>
  </Tooltip></TooltipProvider>;
  return <span className={cn("inline-flex items-center gap-2 text-sm", tone, className)}>{glyph}<span>{label ?? value.charAt(0).toUpperCase() + value.slice(1)}</span></span>;
}

/** Progress and outcomes use the same labels but never share an animated working glyph. */
export function OperationStatus({ children, tone = "working", className }: {
  children: ReactNode;
  tone?: "working" | "attention" | "failed" | "success";
  className?: string;
}) {
  const Icon = tone === "working" ? LoaderCircle : tone === "attention" ? TriangleAlert : tone === "failed" ? CircleAlert : Check;
  const color = tone === "working" ? "text-info-foreground" : tone === "attention" ? "text-warning-foreground" : tone === "failed" ? "text-destructive-foreground" : "text-success-foreground";
  return <div role="status" className={cn("flex min-w-0 items-start gap-1 text-xs leading-4", color, className)}>
    <Icon aria-hidden className={cn("mt-0.5 size-3 shrink-0", tone === "working" && "animate-spin motion-reduce:animate-none")} />
    <span className="min-w-0 whitespace-normal wrap-anywhere">{children}</span>
  </div>;
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
