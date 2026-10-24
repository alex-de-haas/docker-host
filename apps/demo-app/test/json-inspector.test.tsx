import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { JsonButton } from "../src/components/JsonInspector";

const request = vi.hoisted(() => vi.fn());
vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch: request }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
it("shows loading and permits an in-place retry without losing the protected response", async () => {
  let reject!: (error: Error) => void;
  request.mockReturnValueOnce(new Promise<Response>((_, fail) => { reject = fail; }));
  await act(async () => root.render(<JsonButton href="/api/config" />));
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(container.querySelector("dialog")?.open).toBe(true);
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading JSON…");
  await act(async () => reject(new Error("Disconnected")));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not load JSON");
  request.mockResolvedValueOnce(Response.json({ error: { code: "forbidden" } }, { status: 403 }));
  const retry = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Retry")!;
  await act(async () => retry.click());
  expect(container.querySelector("pre")?.textContent).toContain('"forbidden"');
  expect(request).toHaveBeenLastCalledWith("/api/config", { cache: "no-store" });
});
