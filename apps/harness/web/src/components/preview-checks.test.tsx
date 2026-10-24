// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PreviewChecks } from "./preview-checks";
import { developmentRequest } from "@/lib/development-api";
vi.mock("@/lib/development-api", () => ({ developmentRequest: vi.fn() }));
let root: Root, container: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });
const recipe = { id: "web/unit", service: "web", digest: "revision1", state: "not_checked", recipe: { command: ["npm", "test"], cwd: ".", timeoutSeconds: 60 } };
const reply = (check = recipe) => ({ status: 200, body: { state: "observed", checks: [check] } });
async function show() { await act(async () => root.render(<PreviewChecks workspaceId="work" environmentId="child" appId="demo" refresh={() => {}} />)); }
async function click(label: string) { await act(async () => (Array.from(container.querySelectorAll("button")).find(b => b.textContent === label) as HTMLButtonElement).click()); }
it("does not run checks automatically and leaves restart available without a recipe", async () => {
  vi.mocked(developmentRequest).mockResolvedValue({ status: 200, body: { state: "not_checked", checks: [], message: "No check recipe. Build and tests not checked." } });
  await show(); expect(developmentRequest).not.toHaveBeenCalled();
  await click("Check preview"); expect(container.textContent).toContain("Build and tests not checked");
  expect(container.textContent).not.toContain("Run reviewed check");
  const calls = vi.mocked(developmentRequest).mock.calls.length;
  await click("Check preview"); expect(vi.mocked(developmentRequest).mock.calls.length).toBe(calls + 1);
  await click("Restart app"); expect(developmentRequest).toHaveBeenCalledWith("/work/previews/child/demo/restart", {}, undefined);
});
it("reviews actual argv and interruption, submits only the recipe digest and displays its real result", async () => {
  vi.mocked(developmentRequest).mockResolvedValue(reply()); await show(); await click("Check preview");
  expect(container.textContent).toContain('"npm" "test"'); expect(container.textContent).toContain("stops the service");
  vi.mocked(developmentRequest).mockResolvedValue({ status: 200, body: { state: "observed", checks: [{ ...recipe, state: "failed", result: { state: "failed", at: "2026-10-17T10:00:00Z", exitCode: 2, output: "Expected 2, received 1" } }] } });
  await click("Run reviewed check");
  expect(developmentRequest).toHaveBeenCalledWith("/work/previews/child/demo/run", { id: "web/unit", digest: "revision1", requestId: expect.any(String) }, undefined);
  expect(container.textContent).toContain("exit 2"); expect(container.textContent).toContain("Expected 2, received 1");
});
it("refreshes stale observations and clears success on unavailable status", async () => {
  vi.useFakeTimers(); vi.mocked(developmentRequest).mockResolvedValue(reply({ ...recipe, state: "passed" }));
  await show(); await click("Check preview"); expect(container.textContent).toContain("web/unit · passed");
  vi.mocked(developmentRequest).mockResolvedValue(reply({ ...recipe, state: "stale", digest: "revision2" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); }); expect(container.textContent).toContain("web/unit · stale");
  vi.mocked(developmentRequest).mockRejectedValue(new Error("Docker unavailable"));
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); }); expect(container.textContent).toContain("Docker unavailable"); expect(container.textContent).not.toContain("web/unit ·");
});
it("shows bounded service error logs and clears the old snapshot when a fresh read fails", async () => {
  vi.mocked(developmentRequest).mockResolvedValue({ status: 200, body: { text: "Cannot find module missing-entry.mjs" } });
  await show(); await click("Show service logs"); expect(container.textContent).toContain("Cannot find module missing-entry.mjs");
  vi.mocked(developmentRequest).mockResolvedValue({ status: 403, body: { message: "Sandbox access revoked" } });
  await click("Show service logs"); expect(container.textContent).toContain("Sandbox access revoked"); expect(container.textContent).not.toContain("Cannot find module");
});


it("opens compact preview controls without running a command and keeps recipe review, logs and restart accessible", async () => {
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(developmentRequest).mockResolvedValue(reply());
  await act(async () => root.render(<PreviewChecks compact workspaceId="work" environmentId="child" appId="demo" refresh={() => {}} />));
  const openMenu = () => act(async () => container.querySelector('[aria-label="demo preview actions"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  const choose = (label: string) => act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === label)!.click());
  await openMenu(); expect(developmentRequest).not.toHaveBeenCalled();
  expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(["Check preview", "Restart app", "Show service logs"]);
  await choose("Check preview");
  expect(container.textContent).toContain('"npm" "test"');
  expect(vi.mocked(developmentRequest).mock.calls.every(([path]) => path?.endsWith("/checks"))).toBe(true);
  await click("Run reviewed check");
  expect(developmentRequest).toHaveBeenCalledWith("/work/previews/child/demo/run", { id: "web/unit", digest: "revision1", requestId: expect.any(String) }, undefined);
  vi.mocked(developmentRequest).mockImplementation(async (path = "") => path.endsWith("/logs") ? { status: 200, body: { text: "Observed service log" } } as never : reply() as never);
  await openMenu(); await choose("Show service logs");
  expect(container.textContent).toContain("Observed service log");
  await openMenu(); await choose("Restart app");
  expect(developmentRequest).toHaveBeenCalledWith("/work/previews/child/demo/restart", {}, undefined);
});

it("shows pending recipe reads without running them and distinguishes restart progress from recipe loading", async () => {
  const reads: { resolve: (value: unknown) => void; signal?: AbortSignal }[] = [];
  let completeRestart!: (value: unknown) => void;
  vi.mocked(developmentRequest).mockImplementation(async (path = "", _input, signal) => {
    if (path.endsWith("/checks")) return new Promise(resolve => { reads.push({ resolve, signal }); });
    return new Promise(resolve => { completeRestart = resolve; });
  });
  await show(); await click("Check preview");
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Reading check recipes…");
  expect(vi.mocked(developmentRequest).mock.calls.every(([path]) => path?.endsWith("/checks"))).toBe(true);
  await click("Restart app");
  expect(reads[0].signal?.aborted).toBe(true);
  expect(container.textContent).not.toContain("Reading check recipes…");
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Working… Source and sandbox data are retained.");
  await act(async () => reads[0].resolve(reply({ ...recipe, state: "passed" })));
  expect(container.textContent).not.toContain("web/unit · passed");
  await act(async () => completeRestart({ status: 200, body: {} }));
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Reading check recipes…");
  await act(async () => reads[1].resolve(reply()));
  expect(container.textContent).toContain("web/unit · not checked");
  expect(container.textContent).not.toContain("Reading check recipes…");
  expect(vi.mocked(developmentRequest).mock.calls.some(([path]) => path?.endsWith("/run"))).toBe(false);
});
