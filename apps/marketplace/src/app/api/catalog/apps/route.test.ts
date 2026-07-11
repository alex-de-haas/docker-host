import { describe, expect, it } from "vitest";
import { GET as getApps } from "@/app/api/catalog/apps/route";
import { GET as getApp } from "@/app/api/catalog/apps/[id]/route";

describe("Marketplace catalog routes", () => {
  it("does not expose the configured catalog without an app-origin session", async () => {
    const response = await getApps(new Request("http://marketplace.local/api/catalog/apps"));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ code: "app_identity_required" });
  });

  it("protects app detail before resolving route data", async () => {
    const response = await getApp(
      new Request("http://marketplace.local/api/catalog/apps/com.example.notes"),
      { params: Promise.resolve({ id: "com.example.notes" }) },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "app_identity_required" });
  });
});
