import { afterEach, expect, it, vi } from "vitest";
import { createHostyUiResponse } from "./ui-server.js";
import { FeedbackServerClient } from "./feedback-server.js";
const context = { session: { status: "active" as const, identity: { hostRole: "host.user" } }, token: "own-user-grant" };
const options = { appId: "third.party", coreOrigin: "https://core.test", serviceToken: "app-service" };
afterEach(() => vi.unstubAllGlobals());
it("submits from an ordinary app session only to its fixed intake endpoint", async () => {
  const fetcher = vi.fn(async () => Response.json({ id: "report", status: "submitted" })); vi.stubGlobal("fetch", fetcher);
  const body = JSON.stringify({ requestId: "id", comment: "Fix", annotations: [] });
  const request = (origin: string) => new Request("https://app.test/api/hosty/ui/feedback", { method: "POST", headers: { origin, "content-type": "application/json" }, body });
  expect((await createHostyUiResponse(request("https://foreign.test"), context, options)).status).toBe(403); expect(fetcher).not.toHaveBeenCalled();
  const result = await createHostyUiResponse(request("https://app.test"), context, options); expect(result.status).toBe(200);
  expect(fetcher).toHaveBeenCalledWith(new URL("https://core.test/api/internal/apps/third.party/ui/feedback"), expect.objectContaining({
    redirect: "error", headers: expect.objectContaining({ authorization: "Bearer app-service", "X-Hosty-User-Token": "own-user-grant" }), body,
  }));
});
it("does not offer management routes on the ordinary UI adapter and retains typed Core refusals", async () => {
  const fetcher = vi.fn(async () => Response.json({ code: "feedback_identity_changed", message: "Account changed" }, { status: 403 })); vi.stubGlobal("fetch", fetcher);
  expect((await createHostyUiResponse(new Request("https://app.test/api/hosty/ui/feedback/reports"), context, options)).status).toBe(404);
  expect(fetcher).not.toHaveBeenCalled();
  await expect(new FeedbackServerClient(options).list("grant")).rejects.toMatchObject({ code: "feedback_identity_changed", status: 403 });
});
it("refuses oversized intake before contacting Core", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const response = await createHostyUiResponse(new Request("https://app.test/api/hosty/ui/feedback", { method: "POST", headers: { origin: "https://app.test", "content-type": "application/json" }, body: "x".repeat(12 * 1024 * 1024 + 1) }), context, options);
  expect(response.status).toBe(413); expect(fetcher).not.toHaveBeenCalled();
});
