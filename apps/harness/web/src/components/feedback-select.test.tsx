// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FeedbackSelect } from "./feedback-select";

let root: Root, container: HTMLDivElement;
const options = [
  { value: "", label: "Default" },
  { value: "value:", label: "Prefix alone" },
  { value: "value:opaque:id", label: "Opaque identifier" },
  { value: "東京 /#😀", label: "Unicode identifier" },
  { value: "blocked", label: "Unavailable option", disabled: true },
];
function Choice({ disabled = false, initialValue = "", onChange }: { disabled?: boolean; initialValue?: string; onChange(value: string): void }) {
  const [value, setValue] = useState(initialValue);
  return <FeedbackSelect label="Destination" value={value} options={options} disabled={disabled} onValueChange={next => { setValue(next); onChange(next); }} />;
}
const combobox = () => container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Destination"]')!;
const open = () => act(async () => combobox().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
const option = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent === label)!;
const choose = async (label: string) => { await open(); await act(async () => option(label).click()); };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.hasPointerCapture = vi.fn(() => false); Element.prototype.scrollIntoView = vi.fn();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it("round-trips empty, prefixed and Unicode opaque values through the actual menu", async () => {
  const change = vi.fn(); await act(async () => root.render(<Choice onChange={change} />));
  expect(combobox().textContent).toBe("Default"); expect(change).not.toHaveBeenCalled();
  for (const choice of [options[2], options[1], options[3], options[0]]) {
    await choose(choice.label);
    expect(change).toHaveBeenLastCalledWith(choice.value);
    expect(combobox().textContent).toBe(choice.label);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  }
  expect(change.mock.calls.map(([value]) => value)).toEqual(["value:opaque:id", "value:", "東京 /#😀", ""]);
});

it("keeps unavailable options visible but prevents selecting them", async () => {
  const change = vi.fn(); await act(async () => root.render(<Choice onChange={change} />));
  await open(); expect(option("Unavailable option").getAttribute("aria-disabled")).toBe("true");
  await act(async () => option("Unavailable option").click());
  expect(change).not.toHaveBeenCalled(); expect(combobox().textContent).toBe("Default");
  await act(async () => option("Opaque identifier").click());
  expect(change).toHaveBeenCalledExactlyOnceWith("value:opaque:id");
});

it("closes an open menu when disabled and leaves it closed after the control becomes available", async () => {
  const change = vi.fn(); await act(async () => root.render(<Choice onChange={change} />));
  await open(); expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  await act(async () => root.render(<Choice disabled onChange={change} />));
  expect(combobox().disabled).toBe(true); expect(document.querySelector('[role="listbox"]')).toBeNull();
  await open(); expect(document.querySelector('[role="listbox"]')).toBeNull(); expect(change).not.toHaveBeenCalled();
  await act(async () => root.render(<Choice onChange={change} />));
  expect(combobox().disabled).toBe(false); expect(document.querySelector('[role="listbox"]')).toBeNull();
  await choose("Prefix alone"); expect(change).toHaveBeenCalledExactlyOnceWith("value:");
});

it("retains a missing selected identity as unavailable until an explicit replacement is chosen", async () => {
  const change = vi.fn(); await act(async () => root.render(<Choice initialValue="missing-session" onChange={change} />));
  expect(combobox().textContent).toBe("Unavailable selection");
  await open(); expect(option("Unavailable selection").getAttribute("aria-disabled")).toBe("true");
  expect(change).not.toHaveBeenCalled(); await act(async () => option("Default").click());
  expect(change).toHaveBeenCalledExactlyOnceWith(""); expect(combobox().textContent).toBe("Default");
});
