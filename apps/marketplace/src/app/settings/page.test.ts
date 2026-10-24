// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsForm } from "./page";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch: request }));
let root: Root;
let container: HTMLDivElement;
const initial = "https://catalog.example/index.json";
function response(value: unknown, ok = true, status = ok ? 200 : 400) { return { ok, status, json: async () => value }; }
function button(label: string) { return [...container.querySelectorAll("button")].find(item => item.textContent === label)!; }
async function enterSource(value: string) {
  const input = container.querySelector<HTMLInputElement>("#catalog-source")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  request.mockReset(); request.mockResolvedValue(response({ sourceUrl: initial }));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it("labels loading and allows recovery from an initial settings read failure", async () => {
  let reject!: (reason: Error) => void;
  request.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  await act(async () => root.render(createElement(SettingsForm)));
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading catalog settings");
  expect(container.querySelector<HTMLInputElement>("#catalog-source")?.disabled).toBe(true);
  await act(async () => reject(new Error("Settings unavailable")));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Settings unavailable");
  await act(async () => button("Retry settings").click());
  expect(container.querySelector<HTMLInputElement>("#catalog-source")?.value).toBe(initial);
  expect(container.querySelector<HTMLInputElement>("#catalog-source")?.disabled).toBe(false);
  expect(button("Save settings").disabled).toBe(true);
});

it("preserves the unsaved source after a rejected save and retries with the original concurrency value", async () => {
  await act(async () => root.render(createElement(SettingsForm)));
  const edited = "https://new-catalog.example/index.json";
  await enterSource(edited);
  request.mockResolvedValueOnce(response({ message: "The catalog source changed. Reload before saving." }, false));
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(container.querySelector<HTMLInputElement>("#catalog-source")?.value).toBe(edited);
  expect(container.textContent).toContain("You have unsaved changes.");
  expect(button("Save settings").disabled).toBe(false);
  expect(JSON.parse(request.mock.lastCall?.[1].body)).toEqual({ sourceUrl: edited, expectedSourceUrl: initial });
  request.mockResolvedValueOnce(response({ sourceUrl: edited }));
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(JSON.parse(request.mock.lastCall?.[1].body)).toEqual({ sourceUrl: edited, expectedSourceUrl: initial });
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("Catalog settings are saved.");
  expect(button("Save settings").disabled).toBe(true);
});

it("aborts an unfinished settings read on unmount", async () => {
  let resolve!: (value: unknown) => void;
  request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await act(async () => root.render(createElement(SettingsForm)));
  const signal = request.mock.calls[0][1].signal as AbortSignal;
  await act(async () => root.render(null));
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(response({ sourceUrl: initial })));
  expect(container.textContent).toBe("");
});


it("explicitly reads a changed source while retaining the attempted draft before a new Save", async () => {
  await act(async () => root.render(createElement(SettingsForm)));
  const edited = "https://my-draft.example/catalog.json", current = "https://other-view.example/catalog.json", laterEdit = "https://later-draft.example/catalog.json";
  await enterSource(edited);
  request.mockResolvedValueOnce(response({ code: "settings_conflict", message: "Settings changed. Reload before saving again." }, false, 409));
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(container.querySelector<HTMLInputElement>("#catalog-source")?.value).toBe(edited);
  expect(button("Save settings").disabled).toBe(true);
  expect(button("Reload current settings")).toBeDefined();
  let resolveRead!: (value: unknown) => void;
  request.mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
  await act(async () => button("Reload current settings").click());
  expect(button("Save settings").disabled).toBe(true);
  await enterSource(laterEdit);
  await act(async () => resolveRead(response({ sourceUrl: current })));
  expect(container.querySelector<HTMLInputElement>("#catalog-source")?.value).toBe(laterEdit);
  expect(container.textContent).toContain(current);
  expect(button("Save settings").disabled).toBe(false);
  expect(request.mock.calls.filter(call => call[1]?.method === "PUT")).toHaveLength(1);
  request.mockResolvedValueOnce(response({ sourceUrl: laterEdit }));
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(JSON.parse(request.mock.lastCall?.[1].body)).toEqual({ sourceUrl: laterEdit, expectedSourceUrl: current });
  expect(container.textContent).toContain("Catalog settings are saved.");
});

it("keeps the conflicting draft locked against writes until an explicit reread succeeds", async () => {
  await act(async () => root.render(createElement(SettingsForm)));
  const edited = "https://my-draft.example/catalog.json"; await enterSource(edited);
  request.mockResolvedValueOnce(response({ code: "settings_conflict", message: "Settings changed." }, false, 409));
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  request.mockRejectedValueOnce(new Error("Current source is unavailable"));
  await act(async () => button("Reload current settings").click());
  expect(container.querySelector<HTMLInputElement>("#catalog-source")?.value).toBe(edited);
  expect(container.textContent).toContain("Current source is unavailable");
  expect(button("Save settings").disabled).toBe(true);
  expect(button("Reload current settings").disabled).toBe(false);
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(request.mock.calls.filter(call => call[1]?.method === "PUT")).toHaveLength(1);
});
