import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { exchangeAppCode } from "./app-code-exchange";

const proof = { code: "one-use-code", codeVerifier: "v".repeat(43) };
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { location: new URL("http://app.localhost/draft"), setTimeout, clearTimeout });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("submits one proof only to the app origin and retires its deadline after completion", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ accessToken: "new-app-grant" })); vi.stubGlobal("fetch", fetcher);
  expect(await exchangeAppCode("/api/auth/app-code", proof)).toEqual({ ok: true, body: { accessToken: "new-app-grant" } });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0]).toEqual(["http://app.localhost/api/auth/app-code", expect.objectContaining({ method: "POST", body: JSON.stringify(proof),
    credentials: "same-origin", redirect: "error", signal: expect.any(AbortSignal) })]);
  await vi.advanceTimersByTimeAsync(5000);
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(false);
  await expect(exchangeAppCode("http://foreign.localhost/api/auth/app-code", proof)).rejects.toThrow("this app's origin");
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each(["response", "body"])("bounds a stalled %s and ignores its late completion without resubmission", async stage => {
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const fetcher = vi.fn().mockImplementation(() => stage === "response" ? pending
    : Promise.resolve({ ok: true, json: () => pending })); vi.stubGlobal("fetch", fetcher);
  const operation = exchangeAppCode("/api/auth/app-code", proof);
  const refused = expect(operation).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(4000);
  await refused;
  expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  finish(stage === "response" ? Response.json({ accessToken: "late-grant" }) : { accessToken: "late-grant" });
  await Promise.resolve(); await Promise.resolve();
  expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])("cancels a sign-in exchange without waiting for the deadline (before dispatch: %s)", async before => {
  const controller = new AbortController();
  const fetcher = vi.fn((_input: RequestInfo | URL, _init: RequestInit) => new Promise<Response>(() => {})); vi.stubGlobal("fetch", fetcher);
  if (before) controller.abort();
  const operation = exchangeAppCode("/api/auth/app-code", proof, controller.signal);
  const refused = expect(operation).rejects.toThrow("cancelled");
  controller.abort(); await refused;
  expect(fetcher).toHaveBeenCalledTimes(before ? 0 : 1);
  if (!before) expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("dispatches the validated app URL even when an HTML base changes relative fetch resolution", async () => {
  const base = "https://foreign.example/assets/";
  const destinations: URL[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    destinations.push(new URL(String(input), base));
    return Response.json({ accessToken: "same-app-grant" });
  });
  vi.stubGlobal("fetch", fetcher);
  await exchangeAppCode("api/auth/app-code", proof);
  expect(destinations.map(url => url.href)).toEqual(["http://app.localhost/api/auth/app-code"]);
  expect(fetcher).toHaveBeenCalledOnce();
});
