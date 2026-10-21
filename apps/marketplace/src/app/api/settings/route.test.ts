import { describe, expect, it } from "vitest";
import { GET, PUT } from "./route";
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
