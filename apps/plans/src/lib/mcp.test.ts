import { beforeEach, describe, expect, it, vi } from "vitest";
const fakes = vi.hoisted(() => ({ introspect: vi.fn(), reader: vi.fn(), repositories: vi.fn(), detail: vi.fn() }));
vi.mock("@hosty-sdk/app/scoped-token", () => ({ introspectMcpToken: fakes.introspect, hasScope: (actor: { scopes: string[] }, scope: string) => actor.scopes.includes(scope), SCOPE_MCP_READ: "mcp:read" }));
vi.mock("./core-client", () => ({ CoreSourceReader: class { constructor(credential: string) { fakes.reader(credential); } } }));
vi.mock("./service", () => ({ PlansService: class { repositories = fakes.repositories; detail = fakes.detail; } }));
import { mcpRequest, TOOLS } from "./mcp";
function request(method: string, params?: object, id: number | undefined = 1) { return new Request("http://plans.example/api/mcp", { method: "POST", headers: { Authorization: "Bearer hosty_mcp.1.addressed", "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }) }); }
beforeEach(() => { vi.clearAllMocks(); fakes.introspect.mockResolvedValue({ active: true, sub: "admin", role: "host.admin", scopes: ["mcp:read"], callerAppId: "assistant" }); fakes.repositories.mockResolvedValue([]); fakes.detail.mockResolvedValue({ repository: { id: "repo" }, path: "docs/features/a/plan.md", document: null, workspaces: [] }); });
describe("read-only MCP", () => {
  it("introspects each request and exposes only read-only tools", async () => {
    await mcpRequest(request("initialize"));
    const response = await mcpRequest(request("tools/list"));
    expect(fakes.introspect).toHaveBeenCalledTimes(2);
    expect((await response.json()).result.tools).toEqual(TOOLS);
    expect(TOOLS.every(tool => tool.annotations.readOnlyHint === true)).toBe(true);
  });
  it("acknowledges notifications with bodyless HTTP 202", async () => {
    const response = await mcpRequest(new Request("http://plans.example/api/mcp", { method: "POST", headers: { Authorization: "Bearer hosty_mcp.1.addressed" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }));
    expect(response.status).toBe(202); expect(await response.text()).toBe(""); expect(response.headers.get("Content-Type")).toBeNull();
  });
  it("forwards the exact tool credential to Core and returns detail links", async () => {
    const response = await mcpRequest(request("tools/call", { name: "get_plan", arguments: { repository: "repo", path: "docs/features/a/plan.md" } }));
    expect(fakes.introspect).toHaveBeenCalledWith("hosty_mcp.1.addressed", { tool: "get_plan" });
    expect(fakes.reader).toHaveBeenCalledWith("hosty_mcp.1.addressed");
    const result = JSON.parse((await response.json()).result.content[0].text);
    expect(new URL(result.detailUrl).searchParams.get("document")).toBe("docs/features/a/plan.md");
    expect(fakes.detail).toHaveBeenCalledWith("repo", "docs/features/a/plan.md");
  });
  it("refuses non-administrators per tool and credentials without mcp:read", async () => {
    fakes.introspect.mockResolvedValue({ active: true, sub: "user", role: "host.user", scopes: ["mcp:read"] });
    expect((await (await mcpRequest(request("tools/call", { name: "list_plans" }))).json()).result.isError).toBe(true);
    expect(fakes.repositories).not.toHaveBeenCalled();
    fakes.introspect.mockResolvedValue({ active: true, sub: "admin", role: "host.admin", scopes: ["mcp:invoke"] });
    expect((await mcpRequest(request("tools/list"))).status).toBe(403);
  });
  it("distinguishes Core outage from invalid credentials and reports tool failures", async () => {
    fakes.introspect.mockResolvedValue({ active: false, error: { code: "core_unavailable" } });
    expect((await mcpRequest(request("tools/list"))).status).toBe(503);
    fakes.introspect.mockResolvedValue({ active: false });
    expect((await mcpRequest(request("tools/list"))).status).toBe(401);
    fakes.introspect.mockResolvedValue({ active: true, sub: "admin", role: "host.admin", scopes: ["mcp:read"] });
    fakes.detail.mockRejectedValue(new Error("Document changed; retry"));
    expect((await (await mcpRequest(request("tools/call", { name: "get_plan", arguments: { repository: "repo", path: "docs/features/a/plan.md" } }))).json()).result.isError).toBe(true);
  });
});
