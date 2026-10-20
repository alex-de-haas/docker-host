import { afterEach, expect, it, vi } from "vitest";
import { isWorkspaceAccessReviewRoute, requestWorkspaceAccessReview } from "./workspace-access-reviews.js";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("exposes only prepare, submit and status routes for workspace access", () => {
  const id = "a".repeat(48);
  expect(isWorkspaceAccessReviewRoute("POST", "/api/workspace-access-reviews")).toBe(true);
  expect(isWorkspaceAccessReviewRoute("POST", `/api/workspace-access-reviews/${id}/submit`)).toBe(true);
  expect(isWorkspaceAccessReviewRoute("GET", `/api/workspace-access-reviews/${id}`)).toBe(true);
  expect(isWorkspaceAccessReviewRoute("POST", `/api/workspace-access-reviews/${id}/approve`)).toBe(false);
  expect(isWorkspaceAccessReviewRoute("POST", "/api/installations")).toBe(false);
});
it("refuses generic installation sources and requires the signed-in app identity", async () => {
  expect((await requestWorkspaceAccessReview("POST", "/api/workspace-access-reviews", null, { workspaceManifest: {} })).status).toBe(401);
  expect((await requestWorkspaceAccessReview("POST", "/api/workspace-access-reviews", "identity", { manifestPath: "/secret" })).status).toBe(400);
  expect((await requestWorkspaceAccessReview("POST", "/api/workspace-access-reviews", "identity", { workspaceManifest: {}, removeAppId: "other" })).status).toBe(400);
});
it("preserves Core's exact candidate review and forwards actor identity server-side", async () => {
  vi.stubEnv("HOSTY_CORE_ORIGIN", "http://core.test"); vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service"); vi.stubEnv("HOSTY_APP_ID", "hosty.harness");
  const read = vi.fn().mockResolvedValue(Response.json({ id: "request", status: "draft" })); vi.stubGlobal("fetch", read);
  const review = { workspaceManifest: { appId: "notes", planDigest: "exact-candidate", additionalAccess: ["Host write access"] } };
  expect((await requestWorkspaceAccessReview("POST", "/api/workspace-access-reviews", "identity", review)).status).toBe(200);
  expect(read).toHaveBeenCalledWith(new URL("http://core.test/api/internal/apps/hosty.harness/installations"), expect.objectContaining({
    method: "POST", headers: expect.objectContaining({ authorization: "Bearer service", "X-Hosty-App-Identity": "identity" }), body: JSON.stringify(review),
  }));
});
