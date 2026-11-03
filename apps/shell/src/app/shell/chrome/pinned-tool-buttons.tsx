"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { PanelsTopLeft } from "lucide-react";
import { panelKey, type UiPanel } from "@hosty-sdk/app/ui/types";
import { Button } from "@/components/ui/button";
import { AppIcon } from "../app-icon";
import { useToolActivity, ToolActivityMark, activityNames } from "./tool-activity";
import { cn } from "@/lib/utils";

export function fitPinnedTools(available: number, labelled: number, count: number) {
  const compact = labelled > available;
  return { compact, visible: compact ? Math.min(count, Math.max(0, Math.floor((available + 4) / 36))) : count };
}

export function PinnedToolButtons({ panels, selectedKey, selectedKeys, onSelect }: {
  panels: UiPanel[]; selectedKey?: string; selectedKeys?: string[]; onSelect: (panel: UiPanel) => void;
}) {
  const activity = useToolActivity();
  const root = useRef<HTMLDivElement>(null), measure = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ compact: false, visible: panels.length });
  useLayoutEffect(() => {
    const container = root.current, labels = measure.current;
    if (!container || !labels) return;
    const update = () => {
      const next = fitPinnedTools(container.getBoundingClientRect().width, labels.getBoundingClientRect().width, panels.length);
      setLayout(current => current.compact === next.compact && current.visible === next.visible ? current : next);
    };
    update();
    const observer = new ResizeObserver(update); observer.observe(container); observer.observe(labels);
    return () => observer.disconnect();
  }, [panels]);
  return <div ref={root} className="relative min-w-0 flex-1 overflow-hidden" data-pinned-tools data-compact={layout.compact}>
    <div ref={measure} aria-hidden inert className="pointer-events-none invisible absolute top-0 left-0 flex w-max items-center gap-1" data-pinned-measure>
      {panels.map(item => <span key={panelKey(item.panel)} className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-sm font-medium"><span className="size-4" />{item.label}</span>)}
    </div>
    <div className="flex items-center justify-end gap-1">
      {panels.slice(0, layout.visible).map(item => {
        const selected = selectedKeys?.includes(panelKey(item.panel)) ?? selectedKey === panelKey(item.panel);
        const action = `${selected ? "Hide" : "Open"} ${item.appName} — ${item.label}`;
        return <Button key={panelKey(item.panel)} type="button" variant="ghost" size={layout.compact ? "icon-sm" : "sm"}
        className={cn("relative shrink-0 gap-1.5 px-2.5", layout.compact && "size-8 p-0", selected && "bg-brand-soft text-foreground ring-1 ring-inset ring-brand/40 hover:bg-brand-soft dark:hover:bg-brand-soft")} onClick={() => onSelect(item)}
        title={`${action}: ${activityNames[activity.read(item).state]}`} aria-label={action} aria-pressed={selected}>
        <AppIcon src={null} name={item.icon} fallback={PanelsTopLeft} className="size-4" /><span className="absolute top-0.5 right-0.5"><ToolActivityMark compact activity={activity.read(item)} /></span>{!layout.compact && <span>{item.label}</span>}
      </Button>; })}
    </div>
  </div>;
}
