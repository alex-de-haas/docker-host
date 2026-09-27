import { afterEach, expect, it, vi } from "vitest";
import { ProviderDirectory } from "./providers.js";
const entry = (id = "notes", offered = false) => ({ id, displayName: id, offered, runtimeState: "running", skills: [], interfaces: [{ key: "default", url: "http://notes/current", readiness: "ready" }] });
afterEach(() => vi.restoreAllMocks());
it("uses revision revalidation without granting from a stale directory during an outage", async () => {
  const target = entry();
  const fetcher = vi.spyOn(globalThis, "fetch");
  fetcher.mockResolvedValueOnce(Response.json({ apps: [{ id: "notes" }], agents: { revision: "r1", targets: [target] } }));
  const directory = new ProviderDirectory("http://core", "service", "assistant");
  expect((await directory.read())?.providers[0]?.offered).toBe(false);
  fetcher.mockResolvedValueOnce(new Response(null, { status: 304 }));
  expect(await directory.resolveOffered("notes")).toBeNull();
  expect(fetcher.mock.calls[1]?.[0]).toContain("revision=r1");
  fetcher.mockResolvedValueOnce(Response.json({ apps: [], agents: { revision: "r2", targets: [{ ...target, offered: true }] } }));
  expect(await directory.resolveOffered("notes")).toBe("http://notes/current");
  fetcher.mockRejectedValueOnce(new Error("offline"));
  await expect(directory.resolveOffered("notes")).rejects.toThrow("unavailable");
  expect(directory.revision).toBe("r2");
});
it("enforces Core's switch, per-interface readiness and approved skill bytes", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ apps: [], agents: { revision: "r1", targets: [
    entry("hosty:core", false), { ...entry("notes", true), skills: [{ key: "agent", digest: "new", approvedDigest: "old" }], interfaces: [
      { key: "default", url: "http://notes/stopped", readiness: "unavailable" },
      { key: "healthy", url: "http://notes/ready", readiness: "ready" },
    ] },
  ] } }));
  const directory = new ProviderDirectory("http://core", "service", "assistant");
  expect(await directory.resolveOffered("hosty:core")).toBeNull();
  expect(await directory.resolveOffered("notes")).toBe("http://notes/ready");
  expect(await directory.resolveOffered("notes", "http://notes/stopped")).toBeNull();
  expect(directory.approvedSkills()).toEqual({});
});
it("does not interpret a legacy Core roster as an offer", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ apps: [entry("notes", true)] }));
  const directory = new ProviderDirectory("http://core", "service", "assistant", "http://core/api/mcp");
  expect(await directory.read()).toBeNull();
  expect(directory.core()).toBeNull();
});
