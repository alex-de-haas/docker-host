"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { panelKey, type ToolActivity, type UiPanel } from "@hosty-sdk/app/ui/types";
import { CoreEventNames, subscribeToCoreEvents } from "../events/core-event-stream";
import { cn } from "@/lib/utils";

type ActivityContext = { read: (panel: UiPanel) => ToolActivity; refresh: () => void };
const idle = (panel: UiPanel): ToolActivity => ({ panel: panel.panel, state: panel.available ? "idle" : "no-connection",
  count: null, label: null, reportedAt: null, expiresAt: null });
const Activity = createContext<ActivityContext>({ read: idle, refresh: () => {} });
export const useToolActivity = () => useContext(Activity);

export function ToolActivityProvider({ coreOrigin, userId, children }: {
  coreOrigin: string; userId: string | null; children: ReactNode;
}) {
  const scope = JSON.stringify([coreOrigin, userId]);
  const [snapshot, setSnapshot] = useState<{ scope: string; values: Map<string, ToolActivity>; unavailable: boolean }>({
    scope, values: new Map(), unavailable: false,
  });
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  useEffect(() => {
    if (!userId) return;
    let live = true, active = true, sequence = 0, attempt = 0;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined, expiry: ReturnType<typeof setTimeout> | undefined;
    const unavailable = () => setSnapshot(previous => previous.scope === scope
      ? { ...previous, unavailable: true } : { scope, values: new Map(), unavailable: true });
    async function sync() {
      if (!active) return;
      const current = ++sequence;
      clearTimeout(retry);
      try {
        const response = await appFetch("/api/hosty/ui/activity", { credentials: "include", cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        if (!response.ok) throw new Error("Tool activity unavailable");
        const body = await response.json() as { activities: ToolActivity[] };
        if (!Array.isArray(body.activities)) throw new Error("Invalid tool activity");
        if (!live || !active || current !== sequence) return;
        const values = new Map(body.activities.map(value => [panelKey(value.panel), value]));
        attempt = 0;
        setSnapshot({ scope, values, unavailable: false });
        clearTimeout(expiry);
        const deadlines = body.activities.filter(v => v.state === "working" && v.expiresAt)
          .map(v => Date.parse(v.expiresAt!)).filter(Number.isFinite);
        if (deadlines.length) expiry = setTimeout(() => { void sync(); }, Math.max(250, Math.min(...deadlines) - Date.now() + 50));
      } catch {
        if (!live || !active || current !== sequence) return;
        unavailable();
        const delay = [1000, 3000, 10_000, 30_000][Math.min(attempt++, 3)];
        retry = setTimeout(() => { void sync(); }, delay);
      }
    }
    const unsubscribe = subscribeToCoreEvents(coreOrigin, {
      names: [CoreEventNames.toolActivityChanged], onSync: sync, topic: "tool-activity",
      onStreamState: state => {
        active = state !== "inactive";
        if (!active) { ++sequence; clearTimeout(retry); clearTimeout(expiry); }
        if (live && state === "error") unavailable();
      },
    });
    return () => { live = false; controller.abort(); unsubscribe(); clearTimeout(retry); clearTimeout(expiry); };
  }, [coreOrigin, userId, scope, refreshGeneration]);
  const value = useMemo<ActivityContext>(() => ({
    read: panel => {
      const current = snapshot.scope === scope ? snapshot.values.get(panelKey(panel.panel)) : undefined;
      if (snapshot.scope === scope && snapshot.unavailable)
        return { ...idle(panel), state: "no-connection", reportedAt: current?.reportedAt ?? null };
      return current ?? idle(panel);
    },
    refresh: () => setRefreshGeneration(g => g + 1),
  }), [snapshot, scope]);
  return <Activity.Provider value={value}>{children}</Activity.Provider>;
}

export const activityNames = { idle: "Idle", working: "Working", "needs-you": "Needs you", failed: "Failed", "no-connection": "No connection" };
export function activitySummary(values: ToolActivity[]) {
  const failed = values.filter(v => v.state === "failed").length;
  const needsYou = values.filter(v => v.state === "needs-you").length;
  return { count: failed + needsYou, state: failed ? "failed" : needsYou ? "needs-you"
    : values.some(v => v.state === "working") ? "working" : "idle" };
}
export function ToolActivityMark({ activity, compact = false }: { activity: ToolActivity; compact?: boolean }) {
  if (compact && activity.state === "idle") return null;
  const label = activityNames[activity.state] + (activity.count ? ` · ${activity.count}` : "")
    + (activity.label ? ` — ${activity.label}` : "");
  const lastReport = activity.state === "no-connection"
    ? activity.reportedAt ? `Last report: ${new Date(activity.reportedAt).toLocaleString()}` : "No reports yet" : null;
  return <span className={cn("inline-flex min-w-0 items-center gap-1 text-xs",
    activity.state === "failed" ? "text-destructive" : activity.state === "needs-you" ? "text-warning-foreground" : "text-muted-foreground")}
    title={lastReport ? `${label}. ${lastReport}` : label} aria-label={compact ? label : undefined} data-tool-activity={activity.state}>
    <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full bg-current", activity.state === "working" && "motion-safe:animate-pulse")} />
    {!compact && <span className="min-w-0 truncate">{label}{lastReport && <span className="block text-[10px]">{lastReport}</span>}</span>}
  </span>;
}
export function ToolsActivityBadge({ values }: { values: ToolActivity[] }) {
  const summary = activitySummary(values);
  if (!summary.count) return null;
  return <span className={cn("ml-1 rounded-full px-1.5 text-xs", summary.state === "failed"
    ? "bg-destructive/10 text-destructive" : "bg-warning-soft text-warning-foreground")}
    aria-label={`${summary.count} tools need you`}>{summary.count}</span>;
}
