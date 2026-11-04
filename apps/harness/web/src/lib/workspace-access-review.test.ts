import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { approveWorkspaceAccess, type WorkspaceAccessReview } from "./workspace-access-review";
import { requestWorkspaceAccessReview } from "../../../src/workspace-access-reviews.js";
const client = vi.hoisted(() => ({ prepare: vi.fn(), submit: vi.fn(), status: vi.fn() }));
vi.mock("@hosty-sdk/app/install", () => ({ createInstallationClient: () => client }));
beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
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

it("registers Core's null-valued InstallationPrepare envelope through the strict workspace-only proxy", async () => {
  // InstallationPrepare uses JsonSerializerDefaults.Web without null suppression.
  const review: WorkspaceAccessReview = JSON.parse(JSON.stringify({
    manifestPath: null, feedsUrl: null, feedId: null, selectedRuntime: null,
    updateAppId: null, planDigest: null, sourceConnections: null, permissionsAppId: null,
    removeAppId: null, removalOptions: null, hostPathChange: null,
    workspaceManifest: { appId: "notes", planDigest: "exact-candidate", candidateDigest: "source-digest" },
  }));
  vi.stubEnv("HOSTY_CORE_ORIGIN", "http://core.test");
  vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service");
  const draft = { id: "review", status: "draft", approvalUrl: "https://core.test/install/confirm/review", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const forward = vi.fn().mockResolvedValue(Response.json(draft));
  vi.stubGlobal("fetch", forward);
  client.prepare.mockImplementation(async candidate => {
    const response = await requestWorkspaceAccessReview("POST", "/api/workspace-access-reviews", "identity", candidate);
    if (response.status !== 200) throw new Error(`Workspace review was rejected (${response.status}).`);
    return response.body;
  });
  client.submit.mockResolvedValue({ ...draft, status: "succeeded" });
  expect((await approveWorkspaceAccess(review, () => {})).status).toBe("succeeded");
  const candidate = { workspaceManifest: review.workspaceManifest };
  expect(client.prepare).toHaveBeenCalledExactlyOnceWith(candidate);
  expect(forward).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ body: JSON.stringify(candidate) }));
  expect(client.submit).toHaveBeenCalledExactlyOnceWith("review", {}, false);
});


it.each(["pending", "succeeded", "draft"])("resumes a retained %s confirmation without preparing another review", async status => {
  const retained = { id: "retained", expiresAt: new Date(Date.now() + 60000).toISOString() };
  client.status.mockResolvedValueOnce({ ...retained, status }).mockResolvedValue({ ...retained, status: "succeeded" });
  client.submit.mockResolvedValue({ ...retained, status: "succeeded" });
  const remember = vi.fn(), submitted = vi.fn();
  const result = approveWorkspaceAccess({ workspaceManifest: {} }, submitted, { retained, remember });
  await vi.advanceTimersByTimeAsync(1000);
  expect((await result).status).toBe("succeeded"); expect(client.prepare).not.toHaveBeenCalled();
  expect(client.submit).toHaveBeenCalledTimes(status === "draft" ? 1 : 0);
  expect(remember).toHaveBeenCalledWith(retained);
});
it("retains the review before an uncertain submit and survives transient observation errors", async () => {
  const draft = { id: "same", expiresAt: new Date(Date.now() + 60000).toISOString(), status: "draft" };
  const remember = vi.fn(); client.prepare.mockResolvedValue(draft);
  client.submit.mockImplementation(async () => { expect(remember).toHaveBeenCalledWith({ id: draft.id, expiresAt: draft.expiresAt }); throw new Error("Lost response"); });
  client.status.mockRejectedValueOnce(new Error("Offline")).mockResolvedValue({ ...draft, status: "succeeded" });
  const result = approveWorkspaceAccess({ workspaceManifest: {} }, vi.fn(), { remember });
  await vi.advanceTimersByTimeAsync(1000); expect((await result).status).toBe("succeeded");
  expect(client.submit).toHaveBeenCalledOnce(); expect(client.prepare).toHaveBeenCalledOnce();
});
it("stops observing a closed confirmation without submitting again", async () => {
  const draft = { id: "same", expiresAt: new Date(Date.now() + 60000).toISOString(), status: "draft" };
  client.prepare.mockResolvedValue(draft); client.submit.mockResolvedValue({ ...draft, status: "pending" });
  let closed = false;
  const result = approveWorkspaceAccess({ workspaceManifest: {} }, () => { closed = true; }, { cancelled: () => closed });
  await expect(result).rejects.toMatchObject({ name: "AbortError" }); expect(client.status).not.toHaveBeenCalled();
});
it("does not submit after cancellation while preparation is in flight", async () => {
  let closed = false;
  client.prepare.mockImplementation(async () => { closed = true; return { id: "same", status: "draft", expiresAt: new Date(Date.now()+60000).toISOString() }; });
  await expect(approveWorkspaceAccess({ workspaceManifest: {} }, vi.fn(), { cancelled: () => closed })).rejects.toMatchObject({ name: "AbortError" });
  expect(client.submit).not.toHaveBeenCalled();
});
it("expires a retained confirmation instead of polling indefinitely", async () => {
  await expect(approveWorkspaceAccess({ workspaceManifest: {} }, vi.fn(), { retained: { id: "old", expiresAt: new Date(Date.now()-1000).toISOString() } })).rejects.toThrow("expired");
  expect(client.status).not.toHaveBeenCalled(); expect(client.prepare).not.toHaveBeenCalled();
});
