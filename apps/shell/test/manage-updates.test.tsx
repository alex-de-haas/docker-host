import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppUpdatesPanel } from "../src/app/shell/dialogs/app-updates-panel";
import type { CoreApp, CoreUpdatePlan } from "../src/app/shell/types";
const read = vi.hoisted(() => vi.fn());
vi.mock("../src/app/shell/core-transport.js", () => ({ fetchCore: read }));
let root: Root, node: HTMLDivElement, props: ComponentProps<typeof AppUpdatesPanel>;
const app = { id: "example", version: "1.0", updateCheck: { updateAvailable: true, requiresReview: false, planDigest: "fresh", checkedAt: "2026-10-21T12:00:00Z" } } as CoreApp;
const plan = { appId: "example", currentVersion: "1.0", targetVersion: "1.1", currentRuntime: "docker", targetRuntime: "docker", planDigest: "fresh", changes: ["version:1.0->1.1"], sourceConfigured: true, requiresReview: false } as CoreUpdatePlan;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  read.mockReset().mockResolvedValue(Response.json({ plan }));
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  props = { app, active: true, coreOrigin: "https://core.test", isShell: false, busyAction: null, onCheckUpdate: vi.fn().mockResolvedValue(plan), onUpdate: vi.fn() };
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<AppUpdatesPanel {...props} />));
const click = (label: string) => act(async () => [...node.querySelectorAll("button")].find(button => button.textContent === label)!.click());
it("reads a cached plan without preparing or installing and delegates explicit actions", async () => {
  await render();
  expect(read).toHaveBeenCalledExactlyOnceWith("https://core.test/api/apps/example/update/plan", expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
  expect(node.textContent).toContain("1.1 is available"); expect(node.textContent).toContain("Version changed from 1.0 to 1.1");
  expect(node.textContent).not.toContain("no added Core permissions"); expect(node.textContent).not.toContain("MB");
  expect(props.onCheckUpdate).not.toHaveBeenCalled(); expect(props.onUpdate).not.toHaveBeenCalled();
  await click("Check now"); expect(props.onCheckUpdate).toHaveBeenCalledExactlyOnceWith(app);
  await click("Update"); expect(props.onUpdate).toHaveBeenCalledExactlyOnceWith(app);
});
it("shows review and permission facts only when Core supplied them, including Shell restart guidance", async () => {
  read.mockResolvedValue(Response.json({ plan: { ...plan, requiresReview: true, currentCorePermissions: ["apps.read"], targetCorePermissions: ["apps.read", "apps.install"] } }));
  props.isShell = true; await render();
  expect(node.textContent).toContain("1 added Core permission"); expect(node.textContent).toContain("Updating Shell restarts this interface");
  await click("Review update"); expect(props.onUpdate).toHaveBeenCalledOnce();
});
it("keeps source runtimes explicit without offering a release update or reading plans", async () => {
  props.app = { ...app, live: true }; await render();
  expect(read).not.toHaveBeenCalled(); expect(node.textContent).toContain("Restart adopts manifest changes");
  expect([...node.querySelectorAll("button")].map(button => button.textContent)).toEqual([]);
});
it("does not show an older cached candidate as available after a failed latest check", async () => {
  props.app = { ...app, updateCheck: { ...app.updateCheck!, error: "Feed unavailable" } }; await render();
  expect(node.textContent).toContain("Feed unavailable"); expect(node.textContent).not.toContain("1.1 is available");
  expect([...node.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Check now"]);
});
it("keeps a failed explicit check visible and permits recovery without submitting an update", async () => {
  vi.mocked(props.onCheckUpdate!).mockRejectedValueOnce(new Error("Manifest unavailable"));
  await render(); await click("Check now"); expect(node.textContent).toContain("Manifest unavailable");
  await click("Check now"); expect(node.textContent).not.toContain("Manifest unavailable");
  expect(props.onCheckUpdate).toHaveBeenCalledTimes(2); expect(props.onUpdate).not.toHaveBeenCalled();
});
it("does not call an installed-copy comparison up to date or expose its apply action", async () => {
  read.mockResolvedValue(Response.json({ plan: { ...plan, sourceConfigured: false, changes: [] } }));
  props.app = { ...app, updateCheck: { ...app.updateCheck!, updateAvailable: false } }; await render();
  expect(node.textContent).toContain("cannot detect newer releases"); expect(node.textContent).not.toContain("latest check reported no available update");
  expect([...node.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Check now"]);
});
it("ignores a superseded cached read after an explicit fresh check", async () => {
  let complete!: (value: Response) => void;
  read.mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve; }));
  await render(); await click("Check now");
  await act(async () => complete(Response.json({ plan: { ...plan, targetVersion: "old" } })));
  expect(node.textContent).toContain("1.1 is available"); expect(node.textContent).not.toContain("old is available");
});
it("reads only while its presentation tab is active and aborts a closed read", async () => {
  props.active = false; await render(); expect(read).not.toHaveBeenCalled();
  props.active = true; await render(); const signal = read.mock.calls[0][1].signal as AbortSignal;
  props.active = false; await render(); expect(signal.aborted).toBe(true);
});

it("keeps update execution visible and prevents another update or check while Core is applying", async () => {
  props.app = { ...app, operationStatus: "updating", updateProgress: { stage: "pulling", changedAt: "2026-10-21T12:01:00Z" } }; await render();
  expect(node.querySelector('[role="status"]')?.textContent).toContain("Update in progress · pulling");
  expect([...node.querySelectorAll("button")].every(button => button.disabled)).toBe(true);
  expect(props.onUpdate).not.toHaveBeenCalled(); expect(props.onCheckUpdate).not.toHaveBeenCalled();
});
