import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCatalogApps, MarketplaceApiError } from "./marketplace-api";

afterEach(() => vi.unstubAllGlobals());

describe("catalog request failures", () => {
  it.each([401, 403])("retains HTTP %s so session failures can hide the catalog", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code: "app_identity_required", message: "Sign in through Hosty." }, { status })));
    const failure = await fetchCatalogApps(false).catch(error => error);
    expect(failure).toBeInstanceOf(MarketplaceApiError);
    expect(failure).toMatchObject({ status, code: "app_identity_required", message: "Sign in through Hosty." });
  });

  it("reports a non-JSON server error instead of inventing an empty or unconfigured catalog", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Bad gateway", { status: 502 })));
    await expect(fetchCatalogApps(true)).rejects.toMatchObject({ status: 502, message: "Marketplace request returned HTTP 502." });
  });

  it("preserves network failure and cancellation for the caller", async () => {
    const offline = new TypeError("Failed to fetch");
    const fetch = vi.fn().mockRejectedValue(offline);
    vi.stubGlobal("fetch", fetch);
    await expect(fetchCatalogApps(false)).rejects.toBe(offline);
    const controller = new AbortController();
    controller.abort();
    const aborted = new DOMException("Aborted", "AbortError");
    fetch.mockRejectedValue(aborted);
    await expect(fetchCatalogApps(false, controller.signal)).rejects.toBe(aborted);
    expect(fetch.mock.lastCall?.[1].signal).toBe(controller.signal);
  });

  it("returns a real empty catalog distinctly from a source diagnostic", async () => {
    const source = { name: "Official", url: "https://example.test/catalog", description: null };
    for (const status of ["ready", "not-configured"]) {
      const catalog = { apps: [], source, diagnostic: { status, code: status, message: status } };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(catalog)));
      await expect(fetchCatalogApps(false)).resolves.toEqual(catalog);
    }
  });
});
