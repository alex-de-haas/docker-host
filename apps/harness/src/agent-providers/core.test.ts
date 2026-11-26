import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreAgentBackend } from "./core.js";

const provider = { appId: "independent.vendor", installationId: "installed-instance", key: "coding" };
const capabilities = { version: 2, eventVersions: ["agent-event.1"], capabilities: ["connections.usage"],
  limits: { maxCommandBytes: 1048576, maxEventBytes: 1048576, maxSnapshotBytes: 1048576, maxReplayBytes: 67108864,
    replayRetentionMs: 604800000, maxControls: 10000, maxPageSize: 100 }, configuration: { resumeCompatible: [] } };
afterEach(() => { vi.unstubAllGlobals(); });
describe("Core agent consumer transport", () => {
  it("sends user/service credentials only to Core and rewrites the explicit Docker topology", async () => {
    const requests: Array<{ url: string; headers: Headers; body?: string }> = [];
    const backend = new CoreAgentBackend({ coreOrigin: "http://core:7070", appId: "consumer", serviceToken: "consumer-service-secret",
      runningInContainer: true, fetch: (async (input, init) => {
        const url = String(input), headers = new Headers(init?.headers);
        requests.push({ url, headers, body: typeof init?.body === "string" ? init.body : undefined });
        if (url.endsWith("/providers/agent")) return Response.json({ providers: [{ ...provider, displayName: "Independent", available: true, version: 2 }] });
        if (url.endsWith("/agent/authorize")) return Response.json({ provider, baseUrl: "http://127.0.0.1:3491/api/agent/v2",
          token: "scoped-operation-token", expiresAt: new Date(Date.now() + 60000).toISOString() });
        if (url.endsWith("/capabilities")) return Response.json(capabilities);
        if (url.includes("/connections")) return Response.json({ connections: [{ id: "account", revision: "7", name: "Personal", ready: true }], nextCursor: null });
        throw new Error("Unexpected request");
      }) as typeof fetch });
    const authority = async () => "original-user-session";
    expect(await backend.providers(authority)).toEqual([{ ref: provider, displayName: "Independent", available: true }]);
    expect(await backend.connections(provider, authority)).toEqual([{ id: "account", revision: "7", name: "Personal", available: true, capabilities: ["connections.usage"] }]);
    const operation = requests.find(request => request.url.endsWith("/agent/authorize"))!;
    expect(operation.headers.get("authorization")).toBe("Bearer consumer-service-secret");
    expect(operation.headers.get("X-Hosty-User-Token")).toBe("original-user-session");
    expect(operation.headers.has("X-Hosty-App-Identity")).toBe(false);
    expect(JSON.parse(operation.body!)).toMatchObject({ provider, operation: "capabilities", method: "GET", path: "/capabilities" });
    for (const request of requests.filter(request => request.url.startsWith("http://host.docker.internal"))) {
      expect(request.headers.get("authorization")).toBe("Bearer scoped-operation-token");
      expect(request.headers.has("X-Hosty-User-Token")).toBe(false);
      expect(JSON.stringify(request)).not.toContain("consumer-service-secret");
    }
  });

  it("refuses a replaced installation before transmitting to its endpoint", async () => {
    let providerCalls = 0;
    const backend = new CoreAgentBackend({ coreOrigin: "http://core:7070", appId: "consumer", serviceToken: "service", fetch: (async (input) => {
      if (String(input).endsWith("/agent/authorize")) return Response.json({ provider: { ...provider, installationId: "replacement" },
        baseUrl: "http://provider/api/agent/v2", token: "token", expiresAt: new Date(Date.now() + 60000).toISOString() });
      providerCalls++; return Response.json(capabilities);
    }) as typeof fetch });
    await expect(backend.client(provider, async () => "actor").capabilities()).rejects.toMatchObject({ code: "provider_changed" });
    expect(providerCalls).toBe(0);
  });

});
