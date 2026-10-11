import { afterEach, expect, it, vi } from "vitest";
import { BackgroundGrantClient } from "./background-server";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("coalesces short credential issuance, remints before expiry and never retries a mutation", async () => {
  vi.useFakeTimers(); const mint = () => Response.json({ accessToken: "opaque", expiresAt: new Date(Date.now() + 300_000).toISOString() });
  const fetcher = vi.fn().mockImplementation(mint); vi.stubGlobal("fetch", fetcher);
  const client = new BackgroundGrantClient("explicit-grant", "health", { appId: "app", serviceToken: "service", coreOrigin: "http://core.test" });
  expect(await Promise.all([client.token(), client.token()])).toEqual(["opaque", "opaque"]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(275_000); await client.token(); expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockRejectedValueOnce(new Error("connection lost after dispatch"));
  await expect(client.core("/api/apps/selected/start", { method: "POST" })).rejects.toThrow("connection lost");
  expect(fetcher).toHaveBeenCalledTimes(3);
  await expect(client.core("http://other.test/api/apps/selected/start")).rejects.toThrow("Core app operation");
});
