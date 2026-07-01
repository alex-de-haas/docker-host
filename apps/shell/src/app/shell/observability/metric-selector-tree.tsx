"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Minus, Pin, Search } from "lucide-react";
import { cn } from "@/lib/utils";

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
    <aside className="w-full shrink-0 space-y-3 rounded-lg border p-3 lg:w-60">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter metrics"
          className="h-8 w-full rounded-md border bg-transparent pl-8 pr-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
                className="text-muted-foreground hover:text-foreground"
                aria-label={isCollapsed ? `Expand ${group}` : `Collapse ${group}`}
              >
                {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                onClick={() => onSetGroup(instruments, groupState !== "checked")}
                className="flex min-w-0 items-center gap-2"
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
                    onClick={() => onToggleInstrument(name)}
                    className="flex w-full items-center gap-2 py-0.5 text-left text-sm"
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
        "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border",
        filled ? "border-primary bg-primary text-primary-foreground" : "border-input",
        disabled && "opacity-60",
      )}
    >
      {state === "checked" && <Check className="h-3 w-3" />}
      {state === "indeterminate" && <Minus className="h-3 w-3" />}
    </span>
  );
}
