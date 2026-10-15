import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreEnvironmentClient, SandboxClient } from "./sandbox-server";
afterEach(() => vi.unstubAllGlobals());
const options = { appId: "qa.client", coreOrigin: "http://core.test", serviceToken: "service" };
describe("independent sandbox client", () => {
  it("sends an artifact request without allocating a workspace or changing ownership", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "plan" }))); vi.stubGlobal("fetch", fetch);
    const client = new SandboxClient(async () => "background-grant", options);
    await client.plan({ appId: "demo.app", profile: "sandbox", source: { kind: "appArtifact", artifactDigest: "a".repeat(64) } });
    const [url, init] = fetch.mock.calls[0];
    expect(url.toString()).toBe("http://core.test/api/internal/apps/qa.client/sandbox-instances/plans");
    expect(init.redirect).toBe("error");
    expect(init.headers["X-Hosty-User-Token"]).toBe("background-grant");
    expect(JSON.parse(init.body).context).toBeUndefined();
  });
  it("does not repeat uncertain mutations or invent request IDs", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("connection reset")); vi.stubGlobal("fetch", fetch);
    const client = new SandboxClient(async () => "interactive", options);
    await expect(client.prepare({ requestId: "a".repeat(32), planId: "b".repeat(32), digest: "c".repeat(64) })).rejects.toMatchObject({ code: "sandbox_outcome_unknown" });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(client.prepare({ requestId: "", planId: "b".repeat(32), digest: "c".repeat(64) })).rejects.toMatchObject({ code: "sandbox_request_required" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects target path escapes before obtaining credentials", async () => {
    const authority = vi.fn(); const client = new SandboxClient(authority, options);
    await expect(client.status("../admin")).rejects.toMatchObject({ code: "sandbox_id_invalid" });
    expect(authority).not.toHaveBeenCalled();
  });
  it("resolves persona navigation without a mutation and preserves job identity for evidence cleanup", async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ state: "ready" })))); vi.stubGlobal("fetch", fetch);
    const client = new SandboxClient(async () => "interactive", options);
    await client.call("sandbox-preview", { runtimeInstanceId: "a".repeat(32), userId: "sandbox_" + "b".repeat(32) });
    expect(fetch.mock.calls[0][0].pathname).toContain("/preview");
    expect(fetch.mock.calls[0][1].method).toBe("GET");
    const input = { runtimeInstanceId: "a".repeat(32), jobId: "b".repeat(32), expectedRevision: 2, requestId: "c".repeat(32) };
    await client.call("sandbox-evidence-clear", input);
    expect(fetch.mock.calls[1][0].pathname).toContain("/evidence/clear");
    expect(JSON.parse(fetch.mock.calls[1][1].body).jobId).toBe(input.jobId);
    await client.call("sandbox-browser-cancel", input);
    expect(fetch.mock.calls[2][0].pathname).toContain("/browser-runs/cancel");
  });

});

describe("child Core environment client", () => {
  it("targets only the child manager and does not retry unknown mutations", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("lost response")); vi.stubGlobal("fetch", fetch);
    const client = new CoreEnvironmentClient(async () => "operator-grant", options);
    await expect(client.call("environment-create", { requestId: "a".repeat(32), label: "QA" })).rejects.toMatchObject({ code: "environment_outcome_unknown" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0].pathname).toBe("/api/internal/apps/qa.client/core-environments");
    await expect(client.call("environment-finish", { environmentId: "../parent", requestId: "b".repeat(32) })).rejects.toMatchObject({ code: "environment_id_invalid" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
