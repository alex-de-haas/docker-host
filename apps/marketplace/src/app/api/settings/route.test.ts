import { describe, expect, it, vi } from "vitest";
import { GET, PUT } from "./route";
import * as authorization from "@/lib/route-auth";
import * as settings from "@/lib/runtime";
describe("Marketplace settings authorization", () => {
  it("requires an app session before reading or writing", async () => {
    expect((await GET(new Request("http://marketplace.local/api/settings"))).status).toBe(401);
    expect((await PUT(new Request("http://marketplace.local/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" }))).status).toBe(401);
  });
  it("rejects cross-site and simple form writes", async () => {
    for (const headers of [{ "content-type": "text/plain" }, { "content-type": "application/json", "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
      expect((await PUT(new Request("http://marketplace.local/api/settings", { method: "PUT", headers, body: "{}" }))).status).toBe(403);
    }
  });
});


it("returns a distinct conflict after normal authorization while leaving validation errors separate", async () => {
  const authorize = vi.spyOn(authorization, "authorizeMarketplaceRequest").mockResolvedValue({ ok: true, identity: {
    status: "active", tokenPresent: true, appId: "sample-marketplace", userId: "test-admin", email: null,
    displayName: null, hostRole: "host.admin", expiresAt: null, error: null,
  } });
  const update = vi.spyOn(settings, "updateMarketplaceSettings");
  const request = () => new Request("http://marketplace.local/api/settings", { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceUrl: "https://draft.example/catalog.json", expectedSourceUrl: "https://old.example/catalog.json" }) });
  try {
    update.mockImplementationOnce(() => { throw new settings.MarketplaceSettingsConflictError(); });
    const conflict = await PUT(request());
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "settings_conflict", message: expect.stringContaining("Reload") });
    update.mockImplementationOnce(() => { throw new Error("Enter an HTTP(S) catalog address without credentials."); });
    const invalid = await PUT(request());
    expect(invalid.status).toBe(400); expect(await invalid.json()).not.toHaveProperty("code", "settings_conflict");
    expect(authorize).toHaveBeenCalledTimes(2);
  } finally { update.mockRestore(); authorize.mockRestore(); }
});
