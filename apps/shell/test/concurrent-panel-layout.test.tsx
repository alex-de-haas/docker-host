import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { panelArrangement, ShellConcurrentPanels } from "../src/app/shell/chrome/shell-concurrent-panels";

it("clamps independent panels while reserving document space and restores their preferred widths", () => {
  const constrained = panelArrangement(1500, 560, [400, 400, 340]);
  expect(constrained.tabs).toBe(false);
  expect(constrained.widths.every(width => width >= 280)).toBe(true);
  expect(constrained.widths.reduce((a, b) => a + b, 0) + 560 + 36).toBeLessThanOrEqual(1500);
  expect(panelArrangement(2000, 560, [400, 400, 340]).widths).toEqual([400, 400, 340]);
});
it("switches to retained tabs before panels squeeze the document, then stacks on phones", () => {
  expect(panelArrangement(1200, 560, [360, 360, 340])).toMatchObject({ tabs: true, stacked: false });
  expect(panelArrangement(599, 560, [360, 340])).toMatchObject({ tabs: true, stacked: true });
});

it("keeps the last interacted column selected when compacting, without stealing its control focus", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let measure = () => {}, width = 1800;
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { measure = callback; } observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, width, 800));
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  function Example() {
    const [focused, setFocused] = useState("b");
    return <ShellConcurrentPanels pageMinimum={560} focusedId={focused} onFocus={setFocused} onResize={() => {}}
      panels={[{ id: "a", label: "A", open: true, width: 360, content: <input aria-label="Draft A" /> },
        { id: "b", label: "B", open: true, width: 360, content: <iframe title="B" /> }]}><p>Document</p></ShellConcurrentPanels>;
  }
  try {
    await act(async () => root.render(<Example />));
    const input = element.querySelector("input")!;
    await act(async () => input.focus()); expect(document.activeElement).toBe(input);
    width = 1000; await act(async () => measure());
    expect(element.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("A");
    expect(document.activeElement).toBe(input);
    width = 1800; await act(async () => measure());
    const frame = element.querySelector("iframe")!;
    await act(async () => {
      window.dispatchEvent(new Event("blur")); frame.focus();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    width = 1000; await act(async () => measure());
    expect(element.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("B");
    expect(element.querySelector("iframe")).toBe(frame);
  } finally { await act(async () => root.unmount()); element.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});
