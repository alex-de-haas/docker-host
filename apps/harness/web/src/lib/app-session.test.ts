import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let values: Map<string, string>;
let browser: EventTarget & { location: URL; self: object; top: object; sessionStorage: Storage; localStorage: Storage };

beforeEach(() => {
  vi.resetModules();
  values = new Map();
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
  } as unknown as Storage;
  browser = Object.assign(new EventTarget(), {
    location: new URL("http://harness.localhost/settings"), self: {}, top: {},
    sessionStorage: storage,
    localStorage: { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn() } as unknown as Storage,
  });
  vi.stubGlobal("window", browser);
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Harness app-owned browser session", () => {
  it("restores the embedded grant after frame recreation for protected settings requests", async () => {
    let auth = await import("@hosty-sdk/app/browser-auth");
    auth.rememberAppGrant("hostyg_harness");
    expect(values.get(auth.APP_GRANT_STORAGE_KEY)).toBe("hostyg_harness");
    vi.resetModules();
    auth = await import("@hosty-sdk/app/browser-auth");
    expect(auth.restoreAppGrant()).toBe(true);
    const fetcher = vi.fn().mockResolvedValue(Response.json({ settings: {} }));
    vi.stubGlobal("fetch", fetcher);
    const { loadSettings } = await import("./api");
    await loadSettings();
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/settings");
    expect(fetcher.mock.calls[0]?.[1].headers.get("authorization")).toBe("Bearer hostyg_harness");
    expect(fetcher.mock.calls[0]?.[1].redirect).toBe("error");
    expect(browser.localStorage.setItem).not.toHaveBeenCalled();
  });

  it("uses the standalone grant in memory without persisting it", async () => {
    browser.top = browser.self;
    const auth = await import("@hosty-sdk/app/browser-auth");
    auth.rememberAppGrant("hostyg_harness");
    expect(browser.sessionStorage.setItem).not.toHaveBeenCalled();
    expect(browser.localStorage.setItem).not.toHaveBeenCalled();
  });

  it.each([
    [401, "token_invalid"], [401, "token_revoked"], [401, "token_expired"], [403, "token_app_mismatch"],
  ])("forgets the stored grant after %i %s", async (status, code) => {
    const auth = await import("@hosty-sdk/app/browser-auth");
    auth.rememberAppGrant("hostyg_harness");
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ code }, { status }))
      .mockResolvedValue(Response.json({ settings: {} }));
    vi.stubGlobal("fetch", fetcher);
    const { loadSettings } = await import("./api");
    await expect(loadSettings()).rejects.toThrow();
    expect(values.has(auth.APP_GRANT_STORAGE_KEY)).toBe(false);
    await loadSettings();
    expect(fetcher.mock.calls[1]?.[1].headers.has("authorization")).toBe(false);
  });

  it("keeps the stored identity when only privileged activity expires", async () => {
    const auth = await import("@hosty-sdk/app/browser-auth");
    auth.rememberAppGrant("hostyg_harness");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code: "reauth_required" }, { status: 401 })));
    const { call } = await import("./api");
    await expect(call("/settings")).rejects.toThrow();
    expect(values.get(auth.APP_GRANT_STORAGE_KEY)).toBe("hostyg_harness");
    auth.forgetAppGrant();
    expect(values.has(auth.APP_GRANT_STORAGE_KEY)).toBe(false);
  });
});
