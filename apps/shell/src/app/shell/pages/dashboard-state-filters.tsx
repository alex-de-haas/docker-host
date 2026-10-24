"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { matchesAppStateFilter, type AppStateFilter } from "../runtime-states";
import type { CoreApp } from "../types";

const filters = [
  { key: "all", label: "total", title: "All" },
  { key: "running", label: "running", title: "Running" },
  { key: "transitioning", label: "in progress", title: "In progress" },
  { key: "attention", label: "need attention", title: "Attention" },
  { key: "updates", label: "updates", title: "Updates" },
] as const;

export function DashboardStateFilters({ apps, filter, onFilterChange }: {
  apps: CoreApp[];
  filter: AppStateFilter;
  onFilterChange: (filter: AppStateFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const wide = useRef<HTMLDivElement>(null);
  // Counts describe the full host, independently of the table's search query.
  const counters = filters.map(item => {
    const count = apps.filter(app => matchesAppStateFilter(app, item.key)).length;
    return { ...item, count, description: `${count} ${item.key === "updates" && count === 1 ? "update" : item.label}` };
  }).filter(item => item.key !== "transitioning" || item.count > 0 || filter === item.key);
  const selected = counters.find(item => item.key === filter)!;
  const select = (key: AppStateFilter) => onFilterChange(filter === key ? "all" : key);

  useEffect(() => {
    if (!open) return;
    const dashboard = trigger.current?.closest(".dashboard-layout");
    if (!dashboard) return;
    // The menu is portalled: close it when the container query hides its trigger.
    // CSS owns the breakpoint; no viewport or second width threshold is needed here.
    const observer = new ResizeObserver(() => {
      if (!trigger.current?.getClientRects().length) setOpen(false);
    });
    observer.observe(dashboard);
    return () => observer.disconnect();
  }, [open]);

  return <>
    <div ref={wide} className="dashboard-state-filters-wide flex flex-wrap items-center gap-1" role="group" aria-label="Filter apps by state">
      {counters.map(({ key, title, count, description }) => <Button
        key={key}
        variant={filter === key ? "secondary" : "ghost"}
        size="sm"
        className={cn("gap-1.5 text-muted-foreground", filter === key && "bg-accent text-accent-foreground")}
        aria-label={description}
        title={description}
        aria-pressed={filter === key}
        onClick={() => select(key)}
      >
        <span>{title}</span><span className="font-medium text-foreground">{count}</span>
      </Button>)}
    </div>
    <div className="dashboard-state-filters-compact">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button ref={trigger} variant={filter === "all" ? "outline" : "secondary"} size="sm"
            aria-label={`Filter apps by state: ${selected.title}, ${selected.description}`}>
            <span>{selected.title}</span><span className="tabular-nums">{selected.count}</span>
            <ChevronDown data-icon="inline-end" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onCloseAutoFocus={event => {
          if (!trigger.current?.getClientRects().length) {
            event.preventDefault();
            wide.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
          }
        }}>
          <DropdownMenuLabel>Filter apps by state</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={filter}>
            {counters.map(({ key, title, count, description }) => <DropdownMenuRadioItem
              key={key} value={key} aria-label={`${title}, ${description}`} onSelect={() => select(key)}>
              <span>{title}</span><span className="ml-auto tabular-nums">{count}</span>
            </DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </>;
}
