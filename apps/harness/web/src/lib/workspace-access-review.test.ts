import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { approveWorkspaceAccess } from "./workspace-access-review";
const client = vi.hoisted(() => ({ prepare: vi.fn(), submit: vi.fn(), status: vi.fn() }));
vi.mock("@hosty-sdk/app/install", () => ({ createInstallationClient: () => client }));
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => vi.useRealTimers());
it("prepares and submits the exact candidate before exposing a usable Core confirmation URL", async () => {
  const review = { workspaceManifest: { planDigest: "exact-candidate" } };
  const draft = { id: "review", status: "draft", approvalUrl: "https://core.test/install/confirm/review", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const pending = { ...draft, status: "pending" };
  client.prepare.mockResolvedValue(draft); client.submit.mockResolvedValue(pending); client.status.mockResolvedValue({ ...draft, status: "succeeded" });
  const submitted = vi.fn();
  const result = approveWorkspaceAccess(review, submitted);
  await vi.advanceTimersByTimeAsync(1);
  expect(client.prepare).toHaveBeenCalledWith(review);
  expect(client.submit).toHaveBeenCalledWith("review", {}, false);
  expect(submitted).toHaveBeenCalledWith(pending);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await result).status).toBe("succeeded");
  expect(client.prepare).toHaveBeenCalledOnce(); expect(client.submit).toHaveBeenCalledOnce();
});
it("recovers an uncertain submit by reading its existing identity", async () => {
  const draft = { id: "same", status: "draft", approvalUrl: "https://core.test/install/confirm/same", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  client.prepare.mockResolvedValue(draft); client.submit.mockRejectedValue(new TypeError("response lost")); client.status.mockResolvedValue({ ...draft, status: "denied" });
  expect((await approveWorkspaceAccess({ workspaceManifest: {} }, () => {})).status).toBe("denied");
  expect(client.status).toHaveBeenCalledWith("same"); expect(client.submit).toHaveBeenCalledOnce();
});
