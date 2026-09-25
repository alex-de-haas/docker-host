"use client";

import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Cpu, MemoryStick } from "lucide-react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { Frame, FrameHeader, FramePanel, FrameTitle } from "@/components/reui/frame";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { CoreEventNames, subscribeToCoreEvents } from "../events/core-event-stream";
import { cpuScale, elevatedCpu, formatCpu, formatMemory, mergeResources, resourceSeries, STALE_MS, type ResourceSnapshot } from "./resource-data";

const Resources = createContext<{ snapshot: ResourceSnapshot | null; fresh: boolean; scale: number }>({ snapshot: null, fresh: false, scale: 100 });

export function ResourceUsageProvider({ coreOrigin, children }: { coreOrigin: string; children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null);
  const [fresh, setFresh] = useState(false);
  const cache = useRef<ResourceSnapshot | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    let lastSuccess = 0;
    const sync = async () => {
      if (document.visibilityState !== "visible" || busy) return;
      busy = true;
      try {
        const previous = cache.current;
        const last = previous?.history.at(-1)?.timestamp;
        const query = last ? `?after=${encodeURIComponent(last)}&runId=${encodeURIComponent(previous!.runId)}` : "";
        const response = await fetch(`${coreOrigin}/api/core/resources${query}`, { credentials: "include", signal: controller.signal });
        if (!response.ok) { setFresh(false); return; }
        const next = mergeResources(previous, await response.json() as ResourceSnapshot);
        if (controller.signal.aborted) return;
        cache.current = next;
        lastSuccess = Date.now();
        setSnapshot(next);
        setFresh(Boolean(next.history.length && Date.parse(next.now) - Date.parse(next.history.at(-1)!.timestamp) < STALE_MS));
      } catch { if (!controller.signal.aborted) setFresh(false); }
      finally { busy = false; }
    };
    const unsubscribe = subscribeToCoreEvents(coreOrigin, { names: [CoreEventNames.resourcesChanged], onSync: sync });
    // Shared SSE is primary; this keeps a lease alive and recovers when an intermediary drops events.
    const timer = setInterval(() => {
      if (Date.now() - lastSuccess >= STALE_MS) setFresh(false);
      void sync();
    }, 10_000);
    return () => { controller.abort(); unsubscribe(); clearInterval(timer); };
  }, [coreOrigin]);
  const scale = useMemo(() => cpuScale(snapshot), [snapshot]);
  return <Resources.Provider value={{ snapshot, fresh, scale }}>{children}</Resources.Provider>;
}

const config = { cpu: { label: "CPU", color: "var(--info)" }, memory: { label: "RAM", color: "var(--success)" } };
const timeLabel = (time: number) => new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function ResourceUsage({ appId, service, label }: { appId?: string; service?: string; label: string }) {
  const { snapshot, fresh, scale } = useContext(Resources);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const points = useMemo(() => resourceSeries(snapshot, appId, service), [snapshot, appId, service]);
  const latest = fresh ? points.at(-1) : undefined;
  const cpu = latest?.cpu ?? null;
  const memory = latest?.memory ?? null;
  const elevated = fresh && elevatedCpu(points);
  const available = points.some(p => p.cpu !== null || p.memory !== null);
  const meanPoints = points.filter(p => p.cpu !== null);
  const mean = meanPoints.length ? meanPoints.reduce((sum, p) => sum + p.cpu!, 0) / meanPoints.length : null;

  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button variant="ghost" size="sm" className="h-auto w-full min-w-0 justify-start gap-1 px-1.5 py-1 text-xs tabular-nums"
        aria-label={`${label} resources: CPU ${formatCpu(cpu)}, RAM ${formatMemory(memory)}`}>
        <span className="flex shrink-0 flex-col gap-0.5">
          <span className="flex items-center gap-1"><Cpu aria-hidden="true" /><span>{formatCpu(cpu)}</span>
            {elevated && <span aria-label="Above recent CPU baseline" className="size-1.5 rounded-full bg-primary" />}
          </span>
          <span className="flex items-center gap-1 text-muted-foreground"><MemoryStick aria-hidden="true" />{formatMemory(memory)}</span>
        </span>
        <ChartContainer config={config} className="ml-auto h-7 w-8 shrink-0" aria-hidden="true">
          <LineChart data={points.slice(-30)} margin={{ top: 2, bottom: 2, left: 0, right: 0 }} accessibilityLayer={false}>
            <XAxis hide dataKey="timestamp" type="number" domain={["dataMin", "dataMax"]} />
            <YAxis hide domain={[0, scale]} />
            <Line dataKey="cpu" stroke="var(--color-cpu)" strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls={false} />
          </LineChart>
        </ChartContainer>
      </Button>
    </PopoverTrigger>
    <PopoverContent className="w-[min(24rem,calc(100vw-2rem))] rounded-xl border-0 p-0" align="end" aria-labelledby={titleId}>
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
