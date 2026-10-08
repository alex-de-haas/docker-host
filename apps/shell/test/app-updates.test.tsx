import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createInstallationClient, InstallationError, type InstallationClient, type InstallationRequest } from "@hosty-sdk/app/install";
import { CoreRequestError } from "../src/app/shell/core-api";
import { enqueueRoutineUpdate, isStaleUpdatePreparation, prepareAppUpdate, requestAppUpdate, reviewUpdatesInOrder } from "../src/app/shell/app-updates";

const draft: InstallationRequest = { id: "update-request", status: "draft", plan: null,
  approvalUrl: "http://core.localhost/install/confirm/update-request", expiresAt: "2099-01-01T00:00:00Z" };
function client(): InstallationClient {
  return { prepare: vi.fn(async () => draft), submit: vi.fn(async (): Promise<InstallationRequest> => ({ ...draft, status: "pending" })),
    status: vi.fn(async (): Promise<InstallationRequest> => ({ ...draft, status: "succeeded" })) };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it.each(["permissions.app", "hosty.shell"])("routes %s through confirmation and waits for completed execution", async appId => {
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

it("submits bulk updates sequentially, including after failure, with Shell last", async () => {
  let release!: (approved: boolean) => void;
  const review = vi.fn().mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve; })).mockResolvedValue(true);
  const result = reviewUpdatesInOrder([{ id: "hosty.shell" }, { id: "first" }, { id: "second" }], "hosty.shell", review);
  expect(review.mock.calls).toEqual([[{ id: "first" }]]);
  release(false); await result;
  expect(review.mock.calls).toEqual([[{ id: "first" }], [{ id: "second" }], [{ id: "hosty.shell" }]]);
});

it("queues routine updates once without preparing a Core confirmation", async () => {
  const request = vi.fn(async () => Response.json({ status: "updating" }));
  await enqueueRoutineUpdate(request, "", "routine.app", "reviewed-digest");
  expect(request).toHaveBeenCalledExactlyOnceWith("/api/apps/routine.app/update", { planDigest: "reviewed-digest" });
});
it("does not replay an uncertain routine update or open a confirmation", async () => {
  const request = vi.fn().mockRejectedValue(new Error("Network unavailable"));
  await expect(enqueueRoutineUpdate(request, "", "hosty.shell", "digest")).rejects.toThrow("Network unavailable");
  expect(request).toHaveBeenCalledTimes(1);
});

it("uses the valid Core snapshot and rebuilds only an expired/missing snapshot", async () => {
  const plan = { planDigest: "fresh" };
  const cached = vi.fn(async () => plan); const rebuild = vi.fn(async () => ({ planDigest: "rebuilt" }));
  expect(await prepareAppUpdate(cached, rebuild)).toEqual(plan);
  expect(rebuild).not.toHaveBeenCalled();
  cached.mockResolvedValueOnce(null as unknown as typeof plan);
  expect(await prepareAppUpdate(cached, rebuild)).toEqual({ planDigest: "rebuilt" });
  expect(rebuild).toHaveBeenCalledTimes(1);
  await prepareAppUpdate(cached, rebuild, true);
  expect(cached).toHaveBeenCalledTimes(2);
  expect(rebuild).toHaveBeenCalledTimes(2);
});
it("does not turn a failed cache read or failed refresh into consent or a retry loop", async () => {
  const rebuild = vi.fn().mockRejectedValue(new Error("Source unavailable"));
  await expect(prepareAppUpdate(vi.fn().mockRejectedValue(new Error("Access revoked")), rebuild)).rejects.toThrow("Access revoked");
  expect(rebuild).not.toHaveBeenCalled();
  await expect(prepareAppUpdate(async () => null, rebuild)).rejects.toThrow("Source unavailable");
  expect(rebuild).toHaveBeenCalledTimes(1);
});

it("recovers a lost update submission and unavailable status transport with the original identity", async () => {
  const api = client(); const submitted = vi.fn();
  vi.mocked(api.submit).mockRejectedValue(new TypeError("Submit response lost"));
  vi.mocked(api.status).mockRejectedValueOnce(new InstallationError("Proxy unavailable", 503))
    .mockRejectedValueOnce(new TypeError("Shell restarting"))
    .mockResolvedValueOnce({ ...draft, status: "executing" });
  const result = requestAppUpdate(api, "hosty.shell", "reviewed-digest", submitted);
  await vi.advanceTimersByTimeAsync(4000);
  expect((await result).status).toBe("succeeded");
  expect(api.prepare).toHaveBeenCalledExactlyOnceWith({ updateAppId: "hosty.shell", planDigest: "reviewed-digest" });
  expect(api.submit).toHaveBeenCalledExactlyOnceWith(draft.id, {}, false);
  expect(vi.mocked(api.status).mock.calls.every(([id]) => id === draft.id)).toBe(true);
  expect(submitted).toHaveBeenCalledExactlyOnceWith({ ...draft, status: "executing" });
});

it("only explicit pre-submit stale refusals authorize refreshing the candidate", () => {
  for (const status of [400, 409]) {
    for (const code of ["update_plan_expired", "update_plan_stale", "update_plan_digest_mismatch"]) {
      expect(isStaleUpdatePreparation(new InstallationError("Stale", status, code))).toBe(true);
      expect(isStaleUpdatePreparation(new CoreRequestError("Stale", code, status, null))).toBe(true);
    }
  }
  for (const error of [new TypeError("Network lost"), new InstallationError("Busy", 503, "update_plan_stale"),
    new InstallationError("Forbidden", 403), new InstallationError("Failed", 409, "operation_failed"),
    new CoreRequestError("Transport uncertain", "update_plan_stale", 503, null),
    new CoreRequestError("Access revoked", "update_plan_stale", 403, null),
    new InstallationError("Invalid input", 400, "operation_failed"),
    new CoreRequestError("Invalid input", "operation_failed", 400, null),
    new CoreRequestError("Execution failed", "operation_failed", 409, null),
    new CoreRequestError("Unclassified bad request", null, 400, null),
    new CoreRequestError("Unclassified conflict", null, 409, null),
    new CoreRequestError("Unexpected client status", "update_plan_stale", 422, null),
    { code: "update_plan_stale", status: 400 }, { code: "update_plan_stale", status: 409 }])
    expect(isStaleUpdatePreparation(error)).toBe(false);
});


it.each(["update_plan_expired", "update_plan_stale", "update_plan_digest_mismatch"])(
  "recognizes the actual Shell transport's %s preparation refusal before submission", async code => {
    const refusal = new CoreRequestError("Candidate changed", code, 409, { code });
    // sendCsrfJson rejects before the shared SDK can receive or wrap a Response.
    const request = vi.fn(async () => { throw refusal; });
    const api = createInstallationClient({ baseUrl: "/api/installations", request });
    const submitted = vi.fn();
    const error = await requestAppUpdate(api, "target", "old-digest", submitted).catch(cause => cause);
    expect(error).toBe(refusal);
    expect(isStaleUpdatePreparation(error)).toBe(true);
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/installations", { updateAppId: "target", planDigest: "old-digest" }, "POST");
    expect(submitted).not.toHaveBeenCalled();
  },
);

it("recovers an uncertain real Shell submit by its original identity without retrying the mutation", async () => {
  const request = vi.fn(async (url: string) => {
    if (url.endsWith("/submit")) throw new CoreRequestError("Proxy interrupted", "update_plan_stale", 503, null);
    return Response.json({ ...draft, status: url.endsWith(draft.id) ? "succeeded" : "draft" });
  });
  const api = createInstallationClient({ baseUrl: "/api/installations", request });
  const result = await requestAppUpdate(api, "hosty.shell", "digest", vi.fn());
  expect(result.status).toBe("succeeded");
  expect(request.mock.calls.map(([url]) => url)).toEqual([
    "/api/installations", "/api/installations/update-request/submit", "/api/installations/update-request",
  ]);
  expect(isStaleUpdatePreparation(new CoreRequestError("Proxy interrupted", "update_plan_stale", 503, null))).toBe(false);
});
