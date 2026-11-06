// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ColumnResizeHandle } from "./column-resize-handle";
import { COLUMNS_STORAGE_KEY, COLUMN_DEFAULTS, COLUMN_MIN, useConversationColumns } from "@/lib/use-conversation-columns";

it("resizes either boundary, persists widths, clamps the center and stops after pointer cancellation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let available = 1200, observe = () => {};
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { observe = callback; } observe() {} disconnect() {} });
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width: available }) as DOMRect);
  const capture = vi.fn(); HTMLElement.prototype.setPointerCapture = capture; HTMLElement.prototype.releasePointerCapture = vi.fn();
  localStorage.clear();
  const element = document.createElement("div"); document.body.append(element); let root = createRoot(element);
  function Harness() {
    const container = useRef<HTMLDivElement>(null);
    const columns = useConversationColumns(true, container);
    return <div ref={container}>{(["navigation", "details"] as const).map(key => <ColumnResizeHandle key={key}
      label={key} side={key === "navigation" ? "right" : "left"} width={columns.widths[key]} min={COLUMN_MIN[key]}
      max={columns.maximum[key]} defaultWidth={COLUMN_DEFAULTS[key]} onResize={width => columns.resize(key, width)} />)}</div>;
  }
  const handle = (key: string) => element.querySelector<HTMLElement>(`[aria-label="${key}"]`)!;
  const key = async (name: string, key: string) => act(async () => { handle(name).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
  const pointer = async (name: string, type: string, x: number) => act(async () => {
    const event = new MouseEvent(type, { clientX: x, button: 0, bubbles: true }); Object.defineProperty(event, "pointerId", { value: 1 }); handle(name).dispatchEvent(event);
  });
  try {
    await act(async () => root.render(<Harness />));
    await key("navigation", "ArrowRight"); await key("details", "ArrowLeft");
    expect(JSON.parse(localStorage.getItem(COLUMNS_STORAGE_KEY)!)).toEqual({ navigation: 280, details: 360 });
    await pointer("navigation", "pointerdown", 280); await pointer("navigation", "pointermove", 380);
    expect(handle("navigation").getAttribute("aria-valuenow")).toBe("380");
    await pointer("navigation", "pointercancel", 380); await pointer("navigation", "pointermove", 480);
    expect(handle("navigation").getAttribute("aria-valuenow")).toBe("380");
    await pointer("details", "pointerdown", 840); await pointer("details", "pointermove", 800); await pointer("details", "pointerup", 800);
    expect(handle("details").getAttribute("aria-valuenow")).toBe("400");
    const saved = localStorage.getItem(COLUMNS_STORAGE_KEY);
    await act(async () => { available = 838; observe(); });
    expect(Number(handle("navigation").getAttribute("aria-valuenow")) + Number(handle("details").getAttribute("aria-valuenow"))).toBeLessThanOrEqual(518);
    expect(localStorage.getItem(COLUMNS_STORAGE_KEY)).toBe(saved);
    await act(async () => root.unmount()); root = createRoot(element);
    await act(async () => { available = 1200; root.render(<Harness />); });
    expect(handle("navigation").getAttribute("aria-valuenow")).toBe("380"); expect(handle("details").getAttribute("aria-valuenow")).toBe("400");
    await key("details", "End"); expect(handle("details").getAttribute("aria-valuenow")).toBe("500");
    await key("navigation", "Home"); expect(handle("navigation").getAttribute("aria-valuenow")).toBe("220");
    await act(async () => handle("details").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(handle("details").getAttribute("aria-valuenow")).toBe("344");
    expect(capture).toHaveBeenCalledTimes(2);
  } finally { await act(async () => root.unmount()); element.remove(); rect.mockRestore(); localStorage.clear(); vi.unstubAllGlobals(); }
});
