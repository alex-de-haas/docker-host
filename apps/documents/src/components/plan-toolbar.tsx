"use client";

import { RefreshCwIcon, SearchIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { PlanFilters } from "@/lib/model";
import { STATUSES } from "@/lib/types";

type FilterOption = { value: string; label: string; count?: number };

export function PlanToolbar({ filters, repositories, apps, counts, total, onChange, onReset, onRefresh, loading }: {
  filters: PlanFilters;
  repositories: FilterOption[];
  apps: FilterOption[];
  counts: Record<string, number>;
  total: number;
  onChange: (field: keyof PlanFilters, value: string) => void;
  onReset: () => void;
  onRefresh: () => void;
  loading: boolean;
}) {
  const filtered = Object.values(filters).some(Boolean);
  return <section aria-label="Plan filters" className="flex w-full flex-wrap items-center gap-2">
    <InputGroup className="basis-full bg-background sm:min-w-48 sm:flex-1 sm:basis-48">
      <InputGroupInput aria-label="Search plans" type="search" placeholder="Search plans…" value={filters.search} onChange={event => onChange("search", event.target.value)} />
      <InputGroupAddon><SearchIcon aria-hidden="true" /></InputGroupAddon>
    </InputGroup>
    <FilterSelect label="Repository" allLabel="All repositories" value={filters.repository} onChange={value => onChange("repository", value)} options={repositories} className="w-full sm:w-56" />
    <FilterSelect label="App" allLabel="All apps" value={filters.app} onChange={value => onChange("app", value)} options={apps} className="w-full sm:w-48" />
    <FilterSelect label="Status" allLabel="All statuses" allCount={total} value={filters.status} onChange={value => onChange("status", value)} options={STATUSES.map(status => ({ value: status, label: status, count: counts[status] ?? 0 }))} className="w-full sm:w-44" />
    {filtered && <Button type="button" variant="ghost" size="icon" aria-label="Reset filters" title="Reset filters" onClick={onReset}><XIcon aria-hidden="true" /></Button>}
    <Button type="button" variant="outline" size="icon" aria-label="Refresh sources" title="Refresh sources" onClick={onRefresh} disabled={loading}><RefreshCwIcon aria-hidden="true" /></Button>
  </section>;
}

function FilterSelect({ label, allLabel, allCount, value, onChange, options, className }: {
  label: string;
  allLabel: string;
  allCount?: number;
  value: string;
  onChange: (value: string) => void;
  options: FilterOption[];
  className: string;
}) {
  const selected = options.find(option => option.value === value);
  const selectedLabel = value ? selected?.label ?? value : allLabel;
  const count = value ? selected?.count : allCount;
  return <Select value={value ? `value:${value}` : "all"} onValueChange={next => onChange(next === "all" ? "" : next.slice(6))}>
    <SelectTrigger aria-label={label} title={selectedLabel} className={className}>
      <SelectValue><span className="truncate">{selectedLabel}</span>{count !== undefined && <Badge variant="secondary" className="tabular-nums">{count}</Badge>}</SelectValue>
    </SelectTrigger>
    <SelectContent><SelectGroup>
      <SelectItem value="all">{allLabel}{allCount !== undefined && <Badge variant="secondary" className="tabular-nums">{allCount}</Badge>}</SelectItem>
      {options.map(option => <SelectItem key={option.value} value={`value:${option.value}`}>{option.label}{option.count !== undefined && <Badge variant="secondary" className="tabular-nums">{option.count}</Badge>}</SelectItem>)}
    </SelectGroup></SelectContent>
  </Select>;
}
