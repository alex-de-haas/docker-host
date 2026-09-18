import { afterEach, describe, expect, it, vi } from "vitest";
import { createInstallationRouteHandler } from "./install-server";
const handle = createInstallationRouteHandler({ appIdFallback: "example.market", identityCookieName: "market_identity" });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("installation server adapter", () => {
  it("refuses a cross-origin mutation before spending any service token", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const response = await handle(new Request("https://market.example/api/hosty/installations", {
      method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json", cookie: "market_identity=identity" }, body: "{}",
    }));
    expect(response.status).toBe(403); expect(fetch).not.toHaveBeenCalled();
  });
  it("sends separate app and user credentials only to Core, without copying browser cookies", async () => {
    vi.stubEnv("HOSTY_APP_ID", "example.market"); vi.stubEnv("HOSTY_CORE_ORIGIN", "http://core.internal:7070"); vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service-secret");
    const fetch = vi.fn(async () => Response.json({ id: "request" })); vi.stubGlobal("fetch", fetch);
    const response = await handle(new Request("https://market.example/api/hosty/installations", {
      method: "POST", headers: { origin: "https://market.example", "content-type": "application/json", cookie: "market_identity=identity; hosty_session=must-not-forward" }, body: "{}",
    }));
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledWith(new URL("http://core.internal:7070/api/internal/apps/example.market/installations"), expect.objectContaining({
      headers: { "Content-Type": "application/json", Authorization: "Bearer service-secret", "X-Hosty-App-Identity": "identity" }, redirect: "error",
    }));
    expect(await response.text()).not.toContain("service-secret");
  });
  it("does not offer a proxy route to approve requests", async () => {
    const response = await handle(new Request("https://market.example/api/hosty/installations/" + "a".repeat(48) + "/approve", { method: "POST" }));
    expect(response.status).toBe(404);
  });
  it("uses the configured public origin when Next exposes an internal URL", async () => {
    vi.stubEnv("HOSTY_CORE_ORIGIN", "http://core.internal:7070"); vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service-secret");
    const fetch = vi.fn(async () => Response.json({ id: "request" })); vi.stubGlobal("fetch", fetch);
    const publicHandler = createInstallationRouteHandler({ appIdFallback: "market", identityCookieName: "identity" }, { publicOrigin: "http://marketplace.hosty.localhost:26495" });
    const response = await publicHandler(new Request("http://localhost:26495/api/hosty/installations", {
      method: "POST", headers: { origin: "http://marketplace.hosty.localhost:26495", "content-type": "application/json", cookie: "identity=token" }, body: "{}",
    }));
    expect(response.status).toBe(200); expect(fetch).toHaveBeenCalledOnce();
    fetch.mockClear();
    for (const origin of ["http://localhost:26495", "https://evil.example"]) {
      const denied = await publicHandler(new Request("http://localhost:26495/api/hosty/installations", {
        method: "POST", headers: { origin, "x-forwarded-host": new URL(origin).host, "content-type": "application/json", cookie: "identity=token" }, body: "{}",
      }));
      expect(denied.status).toBe(403);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
