"use client";
import { useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { Maximize2, Minus, X } from "lucide-react";
import { clampBounds, displayedBounds, type Bounds, type DesktopWindow as WindowState, type Viewport, type WindowMode } from "@/lib/model";

export function DesktopWindow({ window: state, viewport, title, active, index, children, toolbar,
  onFocus, onChange, onClose, onSnapPreview }: {
  window: WindowState; viewport: Viewport; title: string; active: boolean; index: number;
  children: ReactNode; toolbar?: ReactNode; onFocus: () => void; onChange: (patch: Partial<WindowState>) => void;
  onClose: () => void; onSnapPreview: (mode: WindowMode | null) => void;
}) {
  const gesture = useRef<{ kind: string; x: number; y: number; bounds: Bounds } | null>(null);
  const [dragging, setDragging] = useState(false);
  const box = displayedBounds(state, viewport);
  function begin(event: PointerEvent<HTMLElement>, kind: string) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, a, input")) return;
    event.preventDefault();
    onFocus();
    const bounds = kind === "move" && state.mode !== "normal"
      ? clampBounds({ ...state.bounds, x: event.clientX - state.bounds.width / 2, y: event.clientY - 22 }, viewport) : box;
    gesture.current = { kind, x: event.clientX, y: event.clientY, bounds };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true); onChange({ mode: "normal", bounds });
  }
  function move(event: PointerEvent<HTMLElement>) {
    const start = gesture.current; if (!start) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    let next = { ...start.bounds };
    if (start.kind === "move") {
      next = { ...next, x: next.x + dx, y: next.y + dy };
      onSnapPreview(event.clientY < 46 ? "maximized" : event.clientX < 24 ? "left" : event.clientX > viewport.width - 24 ? "right" : null);
    } else {
      if (start.kind.includes("e")) next.width += dx;
      if (start.kind.includes("s")) next.height += dy;
      if (start.kind.includes("w")) { const width = Math.max(360, next.width - dx); next.x += next.width - width; next.width = width; }
      if (start.kind.includes("n")) { const height = Math.max(260, next.height - dy); next.y += next.height - height; next.height = height; }
    }
    onChange({ bounds: clampBounds(next, viewport) });
  }
  function end(event: PointerEvent<HTMLElement>) {
    if (!gesture.current) return;
    if (gesture.current.kind === "move" && event.type !== "pointercancel") {
      const mode = event.clientY < 46 ? "maximized" : event.clientX < 24 ? "left" : event.clientX > viewport.width - 24 ? "right" : "normal";
      onChange({ mode });
    }
    gesture.current = null; setDragging(false); onSnapPreview(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  const handlers = { onPointerMove: move, onPointerUp: end, onPointerCancel: end };
  const style = { left: box.x, top: box.y, width: box.width, height: box.height, zIndex: 10 + index,
    display: state.minimized ? "none" : undefined } as CSSProperties;
  return <section role="dialog" aria-modal="false" aria-label={title} data-window-id={state.id}
    className={`desktop-window ${active ? "active" : "inactive"} ${dragging ? "is-dragging" : ""}`} style={style}
    onPointerDownCapture={onFocus} onFocusCapture={onFocus}>
    <header className="window-titlebar" onPointerDown={event => begin(event, "move")} {...handlers}
      onDoubleClick={event => { if (!(event.target as HTMLElement).closest("button")) onChange({ mode: state.mode === "maximized" ? "normal" : "maximized" }); }}>
      <div className="traffic-lights">
        <button className="traffic close" aria-label={`Close ${title}`} title="Close window" onClick={onClose}><X size={9} strokeWidth={3} /></button>
        <button className="traffic minimize" aria-label={`Minimize ${title}`} title="Minimize" onClick={() => onChange({ minimized: true })}><Minus size={9} strokeWidth={3} /></button>
        <button className="traffic maximize" aria-label={`Maximize ${title}`} title={state.mode === "maximized" ? "Restore size" : "Maximize"}
          onClick={() => onChange({ mode: state.mode === "maximized" ? "normal" : "maximized" })}><Maximize2 size={8} strokeWidth={3} /></button>
      </div>
      <span className="window-title">{title}</span>
      <div className="window-toolbar">{toolbar}</div>
    </header>
    <div className="window-content">{children}</div>
    {state.mode === "normal" && ["n", "s", "e", "w", "ne", "nw", "se", "sw"].map(edge => <div key={edge} aria-hidden="true"
      // Gesture refs are read only when the pointer event fires, never during render.
      // eslint-disable-next-line react-hooks/refs
      className={`resize-handle resize-${edge}`} onPointerDown={event => begin(event, edge)} {...handlers} />)}
  </section>;
}
