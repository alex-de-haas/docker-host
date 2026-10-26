import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Dock, DockButton } from "../src/components/dock";

let root: Root, desktop: HTMLDivElement;
let firstLeft = 4;
const longName = "A long application name that must remain readable above the dock";
const resized = { observe: vi.fn(), disconnect: vi.fn() };
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("innerWidth", 800); vi.stubGlobal("innerHeight", 600);
  vi.stubGlobal("ResizeObserver", class { observe = resized.observe; disconnect = resized.disconnect; });
  firstLeft = 4; resized.observe.mockClear(); resized.disconnect.mockClear();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("dock-tooltip")) return new DOMRect(0, 0, 240, 64);
    if (this.classList.contains("dock-apps")) return new DOMRect(0, 480, 800, 100);
    return new DOMRect(this.dataset.edge === "right" ? 744 : firstLeft, 500, 52, 62);
  });
  desktop = document.createElement("div"); desktop.className = "desktop"; document.body.append(desktop); root = createRoot(desktop);
  await act(async () => root.render(<Dock><div className="dock-apps">
    <DockButton label={longName} hint="Click to start" className="dock-item" aria-label="First"><span>First</span></DockButton>
    <DockButton label="Last application" className="dock-item" aria-label="Last" data-edge="right"><span>Last</span></DockButton>
  </div></Dock>));
});
afterEach(async () => { await act(async () => root.unmount()); desktop.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const button = (label: string) => desktop.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const tooltip = () => desktop.querySelector<HTMLElement>('[role="tooltip"]');
async function hover(label: string, pointerType = "mouse") {
  const event = new MouseEvent("pointerover", { bubbles: true }); Object.defineProperty(event, "pointerType", { value: pointerType });
  await act(async () => button(label).dispatchEvent(event));
}

it("renders one named tooltip outside the scroller and keeps both edge labels in the viewport", async () => {
  await hover("First");
  expect(tooltip()?.parentElement).toBe(desktop);
  expect(desktop.querySelector(".dock-apps")?.contains(tooltip())).toBe(false);
  expect(tooltip()?.textContent).toBe(longName + "Click to start");
  expect(button("First").getAttribute("aria-describedby")).toBe(tooltip()?.id);
  expect(tooltip()?.style.left).toBe("8px"); expect(tooltip()?.style.top).toBe("420px");
  await hover("Last");
  expect(desktop.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
  expect(tooltip()?.textContent).toBe("Last application"); expect(tooltip()?.style.left).toBe("552px");
  expect(button("First").hasAttribute("aria-describedby")).toBe(false);
});

it("tracks scrolling, hides an offscreen anchor and dismisses on Escape or pointer interaction", async () => {
  await hover("First"); firstLeft = 300;
  await act(async () => desktop.querySelector(".dock-apps")!.dispatchEvent(new Event("scroll")));
  expect(tooltip()?.style.left).toBe("206px");
  firstLeft = -80;
  await act(async () => window.dispatchEvent(new Event("resize")));
  expect(tooltip()?.style.visibility).toBe("hidden");
  firstLeft = 4;
  await act(async () => window.dispatchEvent(new Event("resize")));
  expect(tooltip()?.style.visibility).toBe("visible");
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(tooltip()).toBeNull(); expect(button("First").hasAttribute("aria-describedby")).toBe(false);
  expect(resized.disconnect).toHaveBeenCalled();
  await hover("Last");
  await act(async () => window.dispatchEvent(new Event("pointerdown")));
  expect(tooltip()).toBeNull();
});

it("supports keyboard focus without a native title tooltip and ignores touch hover", async () => {
  await hover("First", "touch"); expect(tooltip()).toBeNull();
  // jsdom has no keyboard/pointer modality; browser QA verifies the real pseudo-class.
  for (const label of ["First", "Last"]) {
    const element = button(label);
    vi.spyOn(element, "matches").mockImplementation(selector => selector === ":focus-visible" && document.activeElement === element);
  }
  await act(async () => button("First").focus());
  expect(tooltip()?.textContent).toContain(longName); expect(button("First").hasAttribute("title")).toBe(false);
  await act(async () => button("Last").focus());
  expect(tooltip()?.textContent).toBe("Last application");
  await act(async () => button("Last").blur()); expect(tooltip()).toBeNull();
});

it("removes the tooltip when its application leaves the dock", async () => {
  await hover("First");
  await act(async () => root.render(<Dock><div className="dock-apps" /></Dock>));
  expect(tooltip()).toBeNull();
});
