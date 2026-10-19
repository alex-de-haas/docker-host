import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRevalidationCache } from "@hosty-sdk/app/server";
import { GET } from "./route";
const request = (path: string, signedIn = true) => new Request(`https://workspaces.test/api/workspaces/${path}`, {
  headers: signedIn ? { cookie: "hosty_workspaces_identity=identity" } : {} });
const context = (path: string) => ({ params: Promise.resolve({ path: path.split("/") }) });
beforeEach(() => {
  clearRevalidationCache();
  vi.stubEnv("HOSTY_APP_ID", "hosty.workspaces"); vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service"); vi.stubEnv("HOSTY_CORE_ORIGIN", "https://core.test");
  vi.stubGlobal("fetch", vi.fn(async (url: URL | string) => String(url).endsWith("/events")
    ? new Response("event: stream.ready\ndata: {}\n\n", { headers: { "Content-Type": "text/event-stream" } })
    : Response.json({ active: true, appId: "hosty.workspaces", userId: "admin", hostRole: "host.admin" })));
});
afterEach(() => { clearRevalidationCache(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("proxies only the scoped event stream with app credentials and browser cancellation", async () => {
  const input = request("events"); const response = await GET(input, context("events"));
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.text()).toContain("event: stream.ready");
  const [url, options] = vi.mocked(fetch).mock.calls.at(-1)!;
  expect(String(url)).toBe("https://core.test/api/internal/apps/hosty.workspaces/workspace-inspection/events");
  expect(options?.signal).toBe(input.signal);
  const headers = new Headers(options?.headers);
  expect(headers.get("X-Hosty-User-Token")).toBe("identity"); expect(headers.get("Authorization")).toBe("Bearer service"); expect(headers.has("cookie")).toBe(false);
});
it("rejects missing identity and routes outside the inspection surface", async () => {
  expect((await GET(request("events", false), context("events"))).status).toBe(401);
  expect(fetch).not.toHaveBeenCalled();
  expect((await GET(request("events/arbitrary"), context("events/arbitrary"))).status).toBe(404);
  expect(vi.mocked(fetch).mock.calls.every(([url]) => !String(url).includes("workspace-inspection"))).toBe(true);
});

it.each([404, 405, 403, 200])("cancels rejected upstream inspection bodies (%s)", async (status) => {
  const cancel = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: URL | string) => String(url).endsWith("/events")
    ? new Response(new ReadableStream({ cancel }), { status, headers: { "Content-Type": "text/plain" } })
    : Response.json({ active: true, appId: "hosty.workspaces", userId: "admin", hostRole: "host.admin" })));
  expect((await GET(request("events"), context("events"))).status).toBe(status === 200 ? 502 : status);
  expect(cancel).toHaveBeenCalledTimes(1);
});
