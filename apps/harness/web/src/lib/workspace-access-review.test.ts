import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { approveWorkspaceAccess, type WorkspaceAccessReview } from "./workspace-access-review";
import { requestWorkspaceAccessReview } from "../../../src/workspace-access-reviews.js";
const client = vi.hoisted(() => ({ prepare: vi.fn(), submit: vi.fn(), status: vi.fn() }));
vi.mock("@hosty-sdk/app/install", () => ({ createInstallationClient: () => client }));
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
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
