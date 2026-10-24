import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingInput } from "../src/app/shell/settings";
import type { CoreSetting } from "../src/app/shell/types";

const setting: CoreSetting = {
  key: "RUNTIME", label: "Runtime profile", type: "select", secret: false,
  options: [{ value: "docker", label: "Docker" }, { value: "local", label: "Local process" }],
};
let root: Root;
let container: HTMLDivElement;
const scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
  if (scrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});
const render = (value: string | null, onChange: (value: string) => void, current = setting, disabled = false) =>
  act(async () => root.render(<form><SettingInput setting={current} value={value} disabled={disabled} onChange={onChange} /></form>));
const trigger = () => container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const open = () => act(async () => { trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
async function choose(label: string) {
  await open();
  const option = options().find(node => node.textContent === label);
  expect(option).toBeDefined();
  await act(async () => { option!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
}
async function edit(value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("associates the setting label with its select and never writes on mount or refreshed props", async () => {
  const change = vi.fn();
  await render("docker", change);
  expect(trigger().id).toBe("setting-RUNTIME");
  expect(container.querySelector<HTMLLabelElement>("label")!.control).toBe(trigger());
  expect(trigger().textContent).toBe("Docker");
  await render("local", change);
  expect(trigger().textContent).toBe("Local process");
  await render("local", change, { ...setting, options: [{ value: "docker", label: "Docker" }] });
  expect(trigger().textContent).toBe("local (unavailable)");
  expect(change).not.toHaveBeenCalled();
});

it("round-trips empty and prefix-like setting values without a sentinel collision", async () => {
  const change = vi.fn();
  const current = { ...setting, options: [...setting.options!, { value: "", label: "Automatic" }, { value: "setting:", label: "Literal value" }] };
  await render("docker", change, current);
  await choose("Automatic");
  expect(change).toHaveBeenCalledExactlyOnceWith("");
  await render("", change, current);
  expect(trigger().textContent).toBe("Automatic");
  await choose("Literal value");
  expect(change.mock.calls).toEqual([[""], ["setting:"]]);
  await render("setting:", change, current);
  expect(trigger().textContent).toBe("Literal value");
  expect(change).toHaveBeenCalledTimes(2);
});

it("keeps an unknown saved value explicit and unavailable until the user chooses a declared option", async () => {
  const change = vi.fn();
  const current = { ...setting, options: [...setting.options!, { value: "  custom profile  ", label: "Custom profile" }] };
  await render("removed-profile", change, current);
  expect(trigger().textContent).toBe("removed-profile (unavailable)");
  await open();
  const unavailable = options().find(node => node.textContent === "removed-profile (unavailable)")!;
  expect(unavailable.getAttribute("aria-disabled")).toBe("true");
  expect(change).not.toHaveBeenCalled();
  const custom = options().find(node => node.textContent === "Custom profile")!;
  await act(async () => { custom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(change).toHaveBeenCalledExactlyOnceWith("  custom profile  ");
});

it.each([null, ""])("leaves an unset value %s untouched when no empty option is declared", async value => {
  const change = vi.fn();
  await render(value, change);
  expect(trigger().textContent).toBe("Select an option");
  expect(change).not.toHaveBeenCalled();
  await choose("Local process");
  expect(change).toHaveBeenCalledExactlyOnceWith("local");
});

it("preserves disabled select behavior", async () => {
  const change = vi.fn();
  await render("docker", change, setting, true);
  expect(trigger().disabled).toBe(true);
  await open();
  expect(options()).toEqual([]);
  expect(change).not.toHaveBeenCalled();
});

it.each([
  ["number", "1.25", "number"],
  ["string", "  unchanged spacing  ", "text"],
  ["url", "https://example.test/a?b=1", "url"],
])("keeps %s inputs and their raw string caller payloads", async (type, value, inputType) => {
  const change = vi.fn();
  await render("", change, { ...setting, type });
  expect(container.querySelector<HTMLInputElement>("input")!.type).toBe(inputType);
  await edit(value);
  expect(change).toHaveBeenCalledExactlyOnceWith(value);
});

it("retains the free-form fallback for select settings without declared options", async () => {
  const change = vi.fn();
  await render("legacy", change, { ...setting, options: [] });
  expect(container.querySelector('[role="combobox"]')).toBeNull();
  expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("legacy");
  await edit("replacement");
  expect(change).toHaveBeenCalledExactlyOnceWith("replacement");
});
