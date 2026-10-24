import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SharedMountAppsDialog } from "../src/app/shell/pages/shared-mount-apps-dialog";
import type { CoreApp } from "../src/app/shell/types";

let root: Root, container: HTMLDivElement;
const save = vi.fn(), close = vi.fn();
const app = { id: "test.files", displayName: "Files", mounts: [{ key: "data", required: false, bindings: [] }] } as unknown as CoreApp;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  save.mockReset(); close.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = (apps: CoreApp[]) => act(async () => root.render(<SharedMountAppsDialog mount={{ name: "library", hostPath: "/srv/library", mode: "rw", usedBy: 0 }} apps={apps} onSave={save} onRefresh={async () => {}} onReload={async () => {}} onClose={close} onSaved={() => {}} />));
const button = (text: string) => [...document.querySelectorAll('button')].find(node => node.textContent === text)!;
it("distinguishes absent slots from a search miss without offering an irrelevant clear action", async () => {
  await render([]);
  expect(document.body.textContent).toContain("No apps with shared folder slots");
  expect(document.querySelector('.hosty-empty-slots')).not.toBeNull();
  expect(button("Clear search")).toBeUndefined();
  expect(button("Save changes").disabled).toBe(true);
});
it("clears an empty search result without clearing the pending assignment", async () => {
  await render([app]);
  await act(async () => document.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
  const input = document.querySelector<HTMLInputElement>('[aria-label="Search apps"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "missing");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(document.body.textContent).toContain("No matching apps");
  expect(document.body.textContent).toContain("1 app to change");
  await act(async () => button("Clear search").click());
  expect(document.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe("true");
  expect(button("Save changes").disabled).toBe(false);
  expect(document.activeElement).toBe(input);
  expect(save).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
});
