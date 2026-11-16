import { it,expect,vi,afterEach } from "vitest";
import { UsageSubscriptions } from "./usage-subscriptions.js";
import { codexUsage } from "../harness/provider-usage.js";
const sample=()=>codexUsage({rateLimits:{primary:{usedPercent:25}}});
afterEach(()=>vi.useRealTimers());
it("shares snapshot sampling and stops work at the last unsubscribe without refreshing a provider", async () => {
  vi.useFakeTimers();
  const usage = vi.fn(async () => sample());
  const subscriptions = new UsageSubscriptions({ usage });
  const one = vi.fn(), two = vi.fn();
  const stopOne = subscriptions.subscribe("id", one), stopTwo = subscriptions.subscribe("id", two);
  await vi.advanceTimersByTimeAsync(10);
  expect(usage).toHaveBeenCalledTimes(1); expect(one).toHaveBeenCalledOnce(); expect(two).toHaveBeenCalledOnce();
  expect(usage).toHaveBeenLastCalledWith("id", false);
  stopOne(); stopTwo(); await vi.advanceTimersByTimeAsync(3000);
  expect(usage).toHaveBeenCalledTimes(1); subscriptions.close();
});
it("keeps the same account's metadata reads and cached values separate across authorities", async () => {
  vi.useFakeTimers();
  const fallback = vi.fn(async () => sample()), subscriptions = new UsageSubscriptions({ usage: fallback });
  const one = vi.fn(), two = vi.fn(), readOne = vi.fn(async () => ({ ...sample(), reason: "local" as const })),
    readTwo = vi.fn(async () => ({ ...sample(), reason: "unsupported_auth" as const }));
  const stopOne = subscriptions.subscribe("shared-account", one, "authority-one", readOne),
    stopTwo = subscriptions.subscribe("shared-account", two, "authority-two", readTwo);
  await vi.advanceTimersByTimeAsync(10);
  expect(one.mock.lastCall?.[0].reason).toBe("local"); expect(two.mock.lastCall?.[0].reason).toBe("unsupported_auth");
  expect(readOne).toHaveBeenCalledOnce(); expect(readTwo).toHaveBeenCalledOnce(); expect(fallback).not.toHaveBeenCalled();
  stopOne(); await vi.advanceTimersByTimeAsync(2100);
  expect(readOne).toHaveBeenCalledOnce(); expect(readTwo).toHaveBeenCalledTimes(2);
  stopTwo(); subscriptions.close();
});
