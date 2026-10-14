import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { waitForShellRuntimeSwitch } from "../src/app/shell/self-runtime-switch";

const read = vi.hoisted(() => vi.fn());
vi.mock("../src/app/shell/core-transport.js", () => ({ fetchCore: read }));
const options = { coreOrigin: "https://core.test", shellAppId: "hosty.shell", targetRuntime: "docker", timeoutMs: 10_000 };
const record = (overrides = {}) => Response.json({ apps: [{ id: "hosty.shell", selectedRuntime: "docker", runtimeState: "running", operationStatus: "started", ...overrides }] });
beforeEach(() => { vi.useFakeTimers(); read.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

it("waits through the old origin, unavailable proxy and target startup", async () => {
  read.mockResolvedValueOnce(record({ selectedRuntime: "dev" }))
    .mockRejectedValueOnce(new TypeError("Disconnected"))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(record({ runtimeState: "stopped", operationStatus: "runtime-switched" }))
    .mockResolvedValueOnce(record({ runtimeState: "starting", operationStatus: "runtime-switched" }))
    .mockResolvedValueOnce(record());
  const outcome = waitForShellRuntimeSwitch(options);
  await vi.advanceTimersByTimeAsync(7_500);
  expect(await outcome).toEqual({ kind: "settled" });
  expect(read).toHaveBeenCalledTimes(6);
});

it("reports a persisted rollback without claiming that the old runtime completed the switch", async () => {
  read.mockResolvedValue(record({ selectedRuntime: "dev", runtimeState: "stopped", operationStatus: "runtime-switch-rollback", lastError: "Image failed to start" }));
  expect(await waitForShellRuntimeSwitch(options)).toEqual({ kind: "failed", message: "Image failed to start" });
});

it("bounds both a hanging read and the overall wait without replaying the mutation", async () => {
  read.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  }));
  const outcome = waitForShellRuntimeSwitch(options);
  await vi.advanceTimersByTimeAsync(options.timeoutMs);
  expect(await outcome).toEqual({ kind: "unresolved" });
  expect(read.mock.calls.every(([, init]) => !init.method)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
