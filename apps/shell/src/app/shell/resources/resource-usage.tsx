"use client";

import { createContext, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { Frame, FrameHeader, FramePanel, FrameTitle } from "@/components/reui/frame";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import type { CoreApp } from "../types";
import { isAppUp } from "../runtime-states";
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
  const warningActivity = activity?.warning ? activity : null;
  const cpu = latest?.cpu ?? null;
  const memory = latest?.memory ?? null;
  const elevated = fresh && elevatedCpu(points);
  const available = points.some(p => p.cpu !== null || p.memory !== null);
  const meanPoints = points.filter(p => p.cpu !== null);
  const mean = meanPoints.length ? meanPoints.reduce((sum, p) => sum + p.cpu!, 0) / meanPoints.length : null;

  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button variant="ghost" size="sm" className="h-auto w-full min-w-0 justify-start gap-1 px-1.5 py-1 text-xs tabular-nums"
        aria-label={`${label} resources: CPU ${formatCpu(cpu)}, RAM ${formatMemory(memory)}${elevated ? ", above recent CPU baseline" : ""}${warningActivity ? `, Core API ${warningActivity.requests60s} calls per minute, high API activity` : ""}`}>
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
          {warningActivity && <span className="flex items-center gap-1.5">
            <span className="w-6 shrink-0 text-[10px] text-muted-foreground">API</span>
            <span>{warningActivity.requests60s.toLocaleString()} / min</span>
            <TriangleAlert className="ml-auto size-3.5 text-warning-foreground" aria-label="High API activity" />
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

function ResourceChart({ points, metric, scale, className = "h-28 w-full" }: { points: ReturnType<typeof resourceSeries>; metric: "cpu" | "memory"; scale?: number; className?: string }) {
  return <ChartContainer config={config} className={className} aria-label={`${metric === "cpu" ? "CPU" : "RAM"} usage history`}>
    <LineChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
      <CartesianGrid vertical={false} />
      <XAxis dataKey="timestamp" type="number" domain={["dataMin", "dataMax"]} tickFormatter={timeLabel} tickLine={false} axisLine={false} minTickGap={40} />
      <YAxis width={72} domain={metric === "cpu" ? [0, scale!] : [0, "auto"]} tick={{ fontSize: 10 }} tickFormatter={v => metric === "cpu" ? `${Math.round(v)}%` : formatMemory(v)} tickLine={false} axisLine={false} />
      <ChartTooltip content={<ChartTooltipContent labelFormatter={(_value, payload) => timeLabel(Number(payload[0]?.payload?.timestamp))} formatter={v => metric === "cpu" ? formatCpu(Number(v)) : formatMemory(Number(v))} />} />
      <Line dataKey={metric} stroke={`var(--color-${metric})`} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
    </LineChart>
  </ChartContainer>;
}

/** Mounted only on Metrics so other app sections do not create resource demand. */
export function AppMetricsPanel({ app, coreOrigin }: { app: CoreApp; coreOrigin: string }) {
  return <ResourceUsageProvider coreOrigin={coreOrigin}>
    <div className="space-y-4">
      <div className="rounded-xl border bg-card p-4"><ApiActivityDetails appId={app.id} /></div>
      <AppServiceMetrics key={app.id} app={app} />
    </div>
  </ResourceUsageProvider>;
}

function AppServiceMetrics({ app }: { app: CoreApp }) {
  const { snapshot } = useContext(Resources);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  // Include workers without endpoints and declared services still awaiting their first sample.
  const services = [...new Set([
    ...(app.health?.services.map(service => service.service) ?? []),
    ...(app.endpoints?.flatMap(endpoint => endpoint.service ? [endpoint.service] : []) ?? []),
    ...Object.keys(app.artifactLocks ?? {}),
    ...(snapshot?.history.at(-1)?.services.filter(sample => sample.appId === app.id).map(sample => sample.service) ?? []),
  ])].sort((a, b) => a.localeCompare(b));
  const service = selectedService && services.includes(selectedService) ? selectedService : services[0] ?? null;
  // Keep selection through new samples; retire it when the selected service disappears.
  if (service !== selectedService) setSelectedService(service);
  const status = app.health?.services.find(item => item.service === service)?.status;
  const active = isAppUp(app.runtimeState) && app.operationStatus !== "updating"
    && !["stopped", "exited", "unknown"].includes(status ?? "");
  const details = service ? <ServiceResourceDetails key={service} appId={app.id} service={service} active={active} /> : null;
  return <section aria-label="Service resources" className="space-y-4">
    <div><h3 className="text-sm font-medium">Service resources</h3><p className="mt-1 text-xs text-muted-foreground">Last 5 minutes · CPU: 100% = one logical core. Local RAM sums process working sets; shared pages can be counted more than once.</p></div>
    {services.length > 1 && service ? <Tabs value={service} onValueChange={setSelectedService} className="min-w-0 gap-3">
      <div className="max-w-full overflow-x-auto overflow-y-hidden pb-1"><TabsList aria-label="Metric service">
        {services.map(name => <TabsTrigger key={name} value={name} className="font-mono">{name}</TabsTrigger>)}
      </TabsList></div>
      <TabsContent value={service} className="min-w-0">{details}</TabsContent>
    </Tabs> : details ?? <p role="status" className="text-sm text-muted-foreground">No service resource observations are available.</p>}
  </section>;
}

function ServiceResourceDetails({ appId, service, active }: { appId: string; service: string; active: boolean }) {
  const { snapshot, fresh, scale } = useContext(Resources);
  const points = useMemo(() => resourceSeries(snapshot, appId, service), [snapshot, appId, service]);
  const latest = fresh && active ? points.at(-1) : undefined;
  const cpu = latest?.cpu ?? null;
  const memory = latest?.memory ?? null;
  const available = points.some(point => point.cpu !== null || point.memory !== null);
  const cpuPoints = points.filter(point => point.cpu !== null);
  const mean = cpuPoints.length ? cpuPoints.reduce((sum, point) => sum + point.cpu!, 0) / cpuPoints.length : null;
  return <Frame aria-label={service + " resources"}>
    <FrameHeader><FrameTitle className="break-all font-mono">{service}</FrameTitle></FrameHeader>
    <FramePanel>
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="min-w-0 space-y-2"><div className="flex flex-wrap justify-between gap-2 text-xs tabular-nums"><span>CPU {formatCpu(cpu)}</span><span className="text-muted-foreground">Average {formatCpu(mean)}</span></div>
          {available && <ResourceChart points={points} metric="cpu" scale={scale} className="h-44 w-full" />}
        </div>
        <div className="min-w-0 space-y-2"><p className="text-xs tabular-nums">RAM {formatMemory(memory)}</p>
          {available && <ResourceChart points={points} metric="memory" className="h-44 w-full" />}
        </div>
      </div>
      {!available && <p role="status" className="mt-3 text-xs text-muted-foreground">Waiting for resource samples.</p>}
      {(!fresh || !active) && <p role="status" className="mt-3 text-xs text-muted-foreground">Live readings unavailable. Retained points are historical.</p>}
      {fresh && active && elevatedCpu(points) && <p className="mt-3 text-xs text-muted-foreground">CPU activity is above its recent baseline.</p>}
    </FramePanel>
  </Frame>;
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
