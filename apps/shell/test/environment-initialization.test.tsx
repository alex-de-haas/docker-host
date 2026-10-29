import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CreateEnvironmentDialog } from "../src/app/shell/pages/create-environment-dialog";
import { DashboardSandboxes } from "../src/app/shell/pages/dashboard-sandboxes";
import type { CoreEnvironment } from "@hosty-sdk/app/sandbox/server";

const transport = vi.hoisted(() => ({ read: vi.fn(), send: vi.fn(), refresh: async () => {} }));
vi.mock("../src/app/shell/core-transport.js", () => ({ fetchCore: transport.read }));
vi.mock("../src/app/shell/shell-context", () => ({ useShellActions: () => ({ sendCsrfJson: transport.send }) }));
vi.mock("../src/app/shell/events/sandbox-events", () => ({ watchSandboxEvents: (_origin: string, refresh: () => Promise<void>) => { transport.refresh = refresh; return () => {}; } }));
let root: Root, container: HTMLDivElement;
const catalog = { problems: [], apps: [
  { id: "hosty.shell", title: "Shell", description: "Manage this host in your browser", defaultEnabled: true },
  { id: "hosty.marketplace", title: "Marketplace", description: "Find applications", defaultEnabled: true },
  { id: "hosty.harness", title: "Harness", description: "Work with agents", defaultEnabled: false },
] };
function button(text: string) {
  const match = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === text || item.getAttribute("aria-label") === text);
  expect(match, text).toBeDefined(); return match!;
}
async function click(text: string) { await act(async () => button(text).click()); }
async function problemTooltip() {
  const indicator = container.querySelector<HTMLElement>('[role="img"][aria-label="Problem with Playback QA"]')!;
  expect(indicator).not.toBeNull();
  expect(indicator.closest("button")).toBeNull();
  await act(async () => indicator.focus());
  return document.querySelector('[role="tooltip"]')!;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  transport.read.mockReset(); transport.send.mockReset();
  sessionStorage.clear(); localStorage.clear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("loads recommended choices with descriptions and creates an explicit fresh environment", async () => {
  transport.read.mockResolvedValue(Response.json(catalog));
  const create = vi.fn().mockResolvedValue(undefined);
  await act(async () => root.render(<CreateEnvironmentDialog origin="https://core.test" disabled={false} onCreate={create} />));
  await click("Create environment");
  expect(document.body.textContent).toContain("Manage this host in your browser");
  const choices = [...document.querySelectorAll('[role="checkbox"]')];
  expect(choices.map(item => item.getAttribute("data-state"))).toEqual(["checked", "checked", "unchecked"]);
  await click("Create");
  const input = create.mock.calls[0][0];
  expect(input.initialization.apps).toEqual(["hosty.shell", "hosty.marketplace"]);
  expect(input.mode).toBe("release");
  expect(input).not.toHaveProperty("projectPath");
  expect(input.initialization.schemaVersion).toBe("hosty-initialization.0.1");
  expect(input.requestId).not.toBe(input.initialization.requestId);
  expect(input.corePort).toBeUndefined();
  expect(input.worktreeIds).toBeUndefined();
});

it("prevents three apps from exceeding the default reservation and allows Core-only selection", async () => {
  transport.read.mockResolvedValue(Response.json(catalog));
  const create = vi.fn().mockResolvedValue(undefined);
  await act(async () => root.render(<CreateEnvironmentDialog origin="https://core.test" disabled={false} onCreate={create} />));
  await click("Create environment");
  const choices = [...document.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];
  await act(async () => choices[2].click());
  expect(button("Create").disabled).toBe(true);
  expect(document.body.textContent).toContain("increase the limits");
  for (const choice of choices) await act(async () => choice.click());
  expect(document.body.textContent).toContain("Without Shell");
  await click("Create");
  expect(create.mock.calls[0][0].initialization.apps).toEqual([]);
});

it("keeps the per-app limit within a one GiB Core-only environment", async () => {
  transport.read.mockResolvedValue(Response.json(catalog));
  const create = vi.fn().mockResolvedValue(undefined);
  await act(async () => root.render(<CreateEnvironmentDialog origin="https://core.test" disabled={false} onCreate={create} />));
  await click("Create environment");
  for (const choice of document.querySelectorAll<HTMLButtonElement>('[role="checkbox"][data-state="checked"]'))
    await act(async () => choice.click());
  const memory = document.querySelector<HTMLInputElement>('input[id$="-memory"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(memory, "1");
    memory.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(button("Create").disabled).toBe(false);
  await click("Create");
  expect(create).toHaveBeenCalledOnce();
  expect(create.mock.calls[0][0]).toMatchObject({
    initialization: { apps: [] },
    limits: { memoryBytes: 1073741824, applicationMemoryBytes: 1073741824 },
  });
});

it("closes creation immediately, keeps its header/footer outside scrolling content, and rejects invalid input locally", async () => {
  transport.read.mockResolvedValue(Response.json(catalog));
  const create = vi.fn(() => new Promise<void>(() => {}));
  await act(async () => root.render(<CreateEnvironmentDialog origin="https://core.test" disabled={false} onCreate={create} />));
  await click("Create environment");
  const dialog = document.querySelector('[role="dialog"]')!;
  const body = dialog.querySelector('[data-slot="dialog-body"]')!;
  expect(body.contains(dialog.querySelector('[data-slot="dialog-header"]'))).toBe(false);
  expect(body.contains(button("Create"))).toBe(false);
  expect(dialog.querySelector('[aria-label="Environment setup stages"]')).toBeNull();
  const ports = dialog.querySelector<HTMLInputElement>('input[id$="-app-ports"]')!;
  const changePorts = (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(ports, value);
    ports.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await changePorts("invalid"); await click("Create");
  expect(create).not.toHaveBeenCalled(); expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await changePorts(""); await click("Create");
  expect(create).toHaveBeenCalledOnce(); expect(document.querySelector('[role="dialog"]')).toBeNull();
});

const origin = "https://core.test", id = "1".repeat(32);
let item: CoreEnvironment;
let status: { phase: string; hasAdministrator: boolean; recoveryRequired: boolean; apps: { id: string; title: string; state: string; error?: string }[]; error?: string; shellUrl?: string };
function fixture() {
  item = { id, label: "Playback QA", mode: "current", state: "running", revision: 2, port: 7001, previewUrl: "http://child.test", initializationRequested: true, operations: [] };
  status = { phase: "ready", hasAdministrator: false, recoveryRequired: false, apps: [] };
  transport.read.mockImplementation(async (url: string) => {
    if (url.endsWith("/core-environments")) return Response.json({ environments: [item] });
    if (url.endsWith("/initialization")) return Response.json(status);
    if (url.endsWith("/apps")) return Response.json({ state: "ready", apps: [{ id: "example.player", displayName: "Player", runtimeState: "running", health: "healthy" }] });
    throw new Error(`Unexpected read ${url}`);
  });
}
const renderSandboxes = () => act(async () => root.render(<DashboardSandboxes coreOrigin={origin} connectedCore={<div>Hosty Core</div>} workspaces={[]} />));
const focus = () => act(async () => window.dispatchEvent(new Event("focus")));
async function menu() {
  await act(async () => button("More actions for Playback QA").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
}
async function menuAction(text: string) {
  await menu();
  const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === text)!;
  expect(action).toBeDefined();
  await act(async () => action.click());
}

it("shows row installation progress and a single installed-app list in Environment Details", async () => {
  fixture(); status.phase = "preparing"; status.apps = [{ id: "example.player", title: "Player", state: "installing" }];
  await renderSandboxes();
  expect(container.querySelector(".dashboard-sandbox-status")?.textContent).toContain("Installing Player…");
  expect(container.querySelector(".dashboard-sandbox-row > div:first-child")?.textContent).not.toContain("Installing Player…");
  expect(transport.read.mock.calls.some(([url]) => url.endsWith("/apps"))).toBe(false);
  expect(container.querySelector('[aria-label="Environment setup stages"]')).toBeNull();
  expect(container.querySelector('[aria-label="Selected application progress"]')).toBeNull();
  await click("Environment Details for Playback QA");
  const apps = document.querySelector('[role="dialog"] [aria-label="Environment applications"]')!;
  expect(apps.querySelectorAll("li")).toHaveLength(1);
  expect(apps.textContent).toContain("Player"); expect(apps.textContent).toContain("running · healthy");
});

it("registers only the first administrator, then replaces setup with Stop and exposes Open Core in the menu", async () => {
  fixture();
  const link = { token: "one-time-test-token", setupUrl: "http://child.test/setup?setupToken=one-time-test-token", expiresAt: new Date(Date.now() + 60000).toISOString() };
  transport.send.mockResolvedValue(Response.json(link));
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  await renderSandboxes(); await menu();
  expect(document.querySelector('a[href="http://child.test/login"]')).toBeNull();
  await act(async () => document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await click("Sign Up");
  expect(transport.send).toHaveBeenCalledExactlyOnceWith(`${origin}/api/core-environments/${id}/setup-link`, {});
  expect(open).toHaveBeenCalledWith(link.setupUrl, "_blank", "noopener,noreferrer");
  expect(document.querySelector('input[type="password"]')).toBeNull();
  expect(sessionStorage.length).toBe(0); expect(localStorage.length).toBe(0);
  expect(document.querySelector('a[href*="setupToken="]')).not.toBeNull();
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  await click("Copy setup token"); expect(writeText).toHaveBeenLastCalledWith(link.token);
  status.hasAdministrator = true; await focus();
  expect(document.body.textContent).not.toContain(link.token);
  expect(document.body.textContent).not.toContain("Sign Up");
  expect(button("Stop")).toBeDefined();
  await menu(); expect(document.querySelector('a[href="http://child.test/login"]')).not.toBeNull();
});

it("reports setup-link failures without showing Open Core or claiming registration", async () => {
  fixture(); transport.send.mockRejectedValue(new Error("Setup token could not be created"));
  await renderSandboxes(); await click("Sign Up");
  expect(container.textContent).not.toContain("Setup token could not be created");
  expect((await problemTooltip()).textContent).toContain("Setup token could not be created");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await menu(); expect(document.body.textContent).not.toContain("Open Core");
});

it("shows failed initialization beside the name in a focusable tooltip and resumes through its menu", async () => {
  fixture(); status.phase = "failed"; status.apps = [{ id: "example.player", title: "Player", state: "failed", error: "Port unavailable" }];
  transport.send.mockImplementation(async () => Response.json({ ...status, phase: "preparing" }));
  await renderSandboxes(); expect(container.textContent).not.toContain("Player: Port unavailable");
  expect((await problemTooltip()).textContent).toContain("Player: Port unavailable");
  await click("Environment Details for Playback QA");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Player: Port unavailable");
  await click("Close");
  expect(container.querySelector('[aria-current="step"]')).toBeNull();
  await menuAction("Resume initialization");
  expect(transport.send).toHaveBeenCalledExactlyOnceWith(`${origin}/api/core-environments/${id}/initialization/resume`, {});
});

it("does not expose setup or Open Core for unknown or recovery-required administrator state", async () => {
  fixture(); status.recoveryRequired = true;
  await renderSandboxes();
  expect(container.textContent).toContain("Administrator recovery required");
  expect(container.textContent).not.toContain("Sign Up");
  await menu(); expect(document.body.textContent).not.toContain("Open Core");
});

it("observes registration while collapsed and stops timed checks after readiness", async () => {
  vi.useFakeTimers();
  try {
    fixture(); await renderSandboxes();
    const reads = () => transport.read.mock.calls.filter(([url]) => url.endsWith("/initialization")).length;
    expect(reads()).toBe(1);
    status.hasAdministrator = true;
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(reads()).toBe(2); expect(button("Stop")).toBeDefined();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(reads()).toBe(2);
    await focus(); expect(reads()).toBe(3);
  } finally { vi.useRealTimers(); }
});

it("shows creation and recovery in Dashboard after the dialog closes, retaining the exact request", async () => {
  fixture();
  const original = transport.read.getMockImplementation()!;
  transport.read.mockImplementation(async (url: string) => url.endsWith("/bootstrap") ? Response.json(catalog)
    : url.endsWith("/core-environments") ? Response.json({ environments: [] }) : original(url));
  let reject!: (cause: Error) => void;
  transport.send.mockImplementationOnce(() => new Promise<Response>((_resolve, fail) => { reject = fail; }));
  await renderSandboxes(); await click("Create environment"); await click("Create");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain("New environment");
  expect(container.querySelector(".dashboard-sandbox-status")?.textContent).toContain("Creating…");
  expect(container.textContent).not.toContain("Retry same request");
  expect(container.textContent).not.toContain("No sandboxes yet");
  const body = transport.send.mock.calls[0][1];
  await act(async () => reject(new Error("Response lost")));
  expect(container.textContent).toContain("Response lost");
  expect(JSON.parse(sessionStorage.getItem(`hosty:core-environment:${origin}`)!).body).toEqual(body);
  expect(button("Retry same request").disabled).toBe(false);
});

it("ignores a late setup-link response after the sandbox stops", async () => {
  fixture();
  let complete!: (response: Response) => void;
  transport.send.mockImplementation(() => new Promise<Response>(resolve => { complete = resolve; }));
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  await renderSandboxes(); await click("Sign Up");
  item = { ...item, state: "stopped", revision: 3 };
  await act(async () => transport.refresh());
  expect(button("Start")).toBeDefined();
  await act(async () => complete(Response.json({ token: "obsolete-token", setupUrl: "http://child.test/setup?setupToken=obsolete-token", expiresAt: new Date(Date.now() + 60000).toISOString() })));
  expect(open).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("obsolete-token");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("pauses setup observation while hidden and refreshes on return without stale status overwriting registration", async () => {
  vi.useFakeTimers();
  try {
    fixture(); await renderSandboxes();
    const reads = () => transport.read.mock.calls.filter(([url]) => url.endsWith("/initialization")).length;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(reads()).toBe(1);
    const original = transport.read.getMockImplementation()!;
    let complete!: (response: Response) => void;
    transport.read.mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve; }));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    status.hasAdministrator = true; transport.read.mockImplementation(original);
    await focus(); expect(button("Stop")).toBeDefined();
    await act(async () => complete(Response.json({ ...status, hasAdministrator: false })));
    expect(container.textContent).not.toContain("Sign Up");
  } finally { vi.useRealTimers(); }
});
