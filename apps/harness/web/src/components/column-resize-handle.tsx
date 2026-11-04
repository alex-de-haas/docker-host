"use client";
import { useRef } from "react";
import { cn } from "@/lib/utils";

export function ColumnResizeHandle({ label, side, width, min, max, defaultWidth, onResize, className }: {
  label: string; side: "left" | "right"; width: number; min: number; max: number;
  defaultWidth: number; onResize: (width: number) => void; className?: string;
}) {
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const direction = side === "right" ? 1 : -1;
  return <div role="separator" aria-label={label} aria-orientation="vertical" tabIndex={0}
    aria-valuemin={min} aria-valuemax={Math.floor(max)} aria-valuenow={width} aria-valuetext={`${width} pixels`}
    title="Drag to resize. Use arrow keys, or double-click to reset."
    className={cn("absolute inset-y-0 z-20 w-2 cursor-col-resize touch-none select-none outline-none hover:bg-ring/25 focus-visible:bg-ring/40", side === "right" ? "-right-1" : "-left-1", className)}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, x: event.clientX, width };
    }}
    onPointerMove={event => {
      if (drag.current?.id === event.pointerId) onResize(drag.current.width + direction * (event.clientX - drag.current.x));
    }}
    onPointerUp={event => {
      if (drag.current?.id !== event.pointerId) return;
      drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
    onDoubleClick={() => onResize(defaultWidth)}
    onKeyDown={event => {
      const next = event.key === "Home" ? min : event.key === "End" ? max
        : event.key === "ArrowLeft" ? width - direction * 16 : event.key === "ArrowRight" ? width + direction * 16 : null;
      if (next !== null) { event.preventDefault(); onResize(next); }
    }} />;
}
