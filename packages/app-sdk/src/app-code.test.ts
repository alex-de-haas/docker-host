import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAppAuthProtocol, isValidCodeVerifier } from "./app-code";

let serial = 0;
const origin = () => `http://protocol-${serial++}.test`;
afterEach(() => vi.unstubAllGlobals());

describe("Core app authorization protocol discovery", () => {
  it("reads version 2 without credentials, caching or redirects", async () => {
    const core = origin();
    const fetcher = vi.fn().mockResolvedValue(Response.json({ version: 2 })); vi.stubGlobal("fetch", fetcher);
    expect(await resolveAppAuthProtocol(core)).toBe(2);
    expect(String(fetcher.mock.calls[0][0])).toBe(`${core}/api/auth/apps/protocol`);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: "no-store", redirect: "error", headers: { accept: "application/json" } });
    expect(fetcher.mock.calls[0][1].headers).not.toHaveProperty("authorization");
  });
  it("permits old navigation only after 404 and an identified older Core", async () => {
    const core = origin();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ component: "hosty-core", status: "running", version: "0.119.9" })); vi.stubGlobal("fetch", fetcher);
    expect(await resolveAppAuthProtocol(core)).toBe(1);
    expect(String(fetcher.mock.calls[1][0])).toBe(`${core}/api/core/status`);
    expect(fetcher.mock.calls[1][1]).toMatchObject({ cache: "no-store", redirect: "error" });
  });
  it.each([400, 401, 403, 500, 503])("never downgrades after metadata HTTP %i", async status => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status })); vi.stubGlobal("fetch", fetcher);
    expect(await resolveAppAuthProtocol(origin())).toBeNull(); expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([null, { version: 1 }, { version: "2" }, { version: 3 }, {}])("refuses malformed/unsupported metadata %j", async body => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(body)); vi.stubGlobal("fetch", fetcher);
    expect(await resolveAppAuthProtocol(origin())).toBeNull(); expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(["0.120.0", "0.120.0-preview", "1.0.0", "0.119", "00.119.0", "0.119.0-01", "0.119.0-foo..bar", "unknown"])("does not trust status version %s", async version => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ component: "hosty-core", status: "running", version })));
    expect(await resolveAppAuthProtocol(origin())).toBeNull();
  });
  it.each([{ component: "other", status: "running", version: "0.119.0" }, { component: "hosty-core", status: "stopped", version: "0.119.0" }])("rejects a different or non-running service %j", async body => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(Response.json(body)));
    expect(await resolveAppAuthProtocol(origin())).toBeNull();
  });
  it("keeps the protocol-2 minimum through a later missing route", async () => {
    const core = origin();
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ version: 2 })).mockResolvedValueOnce(new Response(null, { status: 404 })); vi.stubGlobal("fetch", fetcher);
    expect(await resolveAppAuthProtocol(core)).toBe(2);
    expect(await resolveAppAuthProtocol(core)).toBeNull(); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("refuses outages and redirects instead of sending discovery somewhere else", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("redirect rejected")); vi.stubGlobal("fetch", fetcher);
    expect(await resolveAppAuthProtocol(origin())).toBeNull(); expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([null, "bad", "https://user:secret@core.test", "https://core.test/path", "https://core.test/?next=evil"])("refuses an invalid configured origin %s", async core => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect(await resolveAppAuthProtocol(core)).toBeNull(); expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("exchange proof syntax", () => {
  it.each([null, undefined, "", "x".repeat(42), "x".repeat(129), "x".repeat(42) + "=", "x".repeat(42) + "é"])("rejects malformed verifier %s", value => expect(isValidCodeVerifier(value)).toBe(false));
  it("accepts the RFC unreserved range", () => expect(isValidCodeVerifier("a-_.~".repeat(10))).toBe(true));
});
