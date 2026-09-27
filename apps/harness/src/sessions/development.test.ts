import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { DevelopmentClient, DevelopmentMcp, workspaceInstructions } from "./development.js";

let server: Server | undefined;
afterEach(async () => { vi.unstubAllGlobals(); if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; } });

describe("Core workspaces transport", () => {
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
    const result = await call({ id: 3, method: "tools/call", params: { name: "commit", arguments: { message: "Изменения — ✓" } } });
    expect(((await result.json()) as { result: { isError?: boolean } }).result.isError).toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("session-one", "commit", { message: "Изменения — ✓" });
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
