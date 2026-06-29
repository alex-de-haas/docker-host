"use client";

import { useState } from "react";
import { Activity, LoaderCircle, RefreshCw, ScrollText } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DialogBody } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatBytes } from "../app-helpers";
import type { CoreApp, DetailPanelState, MetricSeries, OtlpLogRecord } from "../types";
import { EmptyState } from "../ui";

// Range presets (seconds) — capped at Core's 1-hour in-memory window.
const RANGES: { label: string; seconds: number }[] = [
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
  { label: "1h", seconds: 3600 },
];

// Severity floors for the OTLP-logs filter, by OTLP SeverityNumber.
const SEVERITY_FILTERS: { label: string; floor: number }[] = [
  { label: "All", floor: 0 },
  { label: "Info+", floor: 9 },
  { label: "Warn+", floor: 13 },
  { label: "Error+", floor: 17 },
];

export function ObservabilityPanel({
  app,
  detail,
  onRefresh,
}: {
  app: CoreApp;
  detail: DetailPanelState;
  onRefresh: (app: CoreApp, rangeSeconds?: number) => void;
}) {
  const [rangeSeconds, setRangeSeconds] = useState(900);
  const [severityFloor, setSeverityFloor] = useState(0);

  const series = detail.metrics?.series ?? [];
  const records = detail.otlpLogs?.records ?? [];
  const filtered = records.filter((record) => record.severityNumber >= severityFloor);

  const selectRange = (seconds: number) => {
    setRangeSeconds(seconds);
    onRefresh(app, seconds);
  };

  return (
    <DialogBody className="space-y-6">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1">
          {RANGES.map((range) => (
            <Button
              key={range.seconds}
              variant={range.seconds === rangeSeconds ? "secondary" : "ghost"}
              size="sm"
              onClick={() => selectRange(range.seconds)}
            >
              {range.label}
            </Button>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={() => onRefresh(app, rangeSeconds)} disabled={detail.loading}>
          <RefreshCw className={cn("h-4 w-4", detail.loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <section className="space-y-3">
        <h3 className="text-sm font-medium">Metrics</h3>
        {detail.loading ? (
          <EmptyState icon={LoaderCircle} title="Loading metrics" iconClassName="animate-spin" />
        ) : series.length === 0 ? (
          <EmptyState
            icon={Activity}
            title="No metrics"
            description="Metrics appear once the app is running and observability is enabled on the host (HOSTY_OBSERVABILITY_ENABLED)."
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {series.map((entry) => (
              <MetricSeriesCard key={seriesKey(entry)} series={entry} />
            ))}
          </div>
        )}
      </section>

      <section className="flex min-h-0 flex-col space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">OTLP logs</h3>
          <div className="flex gap-1">
            {SEVERITY_FILTERS.map((option) => (
              <Button
                key={option.floor}
                variant={option.floor === severityFloor ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setSeverityFloor(option.floor)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
        {detail.loading ? (
          <EmptyState icon={LoaderCircle} title="Loading logs" iconClassName="animate-spin" />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title="No OTLP logs"
            description="Structured logs appear for apps that opt into telemetry and export the OpenTelemetry logs signal. This is separate from the console (docker logs) view."
          />
        ) : (
          <OtlpLogTable records={filtered} />
        )}
      </section>
    </DialogBody>
  );
}

function MetricSeriesCard({ series }: { series: MetricSeries }) {
  const unit = metricUnit(series.name);
  const color = metricColor(series.name);
  const data = series.points.map((point) => ({ t: point.timestampUnixMs, v: point.value }));
  const last = series.points.at(-1)?.value;
  const subtitle = Object.entries(series.labels)
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

function OtlpLogTable({ records }: { records: OtlpLogRecord[] }) {
  // Newest first so the latest line is visible without scrolling.
  const ordered = records.slice().reverse();
  return (
    <div className="max-h-80 min-h-0 overflow-auto rounded-md border">
      <table className="w-full border-collapse text-left text-xs">
        <tbody>
          {ordered.map((record, index) => (
            <tr key={index} className="border-b align-top last:border-b-0">
              <td className="whitespace-nowrap px-2 py-1.5 font-mono text-muted-foreground">
                {new Date(record.timestampUnixMs).toLocaleTimeString()}
              </td>
              <td className="px-2 py-1.5">
                <Badge variant="outline" className={cn("border-transparent", severityClasses(record.severityNumber))}>
                  {record.severityText || "LOG"}
                </Badge>
              </td>
              <td className="px-2 py-1.5">
                <div className="break-words font-mono">{record.body || "—"}</div>
                <LogMeta record={record} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LogMeta({ record }: { record: OtlpLogRecord }) {
  const attributes = Object.entries(record.attributes ?? {});
  const hasMeta = attributes.length > 0 || Boolean(record.traceId);
  if (!hasMeta) {
    return null;
  }

  return (
    <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
      {record.traceId && <span className="font-mono">trace={record.traceId.slice(0, 8)}…</span>}
      {attributes.map(([key, value]) => (
        <span key={key} className="font-mono">
          {key}={value}
        </span>
      ))}
    </div>
  );
}

function severityClasses(severityNumber: number): string {
  if (severityNumber >= 17) {
    return "bg-red-500/10 text-red-700 dark:text-red-300";
  }
  if (severityNumber >= 13) {
    return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  if (severityNumber >= 9) {
    return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  return "bg-muted text-muted-foreground";
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

function seriesKey(series: MetricSeries): string {
  return `${series.name}${Object.entries(series.labels)
    .map(([key, value]) => `${key}=${value}`)
    .join(",")}`;
}
