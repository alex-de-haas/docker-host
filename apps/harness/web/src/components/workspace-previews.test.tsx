// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspacePreviews } from "./workspace-previews";
import { developmentRequest } from "@/lib/development-api";
vi.mock("@/lib/development-api", () => ({ developmentRequest: vi.fn() }));
let root: Root, container: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });
function reply(app: object) { return { environments: [{ id: "child", label: "Retained preview", state: "running", previewUrl: "http://core.test" }], applications: { child: { state: "ready", apps: [{ id: "demo", displayName: "Demo App", runtimeState: "running", previewUrl: "http://core.test/open", ...app }] } } }; }
it("replaces old service observations with the reviewed topology and reports degraded siblings", async () => {
  vi.useFakeTimers(); vi.mocked(developmentRequest).mockResolvedValue(reply({ services: [{ service: "placeholder", status: "running", health: "healthy" }] }));
  await act(async () => root.render(<WorkspacePreviews workspaceId="work" />));
  expect(container.textContent).toContain("placeholder · running · healthy");
  vi.mocked(developmentRequest).mockResolvedValue(reply({ services: [{ service: "frontend", status: "running", health: "healthy" }, { service: "backend", status: "exited" }] }));
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(container.textContent).not.toContain("placeholder"); expect(container.textContent).toContain("frontend · running · healthy"); expect(container.textContent).toContain("backend · exited");
  vi.mocked(developmentRequest).mockResolvedValue(reply({}));
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(container.textContent).toContain("Service status unobserved"); expect(container.textContent).not.toContain("frontend · running");
});
it("shows building, failure and restart requirements without claiming hot reload compiled the source", async () => {
  vi.useFakeTimers(); vi.mocked(developmentRequest).mockResolvedValue(reply({ restartRequired: true, development: { reloadMode: "application-managed", manifestState: "changed", restartRequired: true }, launchProgress: { stage: "building", buildState: "building", service: "web", changedAt: "2026-10-16T12:00:00Z" } }));
  await act(async () => root.render(<WorkspacePreviews workspaceId="work" />));
  expect(container.textContent).toContain("Environment build: Building"); expect(container.textContent).toContain("Restart required · Source manifest or location changed");
  expect(container.textContent).toContain("Reload and compilation are managed by the application");
  vi.mocked(developmentRequest).mockResolvedValue(reply({ runtimeState: "stopped", lastError: "Fixture build failed", launchProgress: { stage: "failed", buildState: "failed", changedAt: "2026-10-16T12:01:00Z" } }));
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(container.textContent).toContain("Environment build: Failed"); expect(container.textContent).toContain("Fixture build failed");
  expect(container.textContent).not.toContain("Restart required ·");
});
it("keeps missing observations unknown and clears stale success after read failure", async () => {
  vi.useFakeTimers(); vi.mocked(developmentRequest).mockResolvedValue(reply({ development: { reloadMode: "application-managed", manifestState: "unavailable" } }));
  await act(async () => root.render(<WorkspacePreviews workspaceId="work" />));
  expect(container.textContent).toContain("Launch: Unobserved"); expect(container.textContent).toContain("Restart requirement unavailable");
  expect(container.textContent).toContain("Source manifest: unavailable"); expect(container.textContent).not.toContain("Environment build: Built");
  vi.mocked(developmentRequest).mockRejectedValue(new Error("Read permission revoked"));
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(container.textContent).toContain("Read permission revoked"); expect(container.textContent).not.toContain("Demo App");
});
it("clears restart notice after restart and preserves the same preview URL", async () => {
  vi.useFakeTimers(); vi.mocked(developmentRequest).mockResolvedValue(reply({ restartRequired: true }));
  await act(async () => root.render(<WorkspacePreviews workspaceId="work" />));
  const preview = container.querySelector('a[href="http://core.test/open"]')!.getAttribute("href");
  vi.mocked(developmentRequest).mockResolvedValue(reply({ restartRequired: false, development: { reloadMode: "application-managed", manifestState: "current", restartRequired: false }, launchProgress: { stage: "ready", buildState: "reused", changedAt: "2026-10-16T12:01:00Z" } }));
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(container.textContent).toContain("Environment build: Reused"); expect(container.textContent).not.toContain("Restart required");
  expect(container.querySelector('a[href="http://core.test/open"]')!.getAttribute("href")).toBe(preview);
});


it("shows the observed child process and preserves ordinary application preview query parameters", async () => {
  vi.mocked(developmentRequest).mockResolvedValue({ ...reply({ restartRequired: true, previewUrl: "http://app.test/view?mode=preview#section" }), environments: [{ id: "child", label: "Retained preview", state: "running", previewUrl: "http://core.test", process: { pid: 123, startedAt: "2026-10-21T12:00:00Z" } }] });
  await act(async () => root.render(<WorkspacePreviews workspaceId="work" />));
  expect(container.querySelector('time[datetime="2026-10-21T12:00:00Z"]')).not.toBeNull();
  expect(container.textContent).not.toContain("time to ready");
  expect(container.querySelector('a[href="http://core.test/login"]')?.textContent).toContain("Open test Core");
  expect(container.querySelector('a[href="http://app.test/view?mode=preview#section"]')).not.toBeNull();
  const warning = [...container.querySelectorAll('[role="status"]')].find(node => node.textContent?.startsWith("Restart required"))!;
  expect(warning.closest("details")).toBeNull();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it("shows loading, hides empty previews and retains later inventory observations", async () => {
  vi.useFakeTimers();
  const read = deferred<unknown>();
  vi.mocked(developmentRequest).mockReturnValue(read.promise);
  await act(async () => root.render(<WorkspacePreviews workspaceId="work" />));
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading sandbox previews…");
  expect(container.querySelector(".hosty-grid-loader")).not.toBeNull();
  expect(container.textContent).not.toContain("No sandbox previews");
  await act(async () => read.resolve({ environments: [], applications: {} }));
  expect(container.querySelector('[aria-label="Sandbox previews"]')).toBeNull();
  expect(container.textContent).not.toContain("Loading sandbox previews");
  vi.mocked(developmentRequest).mockResolvedValue(reply({}));
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(container.querySelector('[aria-label="Sandbox previews"]')).not.toBeNull();
  expect(container.textContent).toContain("Retained preview");
  vi.mocked(developmentRequest).mockResolvedValue({ environments: [], applications: {} });
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(container.querySelector('[aria-label="Sandbox previews"]')).toBeNull();
  vi.mocked(developmentRequest).mockRejectedValue(new Error("Preview access unavailable"));
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(container.querySelector('[aria-label="Sandbox previews"]')).not.toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Preview access unavailable");
});

it("distinguishes failed inventory from empty and shows loading during an explicit retry", async () => {
  vi.mocked(developmentRequest).mockRejectedValueOnce(new Error("Preview access unavailable"));
  await act(async () => root.render(<WorkspacePreviews workspaceId="work" />));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Preview access unavailable");
  expect(container.textContent).not.toContain("No sandbox previews");
  const retry = deferred<unknown>();
  vi.mocked(developmentRequest).mockReturnValue(retry.promise);
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Retry previews")!.click());
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading sandbox previews…");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(vi.mocked(developmentRequest).mock.calls.every(([path, body]) => path === "/work/previews" && body === undefined)).toBe(true);
  await act(async () => retry.resolve({ environments: [], applications: {} }));
  expect(container.querySelector('[aria-label="Sandbox previews"]')).toBeNull();
});

it.each([
  { state: "ready", text: "No applications in this preview." },
  { state: "setup-required", text: "Set up this test Core to inspect its applications." },
  { state: "unavailable", text: "Application status unobserved." },
])("keeps $state child observations distinct from an empty sandbox inventory", async ({ state, text }) => {
  vi.mocked(developmentRequest).mockResolvedValue({ ...reply({}), applications: { child: { state, apps: [] } } });
  await act(async () => root.render(<WorkspacePreviews workspaceId="work" />));
  expect(container.textContent).toContain(text);
  expect(container.textContent).not.toContain("No sandbox previews");
  if (state !== "ready") expect(container.textContent).not.toContain("No applications in this preview.");
});

it("keeps missing service observations explicit without claiming that the application is empty or healthy", async () => {
  vi.mocked(developmentRequest).mockResolvedValue(reply({}));
  await act(async () => root.render(<WorkspacePreviews workspaceId="work" />));
  const runtime = container.querySelector('[aria-label="Demo App runtime"]')!;
  expect(runtime.querySelector('[role="status"]')?.textContent).toContain("Service status unobserved");
  expect(runtime.textContent).not.toContain("Health: healthy");
  expect(runtime.textContent).not.toContain("No applications");
});


it.each(["preparing", "starting", "finishing", "stopping"])("distinguishes %s progress with a labelled ring that remains visible without animation", async state => {
  vi.mocked(developmentRequest).mockResolvedValue(reply({ runtimeState: state }));
  await act(async () => root.render(<WorkspacePreviews workspaceId="work" />));
  const badge = container.querySelector('[aria-label="Demo App runtime"] [data-slot="badge"]')!;
  expect(badge.textContent).toBe(state);
  const ring = badge.querySelector("svg");
  expect(ring).not.toBeNull();
  expect(ring?.parentElement?.classList.contains("motion-safe:animate-spin")).toBe(true);
  expect(ring?.closest('[aria-hidden="true"]')).not.toBeNull();
  expect(badge.querySelector(".text-info-foreground")).not.toBeNull();
  expect(badge.querySelector(".animate-spin")).toBeNull();
});

it.each(["failed", "cleanup-failed"])("distinguishes %s with a failure shape rather than a colored ready dot", async state => {
  vi.mocked(developmentRequest).mockResolvedValue(reply({ runtimeState: state }));
  await act(async () => root.render(<WorkspacePreviews workspaceId="work" />));
  const badge = container.querySelector('[aria-label="Demo App runtime"] [data-slot="badge"]')!;
  expect(badge.textContent).toBe(state.replaceAll("-", " "));
  expect(badge.querySelector("svg.lucide-circle-alert.text-destructive-foreground")).not.toBeNull();
  expect(badge.querySelector('[class*="animate-spin"]')).toBeNull();
});

it.each(["ready", "running", "stopped", "unknown"])("keeps %s as a steady labelled state", async state => {
  vi.mocked(developmentRequest).mockResolvedValue(reply({ runtimeState: state }));
  await act(async () => root.render(<WorkspacePreviews workspaceId="work" />));
  const badge = container.querySelector('[aria-label="Demo App runtime"] [data-slot="badge"]')!;
  expect(badge.textContent).toBe(state);
  expect(badge.querySelector("svg")).toBeNull();
  expect(badge.querySelector('[class*="animate-spin"]')).toBeNull();
});
