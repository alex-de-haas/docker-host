import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRevalidationCache } from "@hosty-sdk/app/server";
import { GET, POST } from "./route";
const origin = "https://workspaces.test";
const id = "a".repeat(32);
let role: string;
function request(path = "", body?: object, signedIn = true) {
  return new Request(`${origin}/api/environments/${path}`, { method: body ? "POST" : "GET", headers: { origin, "content-type": "application/json", ...(signedIn ? { cookie: "hosty_workspaces_identity=identity" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
function context(path = "") { return { params: Promise.resolve({ path: path ? path.split("/") : [] }) }; }
beforeEach(() => {
  clearRevalidationCache(); role = "host.admin";
  vi.stubEnv("HOSTY_APP_ID", "hosty.workspaces"); vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service"); vi.stubEnv("HOSTY_CORE_ORIGIN", "https://core.test");
  vi.stubGlobal("fetch", vi.fn(async (url: URL | string) => String(url).includes("/core-environments") ? Response.json({ environments: [] }) : Response.json({ active: true, appId: "hosty.workspaces", userId: "admin", hostRole: role })));
});
afterEach(() => { clearRevalidationCache(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("forwards the current app identity and service grant without forwarding browser cookies", async () => {
  const response = await GET(request(), context()); expect(response.status).toBe(200);
  const [url, options] = vi.mocked(fetch).mock.calls.at(-1)!;
  expect(String(url)).toBe("https://core.test/api/core-environments");
  const headers = new Headers(options?.headers);
  expect(headers.get("X-Hosty-App-Identity")).toBe("identity"); expect(headers.get("Authorization")).toBe("Bearer service"); expect(headers.get("cookie")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
});
it("rejects missing identity, non-administrators and cross-origin mutation", async () => {
  expect((await GET(request("", undefined, false), context())).status).toBe(401); expect(fetch).not.toHaveBeenCalled();
  role = "host.member";
  expect((await GET(request(), context())).status).toBe(403);
  expect(vi.mocked(fetch).mock.calls.every(([url]) => !String(url).includes("/core-environments"))).toBe(true);
  const foreign = request(`${id}/operations/finish`, {}); foreign.headers.set("origin", "https://foreign.test");
  expect((await POST(foreign, context(`${id}/operations/finish`))).status).toBe(403);
});
it("allows only the bounded UI routes and keeps lifecycle request IDs intact", async () => {
  for (const path of [`${id}/api`, `${id}/operations/arbitrary`, "", "../../apps"]) expect((await POST(request(path, {}), context(path))).status).toBe(404);
  expect(fetch).not.toHaveBeenCalled();
  const body = { requestId: "persistent-id", expectedRevision: 4 };
  expect((await POST(request(`${id}/operations/finish`, body), context(`${id}/operations/finish`))).status).toBe(200);
  expect(JSON.parse(vi.mocked(fetch).mock.calls.at(-1)![1]!.body as string)).toEqual(body);
});
