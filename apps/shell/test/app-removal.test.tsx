import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreRequestError } from "../src/app/shell/core-api";
import { createInstallationClient, InstallationError, type InstallationClient, type InstallationRequest } from "@hosty-sdk/app/install";
import { CoreApprovalStatusUnknownError, requestAppRemoval, requestCoreApproval } from "../src/app/shell/app-removal";

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
  it("dismisses the confirmation fallback as soon as Core accepts, before execution finishes", async () => {
    const api = client();
    vi.mocked(api.status).mockResolvedValueOnce({ ...draft, status: "executing" });
    const dismiss = vi.fn(); const finished = vi.fn();
    const result = requestAppRemoval(api, "target", {}, () => dismiss).then(finished);
    await vi.advanceTimersByTimeAsync(0);
    expect(dismiss).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(finished).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000); await result;
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(api.submit).toHaveBeenCalledTimes(1);
  });
  it("removes the fallback when polling fails without resubmitting the operation", async () => {
    const api = client();
    vi.mocked(api.status).mockRejectedValue(new Error("Access revoked"));
    const dismiss = vi.fn();
    const result = expect(requestAppRemoval(api, "target", {}, () => dismiss)).rejects.toThrow("Access revoked");
    await vi.advanceTimersByTimeAsync(1000); await result;
    expect(dismiss).toHaveBeenCalledTimes(1);
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

describe("uncertain Core approval submission", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("recovers multiple lost status reads for removal without replacing or submitting its identity", async () => {
    const api = client(); const submitted = vi.fn();
    vi.mocked(api.submit).mockRejectedValue(new TypeError("Submit response lost"));
    vi.mocked(api.status).mockRejectedValueOnce(new TypeError("Network unavailable"))
      .mockRejectedValueOnce(new InstallationError("Proxy unavailable", 502))
      .mockResolvedValueOnce({ ...draft, status: "pending" });
    const result = requestAppRemoval(api, "target", {}, submitted);
    await vi.advanceTimersByTimeAsync(4000);
    expect((await result).status).toBe("succeeded");
    expect(api.prepare).toHaveBeenCalledTimes(1);
    expect(api.submit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.status).mock.calls.every(([id]) => id === draft.id)).toBe(true);
    expect(submitted).toHaveBeenCalledExactlyOnceWith({ ...draft, status: "pending" });
  });
  it.each([401, 403])("keeps a %i submit refusal terminal without further requests", async status => {
    const api = client(); const submitted = vi.fn();
    vi.mocked(api.submit).mockRejectedValue(new InstallationError("Authorization refused", status));
    await expect(requestAppRemoval(api, "target", {}, submitted)).rejects.toMatchObject({ status });
    expect(api.status).not.toHaveBeenCalled();
    expect(submitted).not.toHaveBeenCalled();
  });
  it("keeps an authorization refusal during uncertain-status recovery terminal", async () => {
    const api = client(); const submitted = vi.fn();
    vi.mocked(api.submit).mockRejectedValue(new TypeError("Submit response lost"));
    vi.mocked(api.status).mockRejectedValue(new InstallationError("Access revoked", 403));
    await expect(requestAppRemoval(api, "target", {}, submitted)).rejects.toMatchObject({ status: 403 });
    expect(api.status).toHaveBeenCalledExactlyOnceWith(draft.id);
    expect(submitted).not.toHaveBeenCalled();
  });
  it("does not repeat a submission that Core definitively reports as a draft", async () => {
    const api = client(); const submitted = vi.fn();
    vi.mocked(api.submit).mockRejectedValue(new TypeError("Submit response lost"));
    vi.mocked(api.status).mockResolvedValue(draft);
    await expect(requestAppRemoval(api, "target", {}, submitted)).rejects.toThrow("Submit response lost");
    expect(api.prepare).toHaveBeenCalledTimes(1); expect(api.submit).toHaveBeenCalledTimes(1);
    expect(api.status).toHaveBeenCalledExactlyOnceWith(draft.id);
    expect(submitted).not.toHaveBeenCalled();
  });
  it("stops uncertain recovery at expiry while preserving the identity in an explicit error", async () => {
    const api = client(); const expiresAt = new Date(Date.now() + 2000).toISOString();
    vi.mocked(api.prepare).mockResolvedValue({ ...draft, expiresAt });
    vi.mocked(api.submit).mockRejectedValue(new TypeError("Submit response lost"));
    vi.mocked(api.status).mockRejectedValue(new InstallationError("Proxy unavailable", 502));
    const result = expect(requestAppRemoval(api, "target", {}, vi.fn())).rejects.toMatchObject({
      name: CoreApprovalStatusUnknownError.prototype.name, requestId: draft.id, expiresAt,
      message: expect.stringContaining("Check Core before preparing another request"),
    });
    await vi.advanceTimersByTimeAsync(3000); await result;
    expect(api.prepare).toHaveBeenCalledTimes(1); expect(api.submit).toHaveBeenCalledTimes(1);
    expect(api.status).toHaveBeenCalledTimes(2);
  });
});


it.each([403, 409])("does not recover a definitive real Shell submit refusal with status %s", async status => {
  const refusal = new CoreRequestError("Confirmation refused", "approval_expired", status, null);
  const request = vi.fn(async (url: string) => {
    if (url.endsWith("/submit")) throw refusal;
    return Response.json(draft);
  });
  const api = createInstallationClient({ baseUrl: "/api/installations", request });
  await expect(requestAppRemoval(api, "target", {}, vi.fn())).rejects.toBe(refusal);
  expect(request.mock.calls.map(([url]) => url)).toEqual([
    "/api/installations", "/api/installations/removal/submit",
  ]);
});

it("stops uncertain-submit status recovery on an actual CoreRequestError authorization refusal", async () => {
  const refusal = new CoreRequestError("Access revoked", "admin_required", 403, null);
  const request = vi.fn(async (url: string) => {
    if (url.endsWith("/submit")) throw new TypeError("Submit response lost");
    if (url.endsWith(draft.id)) throw refusal;
    return Response.json(draft);
  });
  const api = createInstallationClient({ baseUrl: "/api/installations", request });
  await expect(requestAppRemoval(api, "target", {}, vi.fn())).rejects.toBe(refusal);
  expect(request.mock.calls.map(([url]) => url)).toEqual([
    "/api/installations", "/api/installations/removal/submit", "/api/installations/removal",
  ]);
});
