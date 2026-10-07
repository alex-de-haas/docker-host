import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@hosty-sdk/app/server", () => ({
  getAppId: () => "hosty.plans", getCoreOrigin: () => "http://core.example",
  getRecoveryParams: vi.fn(), readAppIdentityToken: vi.fn(), resolveAppSession: vi.fn(),
}));
import { CoreSourceReader } from "./core-client";
import type { DocumentListing } from "./types";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function useRequestClock() {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), milliseconds);
    return controller.signal;
  });
  vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service-test-token");
}

function delayedListing(milliseconds: number) {
  const listing: DocumentListing = { repositoryId: "repo", version: "target", workspaceId: null, commit: "commit", documents: [], state: "available", error: null };
  const fetch = vi.fn((_url: unknown, options?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = options?.signal;
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve(Response.json(listing));
    }, milliseconds);
    function abort() { clearTimeout(timer); reject(signal?.reason); }
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  }));
  vi.stubGlobal("fetch", fetch);
  return { fetch, listing };
}
describe("Core focused document contract", () => {
  it("sends the focused path and version as query values with both current credentials", async () => {
    const listing: DocumentListing = { repositoryId: "canonical", version: "base", workspaceId: "workspace", commit: "base-commit", documents: [], state: "available", error: null };
    const fetch = vi.fn(async () => Response.json(listing));
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service-test-token");
    const reader = new CoreSourceReader("acting-admin-test-token");
    const documentPath = "docs/features/title & summary/plan.md";
    await reader.listing("repo/branch", "base", "workspace", true, documentPath);
    const [url, options] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/api/internal/apps/hosty.plans/source-documents/repositories/repo%2Fbranch/documents");
    expect(Object.fromEntries(url.searchParams)).toEqual({ version: "base", workspaceId: "workspace", refresh: "true", path: documentPath });
    expect(options).toMatchObject({ headers: { Authorization: "Bearer service-test-token", "X-Hosty-User-Token": "acting-admin-test-token" }, cache: "no-store", redirect: "error" });
    await reader.content("canonical", documentPath, listing, "listed-sha");
    const [contentUrl] = fetch.mock.calls[1] as unknown as [URL, RequestInit];
    expect(Object.fromEntries(contentUrl.searchParams)).toEqual({ version: "base", workspaceId: "workspace", commit: "base-commit", expectedSha: "listed-sha", path: documentPath });
  });
});

describe("Core source request deadlines", () => {
  it.each([{ duration: 40_000, withCaller: false }, { duration: 65_000, withCaller: true }])("allows a $duration ms source read with caller signal $withCaller", async ({ duration, withCaller }) => {
    useRequestClock();
    const { listing } = delayedListing(duration);
    const caller = new AbortController();
    const reader = new CoreSourceReader("acting-admin-test-token", withCaller ? caller.signal : undefined);
    const result = reader.listing("repo").then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(duration);
    expect(await result).toEqual({ value: listing });
    expect(caller.signal.aborted).toBe(false);
  });

  it.each([false, true])("bounds a stalled source read at 75 seconds with caller signal %s", async withCaller => {
    useRequestClock();
    const { fetch } = delayedListing(120_000);
    const caller = new AbortController();
    const reader = new CoreSourceReader("acting-admin-test-token", withCaller ? caller.signal : undefined);
    const result = reader.listing("repo").then(value => ({ value }), error => ({ error }));
    const signal = fetch.mock.calls[0][1]?.signal;
    await vi.advanceTimersByTimeAsync(74_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toMatchObject({ name: "TimeoutError" });
    expect(await result).toMatchObject({ error: { status: 503, code: "plans_unavailable" } });
    expect(caller.signal.aborted).toBe(false);
  });

  it("cancels a source read immediately when the caller aborts before the deadline", async () => {
    useRequestClock();
    const { fetch } = delayedListing(40_000);
    const caller = new AbortController();
    const reader = new CoreSourceReader("acting-admin-test-token", caller.signal);
    const result = reader.listing("repo").then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(1_000);
    const reason = new DOMException("Caller disconnected", "AbortError");
    caller.abort(reason);
    expect(await result).toMatchObject({ error: { status: 503, code: "plans_unavailable" } });
    expect(fetch.mock.calls[0][1]?.signal?.reason).toBe(reason);
  });
});
