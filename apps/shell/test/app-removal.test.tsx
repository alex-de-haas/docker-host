import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallationClient, InstallationRequest } from "@hosty-sdk/app/install";
import { requestAppRemoval, requestCoreApproval } from "../src/app/shell/app-removal";

const draft: InstallationRequest = { id: "removal", status: "draft", plan: null,
  approvalUrl: "http://core.hosty.localhost/install/confirm/removal", expiresAt: "2099-01-01T00:00:00Z" };
function client(): InstallationClient {
  return { prepare: vi.fn(async () => draft), submit: vi.fn(async (): Promise<InstallationRequest> => ({ ...draft, status: "pending" })),
    status: vi.fn(async (): Promise<InstallationRequest> => ({ ...draft, status: "succeeded" })) };
}

describe("Core-confirmed app removal", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("waits for the Core decision and execution before reporting success", async () => {
    const api = client();
    vi.mocked(api.status).mockResolvedValueOnce({ ...draft, status: "executing" });
    const submitted = vi.fn(); const finished = vi.fn();
    const result = requestAppRemoval(api, "target", { deleteData: true, deleteBackups: false }, submitted).then(finished);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.prepare).toHaveBeenCalledExactlyOnceWith({ removeAppId: "target", removalOptions: { deleteData: true, deleteBackups: false } });
    expect(api.submit).toHaveBeenCalledExactlyOnceWith("removal", {}, false);
    expect(submitted).toHaveBeenCalledWith({ ...draft, status: "pending" });
    expect(finished).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(finished).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await result;
    expect(finished).toHaveBeenCalledWith({ ...draft, status: "succeeded" });
  });
  it("returns denial without reporting success or repeating removal", async () => {
    const api = client(); vi.mocked(api.status).mockResolvedValue({ ...draft, status: "denied" });
    const result = requestAppRemoval(api, "target", {}, vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    expect((await result).status).toBe("denied");
    expect(api.submit).toHaveBeenCalledTimes(1);
  });
  it("reports execution errors", async () => {
    const api = client(); vi.mocked(api.status).mockResolvedValue({ ...draft, status: "failed", error: "Target changed" });
    const result = expect(requestAppRemoval(api, "target", {}, vi.fn())).rejects.toThrow("Target changed");
    await vi.advanceTimersByTimeAsync(1000);
    await result;
  });
  it("recovers a lost submission response without repeating the mutation", async () => {
    const api = client(); vi.mocked(api.submit).mockRejectedValue(new Error("Connection lost"));
    vi.mocked(api.status).mockResolvedValueOnce({ ...draft, status: "pending" });
    const result = requestAppRemoval(api, "target", {}, vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    expect((await result).status).toBe("succeeded");
    expect(api.submit).toHaveBeenCalledTimes(1);
  });
  it("does not poll indefinitely after the confirmation expires", async () => {
    const api = client(); vi.mocked(api.submit).mockResolvedValue({ ...draft, status: "pending", expiresAt: "2000-01-01T00:00:00Z" });
    await expect(requestAppRemoval(api, "target", {}, vi.fn())).rejects.toThrow("expired");
    expect(api.status).not.toHaveBeenCalled();
  });
});


describe("Core-confirmed host paths", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it.each(["succeeded", "denied"] as const)("waits for %s before returning the host path decision", async status => {
    const api = client(); vi.mocked(api.status).mockResolvedValue({ ...draft, status });
    const source = { hostPathChange: { kind: "source-override" as const, appId: "target", source: { path: "/operator/source" } } };
    const settled = vi.fn();
    const result = requestCoreApproval(api, source, vi.fn()).then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.prepare).toHaveBeenCalledExactlyOnceWith(source);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await result;
    expect(settled).toHaveBeenCalledWith({ ...draft, status });
  });
});
