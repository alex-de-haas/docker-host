import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CreateEnvironmentDialog } from "../src/app/shell/pages/create-environment-dialog";
import { EnvironmentInitialization } from "../src/app/shell/pages/environment-initialization";
import type { CoreEnvironment } from "@hosty-sdk/app/sandbox/server";

const transport = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../src/app/shell/core-transport.js", () => ({ fetchCore: transport.read }));
let root: Root, container: HTMLDivElement;
const catalog = { problems: [], apps: [
  { id: "hosty.shell", title: "Shell", description: "Manage this host in your browser", defaultEnabled: true },
  { id: "hosty.marketplace", title: "Marketplace", description: "Find applications", defaultEnabled: true },
  { id: "hosty.harness", title: "Harness", description: "Work with agents", defaultEnabled: false },
] };
function button(text: string) {
  const match = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === text);
  expect(match, text).toBeDefined(); return match!;
}
async function click(text: string) { await act(async () => button(text).click()); }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  transport.read.mockReset();
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
  await click("Create and start");
  const input = create.mock.calls[0][0];
  expect(input.initialization.apps).toEqual(["hosty.shell", "hosty.marketplace"]);
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
  expect(button("Create and start").disabled).toBe(true);
  expect(document.body.textContent).toContain("increase the limits");
  for (const choice of choices) await act(async () => choice.click());
  expect(document.body.textContent).toContain("Without Shell");
  await click("Create and start");
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
  expect(button("Create and start").disabled).toBe(false);
  await click("Create and start");
  expect(create).toHaveBeenCalledOnce();
  expect(create.mock.calls[0][0]).toMatchObject({
    initialization: { apps: [] },
    limits: { memoryBytes: 1073741824, applicationMemoryBytes: 1073741824 },
  });
});

it("registers in the child browser and keeps setup credentials out of persistent browser storage", async () => {
  transport.read.mockResolvedValue(Response.json({ phase: "ready", apps: [], hasAdministrator: false, recoveryRequired: false }));
  const request = vi.fn().mockResolvedValue({ token: "one-time-test-token", setupUrl: "http://child.test/setup?setupToken=one-time-test-token", expiresAt: new Date(Date.now() + 60000).toISOString() });
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const item = { id: "1".repeat(32) } as CoreEnvironment;
  await act(async () => root.render(<EnvironmentInitialization item={item} origin="https://core.test" pollVersion={0} request={request} />));
  await click("Set up administrator");
  expect(request).toHaveBeenCalledWith(`/${item.id}/setup-link`, {});
  expect(open).toHaveBeenCalledWith(expect.stringContaining("/setup?setupToken="), "_blank", "noopener,noreferrer");
  expect(document.querySelector('input[type="password"]')).toBeNull();
  expect(sessionStorage.length).toBe(0); expect(localStorage.length).toBe(0);
  expect(document.querySelector('a[href*="setupToken="]')).not.toBeNull();
  transport.read.mockResolvedValue(Response.json({ phase: "ready", apps: [], hasAdministrator: true, shellUrl: "http://shell.child.test" }));
  await act(async () => root.render(<EnvironmentInitialization item={item} origin="https://core.test" pollVersion={1} request={request} />));
  expect(container.textContent).not.toContain("one-time-test-token");
  expect(container.textContent).toContain("Open Shell");
});


it("copies setup links and tokens and gives a fallback when clipboard access is unavailable", async () => {
  transport.read.mockResolvedValue(Response.json({ phase: "ready", apps: [], hasAdministrator: false, recoveryRequired: false }));
  const link = { token: "test-copy-token", setupUrl: "http://child.test/setup?setupToken=test-copy-token", expiresAt: new Date(Date.now() + 60000).toISOString() };
  const request = vi.fn().mockResolvedValue(link);
  vi.spyOn(window, "open").mockReturnValue(null);
  vi.stubGlobal("navigator", {});
  await act(async () => root.render(<EnvironmentInitialization item={{ id: "1".repeat(32) } as CoreEnvironment} origin="https://core.test" pollVersion={0} request={request} />));
  await click("Set up administrator");
  await click("Copy setup token");
  expect(container.textContent).toContain("Clipboard unavailable. Select and copy the token below.");
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  await click("Copy setup link");
  expect(writeText).toHaveBeenLastCalledWith(link.setupUrl);
  expect(container.textContent).toContain("Link copied");
  await click("Copy setup token");
  expect(writeText).toHaveBeenLastCalledWith(link.token);
  expect(container.textContent).toContain("Token copied");
  expect(container.textContent).not.toContain("Clipboard unavailable");
});


it("keeps progress neutral until Core replies and shows errors without inventing readiness", async () => {
  transport.read.mockReturnValue(new Promise(() => {}));
  const request = vi.fn();
  const item = { id: "1".repeat(32) } as CoreEnvironment;
  await act(async () => root.render(<EnvironmentInitialization item={item} origin="https://core.test" pollVersion={0} request={request} />));
  expect(container.querySelector('[aria-label="Environment setup stages"] [aria-current]')).toBeNull();
  expect(container.textContent).toContain("Reading initialization progress");
  transport.read.mockResolvedValue(Response.json({ phase: "failed", hasAdministrator: false, recoveryRequired: false,
    error: "Application start failed", apps: [{ id: "hosty.shell", title: "Shell", state: "failed", error: "Port unavailable" },
      { id: "hosty.harness", title: "Harness", state: "ready" }] }));
  await act(async () => root.render(<EnvironmentInitialization item={item} origin="https://core.test" pollVersion={1} request={request} />));
  expect(container.querySelector('[aria-current="step"]')?.textContent).toContain("Install");
  expect(container.querySelector('[aria-label="Selected application progress"]')?.textContent).toContain("1 of 2 ready");
  expect(container.textContent).toContain("Port unavailable");
  expect(container.textContent).toContain("Application start failed");
  expect(container.textContent).not.toContain("Register the first administrator");
  expect([...container.querySelectorAll("button")].map(item => item.textContent)).toEqual(["Resume initialization"]);
  expect(request).not.toHaveBeenCalled();
});

it("maps existing selection, administrator and Core-only readiness to the setup stages", async () => {
  const item = { id: "1".repeat(32) } as CoreEnvironment;
  const request = vi.fn();
  for (const [pollVersion, status, expected] of [
    [0, { phase: "selection", hasAdministrator: false }, "Choose apps"],
    [1, { phase: "ready", hasAdministrator: false }, "Administrator"],
    [2, { phase: "ready", hasAdministrator: true }, "Open"],
  ] as const) {
    transport.read.mockResolvedValue(Response.json({ ...status, apps: [], recoveryRequired: false }));
    await act(async () => root.render(<EnvironmentInitialization item={item} origin="https://core.test" pollVersion={pollVersion} request={request} />));
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain(expected);
  }
  expect(container.textContent).toContain("Core is ready for CLI/API use");
  expect(container.querySelector('a[href]')).toBeNull();
  expect(request).not.toHaveBeenCalled();
});


it("separates reading from active installation and keeps completion and failure static", async () => {
  const request = vi.fn();
  const item = { id: "1".repeat(32) } as CoreEnvironment;
  transport.read.mockReturnValue(new Promise(() => {}));
  await act(async () => root.render(<EnvironmentInitialization item={item} origin="https://core.test" pollVersion={0} request={request} />));
  expect(container.querySelector(".lucide-loader-circle")).toBeNull();
  transport.read.mockResolvedValue(Response.json({ phase: "installing", hasAdministrator: false, recoveryRequired: false,
    apps: ["installing", "starting", "ready", "failed"].map(state => ({ id: state, title: state, state })) }));
  await act(async () => root.render(<EnvironmentInitialization item={item} origin="https://core.test" pollVersion={1} request={request} />));
  const rows = [...container.querySelectorAll('[aria-label="Selected application progress"] li')];
  expect(rows).toHaveLength(4);
  for (const row of rows.slice(0, 2)) {
    const ring = row.querySelector(".lucide-loader-circle")!;
    expect(ring.classList.contains("text-info-foreground")).toBe(true);
    expect(ring.classList.contains("motion-reduce:animate-none")).toBe(true);
    expect(ring.getAttribute("aria-hidden")).toBe("true");
  }
  expect(rows[2].querySelector(".lucide-circle-check")).not.toBeNull();
  expect(rows[3].querySelector(".lucide-circle-alert")).not.toBeNull();
  expect(rows.slice(2).every(row => !row.querySelector(".animate-spin"))).toBe(true);
  expect(container.textContent).toContain("1 of 4 ready");
  expect(request).not.toHaveBeenCalled();
});
