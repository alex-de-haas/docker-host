"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Minus, Pin, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

export type MetricGroup = { group: string; instruments: string[] };

// Left-hand meter/instrument picker for the Metrics page, modelled on the .NET Aspire metric tree
// but with checkboxes so several instruments can be charted at once. Infrastructure (CPU/memory) is
// pinned at the top and always charted, so it is shown read-only and is not part of `selected`.
export function MetricSelectorTree({
  groups,
  pinnedInstruments,
  selected,
  onToggleInstrument,
  onSetGroup,
}: {
  groups: MetricGroup[];
  pinnedInstruments: string[];
  selected: Set<string>;
  onToggleInstrument: (name: string) => void;
  onSetGroup: (names: string[], select: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const needle = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      groups
        .map((entry) => ({
          ...entry,
          instruments: needle
            ? entry.instruments.filter(
                (name) => name.toLowerCase().includes(needle) || entry.group.toLowerCase().includes(needle),
              )
            : entry.instruments,
        }))
        .filter((entry) => entry.instruments.length > 0),
    [groups, needle],
  );

  const toggleCollapsed = (group: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });

  return (
    <aside className="flex w-full shrink-0 flex-col gap-3 rounded-xl border bg-card p-3 lg:w-60">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter metrics"
          aria-label="Filter metrics"
          className="h-8 pl-8 pr-2"
        />
      </div>

      {pinnedInstruments.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 px-0.5 pb-1 text-xs text-muted-foreground">
            <Pin className="h-3.5 w-3.5" /> Infrastructure · always shown
          </div>
          {pinnedInstruments.map((name) => (
            <div key={name} className="flex items-center gap-2 py-1 pl-1 text-sm text-muted-foreground">
              <CheckboxBox state="checked" disabled />
              <span className="truncate" title={name}>
                {name}
              </span>
            </div>
          ))}
        </div>
      )}

      {filtered.length > 0 && pinnedInstruments.length > 0 && <div className="h-px bg-border" />}

      {needle && groups.length > 0 && filtered.length === 0 && (
        <p role="status" className="text-sm text-muted-foreground">No matching metrics</p>
      )}

      {filtered.map(({ group, instruments }) => {
        const selectedCount = instruments.filter((name) => selected.has(name)).length;
        const groupState: CheckState =
          selectedCount === 0 ? "unchecked" : selectedCount === instruments.length ? "checked" : "indeterminate";
        const isCollapsed = collapsed.has(group);
        return (
          <div key={group}>
            <div className="flex items-center gap-1.5 py-1 text-sm font-medium">
              <button
                type="button"
                onClick={() => toggleCollapsed(group)}
                className="telemetry-metric-collapse flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-brand focus-visible:ring-0"
                aria-expanded={!isCollapsed}
                aria-label={isCollapsed ? `Expand ${group}` : `Collapse ${group}`}
              >
                {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                role="checkbox"
                aria-checked={groupState === "indeterminate" ? "mixed" : groupState === "checked"}
                onClick={() => onSetGroup(instruments, groupState !== "checked")}
                className="telemetry-metric-choice flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-brand focus-visible:ring-0"
              >
                <CheckboxBox state={groupState} />
                <span className="truncate" title={group}>
                  {group}
                </span>
              </button>
            </div>
            {!isCollapsed && (
              <div className="pl-[22px]">
                {instruments.map((name) => (
                  <button
                    key={name}
                    type="button"
                    role="checkbox"
                    aria-checked={selected.has(name)}
                    onClick={() => onToggleInstrument(name)}
                    className="telemetry-metric-choice flex w-full items-center gap-2 rounded-sm py-1 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-brand focus-visible:ring-0"
                  >
                    <CheckboxBox state={selected.has(name) ? "checked" : "unchecked"} />
                    <span className="truncate" title={name}>
                      {name}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </aside>
  );
}

type CheckState = "checked" | "unchecked" | "indeterminate";

function CheckboxBox({ state, disabled }: { state: CheckState; disabled?: boolean }) {
  const filled = state === "checked" || state === "indeterminate";
  return (
    <span
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
        filled ? "border-brand-strong bg-brand text-brand-foreground" : "border-input",
        disabled && "opacity-60",
      )}
    >
      {state === "checked" && <Check className="h-3 w-3" />}
      {state === "indeterminate" && <Minus className="h-3 w-3" />}
    </span>
  );
}
