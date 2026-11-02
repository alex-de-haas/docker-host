"use client";

import { Fragment, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ShellPanelColumn = { id: string; label: string; open: boolean; width: number; content: ReactNode };
const MIN_PANEL = 280, GAP = 12;
export function panelArrangement(width: number, pageMinimum: number, widths: number[]) {
  const count = widths.length;
  const stacked = width < pageMinimum + MIN_PANEL + GAP;
  const tabs = count > 1 && width < pageMinimum + count * (MIN_PANEL + GAP);
  const available = Math.max(MIN_PANEL, width - pageMinimum - (tabs ? GAP : count * GAP));
  const desired = widths.map(value => Math.max(MIN_PANEL, Math.min(800, value)));
  const excess = desired.reduce((sum, value) => sum + value - MIN_PANEL, 0);
  const ratio = excess ? Math.min(1, Math.max(0, available - count * MIN_PANEL) / excess) : 1;
  return { stacked, tabs, widths: desired.map(value => tabs ? Math.min(value, available) : MIN_PANEL + (value - MIN_PANEL) * ratio) };
}

/** Every presentation has a stable parent, including across compact/wide layout changes. */
export function ShellConcurrentPanels({ children, panels, focusedId, onFocus, onResize, pageMinimum, captureActive = false }: {
  children: ReactNode; panels: ShellPanelColumn[]; focusedId: string | null;
  onFocus: (id: string) => void; onResize: (id: string, width: number) => void; pageMinimum: number; captureActive?: boolean;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0), [dragging, setDragging] = useState(false);
  useLayoutEffect(() => {
    const node = root.current; if (!node) return;
    const read = () => { const style = getComputedStyle(node); setWidth((node.getBoundingClientRect().width || window.innerWidth) - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)); };
    read(); const observer = new ResizeObserver(read); observer.observe(node);
    window.addEventListener("resize", read);
    return () => { observer.disconnect(); window.removeEventListener("resize", read); };
  }, []);
  const open = panels.filter(panel => panel.open);
  const arrangement = panelArrangement(width, pageMinimum, open.map(panel => panel.width));
  const selected = open.some(panel => panel.id === focusedId) ? focusedId : open.at(-1)?.id;
  const tabs = arrangement.tabs || arrangement.stacked;
  return <div ref={root} className="flex h-full min-h-0 min-w-0 flex-col pr-3 pb-3 max-[599px]:p-0" data-shell-panel-layout={tabs ? "tabs" : "columns"}>
    {tabs && open.length > 0 && <div role="tablist" data-hosty-feedback-control={captureActive ? "" : undefined} aria-label="Open tools" className="flex shrink-0 gap-1 overflow-x-auto pb-2" onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const index = open.findIndex(panel => panel.id === selected);
      const next = event.key === "Home" ? 0 : event.key === "End" ? open.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + open.length) % open.length;
      onFocus(open[next].id); event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
    }}>
      {open.map(panel => <Button key={panel.id} id={`${id}-tab-${panel.id}`} aria-controls={`${id}-panel-${panel.id}`} role="tab" aria-selected={selected === panel.id} tabIndex={selected === panel.id ? 0 : -1}
        variant="ghost" size="sm" className={cn("shrink-0", selected === panel.id && "bg-brand-soft")} onClick={() => onFocus(panel.id)}>{panel.label}</Button>)}
    </div>}
    <div className={cn("relative flex min-h-0 min-w-0 flex-1", arrangement.stacked && open.length > 0 && "flex-col gap-3")}>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl border bg-background shadow-xs" data-shell-document
        style={arrangement.stacked && open.length > 0 ? { flexBasis: "45%" } : undefined}>{children}</div>
      {panels.map(panel => {
        const visible = panel.open && (!tabs || panel.id === selected);
        const size = arrangement.widths[open.indexOf(panel)] ?? panel.width;
        return <Fragment key={panel.id}>
          <div role="separator" aria-label={`Resize ${panel.label} panel`} aria-orientation="vertical" aria-valuemin={MIN_PANEL} aria-valuemax={800} aria-valuenow={Math.round(size)}
            style={{display: visible && !arrangement.stacked ? undefined : "none"}} tabIndex={visible && !arrangement.stacked ? 0 : -1} hidden={!visible || arrangement.stacked} data-hosty-feedback
            className="group flex w-3 shrink-0 cursor-col-resize touch-none items-center justify-center outline-none"
            onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") {event.preventDefault(); onResize(panel.id, Math.max(MIN_PANEL, Math.min(800, size + (event.key === "ArrowLeft" ? 20 : -20))));} }}
            onDoubleClick={() => onResize(panel.id, 360)} onPointerDown={event => {
              event.preventDefault(); const node = event.currentTarget, start = event.clientX; node.setPointerCapture(event.pointerId); setDragging(true);
              const move = (e: PointerEvent) => onResize(panel.id, Math.max(MIN_PANEL, Math.min(800, size + start - e.clientX)));
              const end = () => {setDragging(false); node.removeEventListener("pointermove", move); node.removeEventListener("pointerup", end); node.removeEventListener("pointercancel", end);};
              node.addEventListener("pointermove", move); node.addEventListener("pointerup", end); node.addEventListener("pointercancel", end);
            }}><span className="h-8 w-1 rounded-full group-hover:bg-border group-focus-visible:bg-ring" /></div>
          <div id={`${id}-panel-${panel.id}`} role={tabs ? "tabpanel" : undefined} aria-labelledby={tabs && panel.open ? `${id}-tab-${panel.id}` : undefined} hidden={!visible} inert={!visible} data-shell-tool-column={panel.id}
            className={cn("min-h-0 min-w-0 overflow-hidden rounded-xl border bg-background shadow-xs", !visible && "hidden")}
            style={visible ? arrangement.stacked ? { flex: "1 1 55%", width: "100%" } : { flex: `0 0 ${size}px`, width: size } : undefined}>
            {panel.content}
          </div>
        </Fragment>;
      })}
      {dragging && <div data-hosty-feedback className="absolute inset-0 z-50 cursor-col-resize" />}
    </div>
  </div>;
}
