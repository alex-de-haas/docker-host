import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { DevelopmentClient, DevelopmentMcp, workspaceInstructions } from "./development.js";

let server: Server | undefined;
afterEach(async () => { vi.unstubAllGlobals(); if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; } });

describe("Core workspaces transport", () => {
  it("forwards bounded guide topics without mutations and preserves Core refusals", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ topic: "identity", revision: "r", text: "guide" })));
    vi.stubGlobal("fetch", fetcher);
    const client = new DevelopmentClient("http://core.test", "hosty.harness", "service");
    await expect(client.call("session", "user", "app-creation-guide", { topic: "identity" })).resolves.toMatchObject({ topic: "identity" });
    expect(String(fetcher.mock.calls[0]![0])).toBe("http://core.test/api/internal/apps/hosty.harness/sessions/session/app-creations/guide?topic=identity");
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: "GET", body: undefined });
    await client.call("session", "user", "app-creation-guide", {});
    expect(String(fetcher.mock.calls[1]![0])).toMatch(/\/guide$/);
    for (const topic of [[], {}, null, 42, "x".repeat(33)])
      await expect(client.call("session", "user", "app-creation-guide", { topic })).rejects.toMatchObject({ code: "development_guide_topic_invalid" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockImplementation(async () => new Response(JSON.stringify({ code: "development_guide_topic_invalid", message: "Unknown guide topic." }), { status: 400 }));
    await expect(client.call("session", "user", "app-creation-guide", { topic: "../secret&x=y" })).rejects.toMatchObject({ status: 400, code: "development_guide_topic_invalid" });
    expect(String(fetcher.mock.calls[2]![0])).toContain("?topic=..%2Fsecret%26x%3Dy");
  });

  it("routes ordinary dev review and replay through the same session authority", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ phase: "active" })));
    vi.stubGlobal("fetch", fetcher);
    const client = new DevelopmentClient("http://core.test", "hosty.harness", "service");
    const input = { appId: "example.app", requestId: "stable-id", devAction: "enter", targetRuntime: "dev", planDigest: "review" };
    await client.call("session", "user", "app-dev-status", { appId: input.appId });
    expect(fetcher.mock.calls[0]![1]?.method).toBe("GET");
    for (const action of ["app-dev-plan", "app-dev-apply", "app-dev-apply"] as const)
      await client.call("session", "user", action, input);
    expect(String(fetcher.mock.calls[2]![0])).toBe("http://core.test/api/internal/apps/hosty.harness/sessions/session/dev-mode/example.app/apply");
    expect(fetcher.mock.calls[2]![1]?.body).toBe(fetcher.mock.calls[3]![1]?.body);
    expect(JSON.parse(String(fetcher.mock.calls[2]![1]?.body)).action).toBe("enter");
    expect(fetcher.mock.calls[2]![1]?.headers).toMatchObject({ authorization: "Bearer service", "X-Hosty-User-Token": "user" });
    fetcher.mockImplementation(async () => new Response(JSON.stringify({ code: "app_permission_required", message: "Lifecycle required" }), { status: 403 }));
    await expect(client.call("session", "user", "app-dev-apply", input)).rejects.toMatchObject({ code: "app_permission_required" });
  });

  it("binds every request to the assistant and session without putting Core credentials in agent config", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ workspaces: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const client = new DevelopmentClient("http://core.test", "hosty.harness", "service-secret");
    await client.call("session/one", "current-user", "list", {});
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("http://core.test/api/internal/apps/hosty.harness/sessions/session%2Fone/workspaces");
    expect(init.headers).toMatchObject({ authorization: "Bearer service-secret", "X-Hosty-User-Token": "current-user" });
    await expect(client.call("one", "user", "cleanup", { workspaceId: "../other" })).rejects.toThrow("workspace ID");
    fetcher.mockRejectedValue(new Error("connection lost"));
    await expect(client.call("one", "user", "prepare", {})).rejects.toThrow("same requestId");
  });

  it.each([
    [404, "", "workspace_failed", "Workspace request failed."],
    [503, "<html>upstream unavailable</html>", "workspace_failed", "Workspace request failed."],
    [400, "null", "workspace_failed", "Workspace request failed."],
    [403, JSON.stringify({ code: "workspace_forbidden", message: "Workspace access denied." }), "workspace_forbidden", "Workspace access denied."],
    [400, JSON.stringify({ code: 42, message: {} }), "workspace_failed", "Workspace request failed."],
  ] as const)("preserves Core status %s for structured or non-JSON inspection failures", async (status, body, code, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status })));
    const client = new DevelopmentClient("http://core.test", "hosty.harness", "service-secret");
    await expect(client.inspection("current-user", "/missing")).rejects.toMatchObject({ status, code, message });
  });

  it("rejects malformed successful inspection data without exposing the upstream body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not JSON", { status: 200 })));
    const client = new DevelopmentClient("http://core.test", "hosty.harness", "service-secret");
    await expect(client.inspection("current-user")).rejects.toMatchObject({ status: 502, code: "workspace_response_invalid" });
  });

  it("serves session-key authenticated MCP, acknowledges notifications, revokes keys and preserves Unicode", async () => {
    const invoke = vi.fn().mockResolvedValue({ state: "active" });
    const mcp = new DevelopmentMcp(invoke);
    server = createServer((req, res) => { void mcp.handle(req, res, new URL(req.url!, "http://localhost").pathname); });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const config = mcp.config("session-one", `http://127.0.0.1:${port}`)["hosty-workspaces"] as { url: string; headers: Record<string, string> };
    const call = (body: unknown, headers = config.headers) => fetch(config.url, { method: "POST", headers, body: JSON.stringify(body) });
    expect(JSON.stringify(config)).not.toContain("service-secret");
    expect((await call({ id: 1, method: "ping" }, {})).status).toBe(403);
    const initialized = await call({ method: "notifications/initialized" });
    expect(initialized.status).toBe(202); expect(await initialized.text()).toBe(""); expect(initialized.headers.has("content-type")).toBe(false);
    const initializedRpc = await call({ id: 1, method: "initialize" });
    expect(((await initializedRpc.json()) as { result: { capabilities: unknown } }).result.capabilities).toEqual({ tools: {} });
    const catalog = ((await (await call({ id: 2, method: "tools/list" })).json()) as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } }).result.tools;
    expect(catalog.find((t: { name: string }) => t.name === "commit")!.annotations.readOnlyHint).toBe(false);
    expect(catalog.find(t => t.name === "remote_status")!.annotations.readOnlyHint).toBe(true);
    for (const name of ["remote_connect", "remote_fetch", "remote_push_base", "merge_upstream", "pr_push"])
      expect(catalog.find(t => t.name === name)!.annotations.readOnlyHint).toBe(false);
    const result = await call({ id: 3, method: "tools/call", params: { name: "commit", arguments: { message: "Изменения — ✓" } } });
    expect(((await result.json()) as { result: { isError?: boolean } }).result.isError).toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("session-one", "commit", { message: "Изменения — ✓" });
    expect(catalog.find(t => t.name === "app_creation_guide")!.annotations.readOnlyHint).toBe(true);
    await call({ id: 5, method: "tools/call", params: { name: "app_creation_guide", arguments: { topic: "sdk" } } });
    expect(invoke).toHaveBeenCalledWith("session-one", "app-creation-guide", { topic: "sdk" });
    mcp.unregister("session-one");
    expect((await call({ id: 4, method: "ping" })).status).toBe(403);
  });

  it("states the cooperative source boundary and keeps runtime testing separate", () => {
    const instruction = workspaceInstructions([]);
    expect(instruction).toContain("before editing application source");
    expect(instruction).toContain("Do not access or modify original source checkouts");
    expect(instruction).toContain("not filesystem isolation");
    expect(instruction).toContain("does not change the running application");
  });
});

it("resolves the viewer through the owning session without making a workspace mutation", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ url: "http://workspaces.test/?workspace=aggregate" }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  const client = new DevelopmentClient("http://core.test", "hosty.harness", "service");
  await client.call("session/one", "user", "viewer", { workspaceId: "a".repeat(64) });
  const [url, init] = fetcher.mock.calls[0]!;
  expect(String(url)).toBe(`http://core.test/api/internal/apps/hosty.harness/sessions/session%2Fone/workspaces/${"a".repeat(64)}/viewer`);
  expect(init.method).toBe("GET"); expect(init.body).toBeUndefined();
});

// Core serializes a null lease-release result as an empty successful response.
it("accepts an empty successful worker lease release but requires bindings for acquisition", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 204 });
  try {
    const client = new DevelopmentClient("http://core.test", "hosty.harness", "service");
    await expect(client.workerBindings("session", "hostyg_test", { leaseId: "id", acquire: false })).resolves.toBeNull();
    await expect(client.workerBindings("session", "hostyg_test", { leaseId: "id", acquire: true })).rejects.toThrow();
  } finally { globalThis.fetch = original; }
});


it("sends activation through its owned session with the original reviewed body", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ state: "accepted" })));
  vi.stubGlobal("fetch", fetcher);
  const client = new DevelopmentClient("http://core.test", "hosty.harness", "service");
  const input = { workspaceId: "a".repeat(64), requestId: "original", selection: { coreSelected: false }, planDigest: "review" };
  await client.call("session", "user", "activation-apply", input);
  expect(String(fetcher.mock.calls[0]![0])).toBe(`http://core.test/api/internal/apps/hosty.harness/sessions/session/workspace-activation/${input.workspaceId}/apply`);
  expect(fetcher.mock.calls[0]![1]?.body).toBe(JSON.stringify(input));
  expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({ "X-Hosty-User-Token": "user" });
});
