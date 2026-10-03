import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createInstallationClient, InstallationError, type InstallationClient, type InstallationRequest } from "@hosty-sdk/app/install";
import { requestAppUpdate, reviewUpdatesInOrder } from "../src/app/shell/app-updates";

const draft: InstallationRequest = { id: "update-request", status: "draft", plan: null,
  approvalUrl: "http://core.localhost/install/confirm/update-request", expiresAt: "2099-01-01T00:00:00Z" };
function client(): InstallationClient {
  return { prepare: vi.fn(async () => draft), submit: vi.fn(async (): Promise<InstallationRequest> => ({ ...draft, status: "pending" })),
    status: vi.fn(async (): Promise<InstallationRequest> => ({ ...draft, status: "succeeded" })) };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it.each(["routine.app", "hosty.shell"])("routes %s through confirmation and waits for completed execution", async appId => {
  const request = vi.fn(async (url: string) => Response.json({ ...draft,
    status: url.endsWith("/submit") ? "pending" : url.endsWith(draft.id) ? "succeeded" : "draft" }));
  const api = createInstallationClient({ baseUrl: "/api/installations", request });
  const submitted = vi.fn(); const settled = vi.fn();
  const result = requestAppUpdate(api, appId, "reviewed-digest", submitted).then(settled);
  await vi.advanceTimersByTimeAsync(0);
  expect(request.mock.calls.map(call => call[0])).toEqual(["/api/installations", "/api/installations/update-request/submit"]);
  expect(request).toHaveBeenNthCalledWith(1, "/api/installations", { updateAppId: appId, planDigest: "reviewed-digest" }, "POST");
  expect(submitted).toHaveBeenCalledWith(expect.objectContaining({ status: "pending" }));
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000); await result;
  expect(settled).toHaveBeenCalledWith(expect.objectContaining({ status: "succeeded" }));
  expect(request).toHaveBeenLastCalledWith("/api/installations/update-request", undefined, "GET");
});

it("returns denial without applying or retrying the update", async () => {
  const api = client(); vi.mocked(api.status).mockResolvedValue({ ...draft, status: "denied" });
  const result = requestAppUpdate(api, "target", "digest", vi.fn());
  await vi.advanceTimersByTimeAsync(1000);
  expect((await result).status).toBe("denied");
  expect(api.prepare).toHaveBeenCalledTimes(1); expect(api.submit).toHaveBeenCalledTimes(1);
});

it("survives a Shell restart interruption without resubmitting the update", async () => {
  const api = client();
  vi.mocked(api.status).mockRejectedValueOnce(new TypeError("Network unavailable"))
    .mockRejectedValueOnce(new InstallationError("Proxy unavailable", 502))
    .mockResolvedValueOnce({ ...draft, status: "executing" });
  const result = requestAppUpdate(api, "hosty.shell", "digest", vi.fn());
  await vi.advanceTimersByTimeAsync(4000);
  expect((await result).status).toBe("succeeded");
  expect(api.submit).toHaveBeenCalledTimes(1); expect(api.prepare).toHaveBeenCalledTimes(1);
});

it("does not swallow authorization refusals while polling", async () => {
  const api = client(); vi.mocked(api.status).mockRejectedValue(new InstallationError("Access revoked", 403));
  const result = expect(requestAppUpdate(api, "target", "digest", vi.fn())).rejects.toThrow("Access revoked");
  await vi.advanceTimersByTimeAsync(1000); await result;
  expect(api.status).toHaveBeenCalledTimes(1);
});

it("reports failed execution without starting another update", async () => {
  const api = client(); vi.mocked(api.status).mockResolvedValue({ ...draft, status: "failed", error: "Plan changed" });
  const result = expect(requestAppUpdate(api, "target", "digest", vi.fn())).rejects.toThrow("Plan changed");
  await vi.advanceTimersByTimeAsync(1000); await result;
  expect(api.submit).toHaveBeenCalledTimes(1);
});

it("reviews bulk updates sequentially, including after denial, with Shell last", async () => {
  let release!: (approved: boolean) => void;
  const review = vi.fn().mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve; })).mockResolvedValue(true);
  const result = reviewUpdatesInOrder([{ id: "hosty.shell" }, { id: "first" }, { id: "second" }], "hosty.shell", review);
  expect(review.mock.calls).toEqual([[{ id: "first" }]]);
  release(false); await result;
  expect(review.mock.calls).toEqual([[{ id: "first" }], [{ id: "second" }], [{ id: "hosty.shell" }]]);
});
