"use client";

import { createContext, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { Frame, FrameHeader, FramePanel, FrameTitle } from "@/components/reui/frame";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { watchResources } from "./resource-stream";
import { currentApiActivity, apiActivitySeries, cpuScale, elevatedCpu, formatCpu, formatMemory, resourceSeries, type ResourceSnapshot } from "./resource-data";

const Resources = createContext<{ snapshot: ResourceSnapshot | null; fresh: boolean; scale: number }>({ snapshot: null, fresh: false, scale: 100 });

export function ResourceUsageProvider({ coreOrigin, children }: { coreOrigin: string; children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null);
  const [fresh, setFresh] = useState(false);
  useEffect(() => watchResources(coreOrigin, view => {
    setSnapshot(view.snapshot);
    setFresh(view.fresh);
  }), [coreOrigin]);
  const scale = useMemo(() => cpuScale(snapshot), [snapshot]);
  return <Resources.Provider value={{ snapshot, fresh, scale }}>{children}</Resources.Provider>;
}

const config = { calls: { label: "Core API calls/min", color: "var(--chart-3)" }, cpu: { label: "CPU", color: "var(--chart-1)" }, memory: { label: "RAM", color: "var(--chart-2)" } };
const timeLabel = (time: number) => new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function ResourceUsage({ appId, service, label }: { appId?: string; service?: string; label: string }) {
  const { snapshot, fresh, scale } = useContext(Resources);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const points = useMemo(() => resourceSeries(snapshot, appId, service), [snapshot, appId, service]);
  const latest = fresh ? points.at(-1) : undefined;
  const activity = fresh && !service && appId !== "hosty.core" ? currentApiActivity(snapshot, appId) : null;
  const showApi = !service && appId !== "hosty.core";
  const cpu = latest?.cpu ?? null;
  const memory = latest?.memory ?? null;
  const elevated = fresh && elevatedCpu(points);
  const available = points.some(p => p.cpu !== null || p.memory !== null);
  const meanPoints = points.filter(p => p.cpu !== null);
  const mean = meanPoints.length ? meanPoints.reduce((sum, p) => sum + p.cpu!, 0) / meanPoints.length : null;

  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button variant="ghost" size="sm" className="h-auto w-full min-w-0 justify-start gap-1 px-1.5 py-1 text-xs tabular-nums"
        aria-label={`${label} resources: CPU ${formatCpu(cpu)}, RAM ${formatMemory(memory)}${elevated ? ", above recent CPU baseline" : ""}${showApi ? `, Core API ${activity ? `${activity.requests60s} calls per minute` : "unavailable"}${activity?.warning ? ", high API activity" : ""}` : ""}`}>
        <span className="flex w-full min-w-0 flex-col gap-1 font-mono">
          {(["cpu", "memory"] as const).map(metric => <span key={metric} className="grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)_3.5rem] items-center gap-1.5">
            <span className="w-6 shrink-0 text-[10px] text-muted-foreground">{metric === "cpu" ? "CPU" : "RAM"}</span>
            <span className="min-w-0 truncate text-left">{metric === "cpu" ? formatCpu(cpu) : formatMemory(memory)}</span>
            <ChartContainer config={config} className="h-4 w-14 shrink-0" aria-hidden="true">
              <LineChart data={points} margin={{ top: 2, bottom: 2, left: 0, right: 0 }} accessibilityLayer={false}>
                <XAxis hide dataKey="timestamp" type="number" domain={["dataMin", "dataMax"]} />
                <YAxis hide domain={metric === "cpu" ? [0, scale] : [0, "auto"]} />
                <Line dataKey={metric} stroke={`var(--color-${metric})`} strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls={false} />
              </LineChart>
            </ChartContainer>
          </span>)}
          {showApi && <span className="flex items-center gap-1.5">
            <span className="w-6 shrink-0 text-[10px] text-muted-foreground">API</span>
            <span>{activity ? `${activity.requests60s.toLocaleString()} / min` : "—"}</span>
            {activity?.warning && <TriangleAlert className="ml-auto size-3.5 text-warning-foreground" aria-label="High API activity" />}
          </span>}
        </span>
      </Button>
    </PopoverTrigger>
    <PopoverContent className="max-h-[min(85vh,var(--radix-popover-content-available-height))] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border-0 p-0" align="end" aria-labelledby={titleId}>
      <Frame>
        <FrameHeader>
          <FrameTitle id={titleId}>{label}</FrameTitle>
          <p className="text-xs text-muted-foreground">Last 5 minutes · CPU: 100% = one logical core</p>
        </FrameHeader>
        {!available ? <FramePanel><p className="text-sm text-muted-foreground">Waiting for resource samples.</p></FramePanel> : (
          <>
            <FramePanel className="flex flex-col gap-2">
              <div className="flex justify-between text-xs"><span>CPU {formatCpu(cpu)}</span><span className="text-muted-foreground">Average {formatCpu(mean)}</span></div>
              {open && <ResourceChart points={points} metric="cpu" scale={scale} />}
              {elevated && <p className="text-xs text-muted-foreground">CPU activity is above its recent baseline.</p>}
            </FramePanel>
            <FramePanel className="flex flex-col gap-2">
              <p className="text-xs">RAM {formatMemory(memory)}</p>
              {open && <ResourceChart points={points} metric="memory" />}
              <p className="text-xs text-muted-foreground">Local RAM sums process working sets; shared pages can be counted more than once.</p>
            </FramePanel>
          </>
        )}
        {showApi && <FramePanel><ApiActivityDetails appId={appId} chart={open} /></FramePanel>}
        {!fresh && <p role="status" className="px-3 py-1 text-xs text-muted-foreground">Live readings unavailable. Retained points are historical.</p>}
      </Frame>
    </PopoverContent>
  </Popover>;
}

function ResourceChart({ points, metric, scale }: { points: ReturnType<typeof resourceSeries>; metric: "cpu" | "memory"; scale?: number }) {
  return <ChartContainer config={config} className="h-28 w-full" aria-label={`${metric === "cpu" ? "CPU" : "RAM"} usage history`}>
    <LineChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
      <CartesianGrid vertical={false} />
      <XAxis dataKey="timestamp" type="number" domain={["dataMin", "dataMax"]} tickFormatter={timeLabel} tickLine={false} axisLine={false} minTickGap={40} />
      <YAxis width={72} domain={metric === "cpu" ? [0, scale!] : [0, "auto"]} tick={{ fontSize: 10 }} tickFormatter={v => metric === "cpu" ? `${Math.round(v)}%` : formatMemory(v)} tickLine={false} axisLine={false} />
      <ChartTooltip content={<ChartTooltipContent labelFormatter={(_value, payload) => timeLabel(Number(payload[0]?.payload?.timestamp))} formatter={v => metric === "cpu" ? formatCpu(Number(v)) : formatMemory(Number(v))} />} />
      <Line dataKey={metric} stroke={`var(--color-${metric})`} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
    </LineChart>
  </ChartContainer>;
}

export function ApiActivityDetails({ appId, chart = true }: { appId?: string; chart?: boolean }) {
  const { snapshot, fresh } = useContext(Resources);
  const activity = fresh ? currentApiActivity(snapshot, appId) : null;
  const points = useMemo(() => apiActivitySeries(snapshot, appId), [snapshot, appId]);
  const envelope = snapshot?.apiActivity ?? snapshot?.history.at(-1)?.apiActivity;
  return <section className="space-y-3" aria-label="Core API activity">
    <h4 className="text-sm font-medium">Core API activity</h4>
    {activity ? <>
      <dl className="grid grid-cols-3 gap-2 text-xs tabular-nums">
        <div><dt className="text-muted-foreground">Last 10 s</dt><dd>{activity.requests10s.toLocaleString()} calls</dd></div>
        <div><dt className="text-muted-foreground">Last minute</dt><dd>{activity.requests60s.toLocaleString()} calls</dd></div>
        <div><dt className="text-muted-foreground">This Core run</dt><dd>{activity.totalRequests.toLocaleString()} calls</dd></div>
      </dl>
      {activity.warning && <p role="status" className="flex items-start gap-2 text-xs text-warning-foreground">
        <TriangleAlert className="size-4 shrink-0" aria-hidden />
        <span>High API activity{appId ? "" : " in an application"}: {activity.warning.reason === "burst" ? "request burst" : "sustained traffic"} since {new Date(activity.warning.since).toLocaleTimeString()}.
          {" "}{activity.warning.requests} eligible calls / {activity.warning.windowSeconds} s; threshold {activity.warning.threshold}. Requests continue normally.</span>
      </p>}
      {!activity.warning && activity.recoveredAt && <p className="text-xs text-muted-foreground">Activity recovered at {new Date(activity.recoveredAt).toLocaleTimeString()}.</p>}
      <p className="text-xs text-muted-foreground">{activity.eligibleRequests60s.toLocaleString()} calls in the last minute count toward warnings. Health checks and telemetry transport are excluded.</p>
    </> : <p role="status" className="text-xs text-muted-foreground">{envelope?.enabled === false ? "API accounting is disabled in Core settings." : "API activity is unavailable. This requires a connected Core with API counters."}</p>}
    {chart && points.some(point => point.calls !== null) && <ChartContainer config={config} className="h-28 w-full" aria-label="Core API calls per minute history">
      <LineChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="timestamp" type="number" domain={["dataMin", "dataMax"]} tickFormatter={timeLabel} tickLine={false} axisLine={false} minTickGap={40} />
        <YAxis width={45} domain={[0, "auto"]} allowDecimals={false} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
        <ChartTooltip content={<ChartTooltipContent labelFormatter={(_value, payload) => timeLabel(Number(payload[0]?.payload?.timestamp))} />} />
        <Line dataKey="calls" stroke="var(--color-calls)" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
      </LineChart>
    </ChartContainer>}
    <p className="text-xs text-muted-foreground">Exact incoming Core requests, shared by all services of the app. Streams count once when opened. Counts reset with Core or app reinstallation.</p>
  </section>;
}
