import { afterEach, expect, it, vi } from "vitest";
import { pullRequestsRoute, requestPullRequests, pullRequestEvents } from "./pull-requests-proxy.js";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("permits only bounded reads and explicitly supported PR commands", () => {
  const path = `/api/pull-requests/${"a".repeat(64)}/42`;
  expect(pullRequestsRoute("GET", path + "/diff")).toBe(true);
  expect(pullRequestsRoute("GET", path + "/actions")).toBe(true);
  expect(pullRequestsRoute("POST", path + "/actions")).toBe(true);
  expect(pullRequestsRoute("POST", path + "/actions/recover")).toBe(true);
  expect(pullRequestsRoute("GET", path + "/actions/recover")).toBe(false);
  expect(pullRequestsRoute("POST", path + "/diff")).toBe(false);
  for (const suffix of ["/merge", "/reviews", "/comments"]) expect(pullRequestsRoute("POST", path + suffix)).toBe(false);
  expect(pullRequestsRoute("GET", "/api/pull-requests/https://other.test/42")).toBe(false);
});
it("keeps credentials in the actor-bound Core request and refuses arbitrary paths", async () => {
  vi.stubEnv("HOSTY_CORE_ORIGIN", "https://core.test"); vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service");
  const fetch = vi.fn(async () => Response.json({ items: [] })); vi.stubGlobal("fetch", fetch);
  await requestPullRequests("GET", "/api/pull-requests?bot=true", "hostyg_actor");
  expect(fetch).toHaveBeenCalledWith(new URL("https://core.test/api/pull-requests?bot=true"), expect.objectContaining({ redirect: "error", headers: expect.objectContaining({ authorization: "Bearer service", "X-Hosty-App-Identity": "hostyg_actor" }) }));
  await expect(requestPullRequests("GET", "https://other.test/api/pull-requests", "hostyg_actor")).rejects.toMatchObject({ code: "pr_route_invalid" });
  await expect(requestPullRequests("GET", "/api/pull-requests?userId=another", "hostyg_actor")).rejects.toMatchObject({ code: "pr_query_invalid" });
  await expect(pullRequestEvents("hostyg_actor", "../../secret", new AbortController().signal)).rejects.toMatchObject({ code: "pr_subscription_invalid" });
  expect(fetch).toHaveBeenCalledTimes(1);
});
