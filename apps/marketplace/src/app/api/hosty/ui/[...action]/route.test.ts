import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRevalidationCache } from "@hosty-sdk/app/server";
import { GET, POST } from "./route";

const appId = "hosty.marketplace";
const origin = "https://app.test";
function request(action: string, method = "GET", signedIn = true) {
  return new Request(`${origin}/api/hosty/ui/${action}`, {
    method,
    headers: { ...(signedIn ? { cookie: "hosty_marketplace_identity=identity-token" } : {}), origin, "content-type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify({ appId, installationId: "installation", entryKey: "home" }) } : {}),
  });
}
let role: string;
beforeEach(() => {
  clearRevalidationCache();
  role = "host.admin";
  vi.stubEnv("HOSTY_APP_ID", appId);
  vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service-token");
  vi.stubEnv("HOSTY_CORE_ORIGIN", "https://core.test");
  vi.stubGlobal("fetch", vi.fn(async (input: URL | string) => {
    const path = new URL(input).pathname;
    if (!path.includes("/ui/")) return Response.json({ active: true, appId, userId: "user", hostRole: role });
    return Response.json(path.endsWith("/panels") ? { panels: [] } : { operation: path.split("/ui/")[1] });
  }));
});
afterEach(() => { clearRevalidationCache(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each(["bootstrap?parentOrigin=https%3A%2F%2Fshell.test", "navigation", "panels"])("serves authenticated SDK %s metadata through the app route", async action => {
  const response = await GET(request(action));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(action === "panels" ? { panels: [] } : { operation: action.split("?")[0] });
  const [url, init] = vi.mocked(fetch).mock.calls.at(-1)!;
  expect(String(url)).toBe(`https://core.test/api/internal/apps/${appId}/ui/${action}`);
  expect(new Headers(init?.headers).get("X-Hosty-User-Token")).toBe("identity-token");
  expect(response.headers.get("cache-control")).toBe("no-store");
});
it("exposes authenticated navigation resolution and rejects cross-origin requests", async () => {
  expect((await POST(request("navigation/resolve", "POST"))).status).toBe(200);
  const denied = request("navigation/resolve", "POST");
  denied.headers.set("origin", "https://other.test");
  expect((await POST(denied)).status).toBe(403);
});
it("requires a signed-in administrator before requesting UI metadata", async () => {
  expect((await GET(request("bootstrap", "GET", false))).status).toBe(401);
  expect(fetch).not.toHaveBeenCalled();
  role = "host.user";
  const response = await GET(request("navigation"));
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "admin_required" });
  expect(vi.mocked(fetch).mock.calls.every(([url]) => !String(url).includes("/ui/"))).toBe(true);
});
