"use client";

import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatBytes } from "@/lib/format";
import type { MetricSeries } from "@/lib/types";

// Range presets (seconds) — capped at Core's 1-hour in-memory window. Shared by the per-app
// observability dialog and the cross-resource Metrics page.
export const METRIC_RANGES: { label: string; seconds: number }[] = [
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
  { label: "1h", seconds: 3600 },
];

export function MetricSeriesCard({ series }: { series: MetricSeries }) {
  const unit = metricUnit(series.name);
  const color = metricColor(series.name);
  const data = series.points.map((point) => ({ t: point.timestampUnixMs, v: point.value }));
  const last = series.points.at(-1)?.value;
  // `otel_scope_*` labels only encode the meter (already used for grouping) — drop them from the
  // card subtitle so it shows the dimensions that actually distinguish the series.
  const subtitle = Object.entries(series.labels ?? {})
    .filter(([key]) => !key.startsWith("otel_scope_"))
    .map(([key, value]) => `${key}=${value}`)
    .join(" · ");

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{metricTitle(series.name)}</div>
          {subtitle && <div className="truncate text-xs text-muted-foreground">{subtitle}</div>}
        </div>
        <div className="shrink-0 text-sm font-semibold tabular-nums">
          {last === undefined ? "—" : formatMetricValue(unit, last)}
        </div>
      </div>
      <div className="mt-2 h-28 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -8 }}>
            <defs>
              <linearGradient id={`grad-${color.id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color.stroke} stopOpacity={0.35} />
                <stop offset="100%" stopColor={color.stroke} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="t"
              type="number"
              domain={["dataMin", "dataMax"]}
              scale="time"
              tickFormatter={formatTimeTick}
              tick={{ fontSize: 10 }}
              minTickGap={32}
              stroke="var(--muted-foreground)"
            />
            <YAxis
              width={40}
              tick={{ fontSize: 10 }}
              tickFormatter={(value: number) => formatMetricValue(unit, value)}
              stroke="var(--muted-foreground)"
            />
            <Tooltip
              isAnimationActive={false}
              labelFormatter={(value) => new Date(Number(value)).toLocaleTimeString()}
              formatter={(value) => [formatMetricValue(unit, Number(value)), metricTitle(series.name)]}
              contentStyle={{ fontSize: 12, borderRadius: 6 }}
            />
            <Area
              type="monotone"
              dataKey="v"
              stroke={color.stroke}
              strokeWidth={1.5}
              fill={`url(#grad-${color.id})`}
              isAnimationActive={false}
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

type MetricUnit = "percent" | "bytes" | "number";

function metricUnit(name: string): MetricUnit {
  if (name.endsWith("percent")) {
    return "percent";
  }
  if (name.includes("bytes")) {
    return "bytes";
  }
  return "number";
}

function formatMetricValue(unit: MetricUnit, value: number): string {
  if (unit === "percent") {
    return `${value.toFixed(value < 10 ? 1 : 0)}%`;
  }
  if (unit === "bytes") {
    return formatBytes(value);
  }
  return value >= 1000 ? value.toLocaleString(undefined, { maximumFractionDigits: 1 }) : value.toFixed(value < 10 ? 2 : 0);
}

function metricTitle(name: string): string {
  switch (name) {
    case "container.cpu.percent":
      return "CPU";
    case "container.memory.bytes":
      return "Memory";
    case "container.memory.percent":
      return "Memory %";
    default:
      return name;
  }
}

// Stable per-metric colors that read on light and dark themes (CPU = blue, memory = emerald).
function metricColor(name: string): { id: string; stroke: string } {
  if (name.includes("cpu")) {
    return { id: "cpu", stroke: "#3b82f6" };
  }
  if (name.includes("memory")) {
    return { id: "mem", stroke: "#10b981" };
  }
  return { id: "other", stroke: "#8b5cf6" };
}

function formatTimeTick(value: number): string {
  const date = new Date(value);
  return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

// Pinned pseudo-meter for the docker-stats CPU/memory series Core collects for every container it
// owns. These are always charted in the Metrics view, so they sit outside the checkbox selection.
export const INFRASTRUCTURE_GROUP = "Infrastructure";

// Docker-stats CPU/memory series (name prefix `container.`). Kept out of the selectable set and
// pinned to the top of the Metrics view.
export function isInfrastructureMetric(name: string): boolean {
  return name.startsWith("container.");
}

// Which "meter" (instrumentation scope) a series belongs to, for the selector tree. Infra series are
// grouped as Infrastructure; OTLP series carry their meter name in the `otel_scope_name` label the
// collector's Prometheus exporter promotes; failing that we fall back to the leading namespace
// segment of the instrument name (e.g. "http.client.request.duration" → "http").
export function metricGroup(series: MetricSeries): string {
  if (isInfrastructureMetric(series.name)) {
    return INFRASTRUCTURE_GROUP;
  }
  const scope = series.labels?.["otel_scope_name"];
  if (scope && scope.trim().length > 0) {
    return scope.trim();
  }
  const dot = series.name.indexOf(".");
  return dot > 0 ? series.name.slice(0, dot) : series.name;
}

// Stable React key for a series: name + its labels sorted by key (so insertion order cannot change
// the key), joined by an explicit unit-separator escape (never a literal control character).
export function metricSeriesKey(series: MetricSeries): string {
  const labels = Object.entries(series.labels ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  return `${series.name}\u0001${labels}`;
}
