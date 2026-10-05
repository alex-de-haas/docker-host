import { afterEach, expect, it, vi } from "vitest";
import { TokenExchange } from "../src/mcp/exchange.js";

afterEach(() => vi.unstubAllGlobals());
it("loads only a Core-mediated catalog without requesting a conversation token", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ tools: [{ name: "read_items" }] }));
  vi.stubGlobal("fetch", fetch);
  const exchange = new TokenExchange("https://core.test", "assistant", "service");
  expect(await exchange.catalog("hostyg_admin", "example.target")).toEqual([{ name: "read_items" }]);
  expect(fetch).toHaveBeenCalledExactlyOnceWith("https://core.test/api/internal/apps/assistant/mcp/catalog/example.target", expect.objectContaining({
    method: "POST", redirect: "error", headers: { authorization: "Bearer service", "X-Hosty-User-Token": "hostyg_admin" },
  }));
});
it("does not fall back to a tool token when catalog access is denied", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
  vi.stubGlobal("fetch", fetch);
  await expect(new TokenExchange("https://core.test", "assistant", "service").catalog("hostyg_admin", "target")).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});
