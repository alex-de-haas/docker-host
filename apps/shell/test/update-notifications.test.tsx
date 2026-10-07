import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAppUpdateNotifications } from "../src/app/shell/update-notifications";
import type { CoreApp } from "../src/app/shell/types";

const notifications = vi.hoisted(() => ({ warning: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("@/components/reui/operation-toast", () => ({ toast: notifications }));
let root: Root;
let container: HTMLDivElement;
const openLogs = vi.fn();
const base = { id: "test.app", displayName: "Test app", capabilities: ["logs"], runtimeState: "running",
  lastOperation: "update", operationStatus: "updating",
  updateProgress: { stage: "checking", changedAt: "2026-10-07T10:00:00Z" } } as CoreApp;
function Observer({ app }: { app: CoreApp }) { useAppUpdateNotifications([app], openLogs); return null; }
async function render(app: CoreApp) { await act(async () => root.render(<Observer app={app} />)); }
beforeEach(() => {
  vi.clearAllMocks(); container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("warns once when queued or reviewed work finishes without readiness and opens the app logs", async () => {
  await render(base);
  const finished = { ...base, operationStatus: "started", updateProgress: { stage: "needs-attention", changedAt: "2026-10-07T10:01:00Z" },
    health: { status: "degraded", observedAt: "now", services: [{ service: "app", status: "running", health: "unhealthy" }] } };
  await render(finished);
  await render({ ...finished });
  expect(notifications.warning).toHaveBeenCalledTimes(1);
  expect(notifications.success).not.toHaveBeenCalled();
  const options = notifications.warning.mock.calls[0][1];
  expect(options.description).toContain("app: unhealthy");
  options.action.onClick();
  expect(openLogs).toHaveBeenCalledWith(finished);
});

it("does not replay old warnings on reload or turn recovery into a new update", async () => {
  const finished = { ...base, operationStatus: "started", updateProgress: { stage: "needs-attention", changedAt: "old" } };
  await render(finished);
  await render({ ...finished, health: { status: "healthy", services: [], observedAt: "now" } });
  expect(notifications.warning).not.toHaveBeenCalled();
  expect(notifications.success).not.toHaveBeenCalled();
});

it("reports a new completed operation even when the intermediate snapshots were missed", async () => {
  await render({ ...base, lastOperation: "start", operationStatus: "started" });
  await render({ ...base, operationStatus: "updated", updateProgress: { stage: "completed", changedAt: "new" } });
  expect(notifications.success).toHaveBeenCalledOnce();
  expect(notifications.warning).not.toHaveBeenCalled();
});

it("waits for terminal operation status before reporting failure", async () => {
  await render(base);
  const failed = { ...base, updateProgress: { stage: "failed", changedAt: "new" }, lastError: "Image pull failed" };
  await render(failed);
  expect(notifications.error).not.toHaveBeenCalled();
  await render({ ...failed, operationStatus: "failed" });
  expect(notifications.error).toHaveBeenCalledWith("Test app: update failed", expect.objectContaining({ description: "Image pull failed" }));
});
