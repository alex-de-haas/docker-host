"use client";

import type { ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

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
  const running = normalized.includes("running") || normalized.includes("ok") || normalized.includes("ready");
  const attention = normalized.includes("error") || normalized.includes("failed") || normalized.includes("unknown") || normalized.includes("offline");
  return (
    <Badge variant="outline" className={cn("gap-1.5", (running || attention) && "border-transparent", running && "bg-emerald-500/10 text-emerald-700", attention && "bg-amber-500/10 text-amber-700")}>
      <span className={cn("h-2 w-2 rounded-full", running ? "bg-emerald-500" : attention ? "bg-amber-500" : "bg-muted-foreground")} />
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
