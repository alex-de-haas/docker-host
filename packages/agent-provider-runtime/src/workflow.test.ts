import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AGENT_SESSION_WORKFLOW_TOOLS, AGENT_SUBAGENT_WORKFLOW_TOOLS, type AgentSessionWorkflowBinding } from "@hosty-sdk/app/agent";
import { ProviderMcp } from "./mcp.js";
import type { ProviderAuthority } from "./core.js";
import { workflowTools } from "@hosty-sdk/app/agent/workflow-tools";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const binding = (): AgentSessionWorkflowBinding => ({ executor: { appId: "independent.consumer", installationId: "consumer-installation", key: "workflow" }, sessionId: randomUUID() });
async function fixture(value?: AgentSessionWorkflowBinding, autonomous = false) {
  const notify = vi.fn(async (_run: string, _event: { approvalId: string }) => {}), settled = vi.fn(async () => {});
  const authority = { renew: vi.fn(async () => ({})), mcp: vi.fn(async () => { throw new Error("A workflow must never request a Core MCP token."); }), workflow: vi.fn(async () => ({ state: "received" })) } as unknown as ProviderAuthority;
  let origin = "";
  const runId = randomUUID(), mcp = new ProviderMcp(authority, () => origin, notify, settled);
  const server = createServer((request, response) => { void mcp.proxy.handle(request, response, new URL(request.url!, "http://fixture.invalid").pathname).then(handled => { if (!handled) { response.writeHead(404); response.end(); } }); });
  cleanups.push(async () => { mcp.close(runId); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture listener."); origin = `http://127.0.0.1:${address.port}`;
  await mcp.workflow.configure(runId, "original-admission", value);
  const configured = await mcp.configure(runId, "original-admission", undefined, autonomous);
  const config = configured.servers["hosty-workflow"] as { url: string; headers: Record<string, string> } | undefined;
  const rpc = async (method: string, args?: unknown, id: string = randomUUID()) => {
    if (!config) throw new Error("No workflow selected.");
    const response = await fetch(config.url, { method: "POST", headers: { ...config.headers, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(args === undefined ? {} : { params: args }) }) });
    return { status: response.status, body: await response.json() as { error?: { message: string }; result?: unknown } };
  };
  return { runId, origin, mcp, authority, notify, settled, configured, config, rpc };
}

it("does not create a workflow server, callback or Core MCP request without an explicit admission binding", async () => {
  const f = await fixture(); expect(f.configured).toEqual({ servers: {}, prefixes: [] });
  expect((await fetch(`${f.origin}/internal/mcp/${f.runId}/hosty-workflow`, { method: "POST" })).status).toBe(401);
  expect(f.authority.mcp).not.toHaveBeenCalled(); expect(f.authority.workflow).not.toHaveBeenCalled();
});
it("serves exactly the fixed business catalog to a genuine MCP client and requires Ask even for Autonomous", async () => {
  const f = await fixture(binding(), true), client = new Client({ name: "independent-native-client", version: "1" });
  cleanups.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(f.config!.url), { requestInit: { headers: f.config!.headers } }));
  const catalog = await client.listTools(); expect(catalog.tools.map(tool => tool.name)).toEqual([...AGENT_SESSION_WORKFLOW_TOOLS]);
  expect(catalog.tools.every(tool => tool.inputSchema.required?.includes("input"))).toBe(true);
  const pending = client.callTool({ name: "task_executor_options", arguments: { input: {} } });
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalledOnce()); expect(f.authority.workflow).not.toHaveBeenCalled();
  expect(f.mcp.resolve(f.runId, f.notify.mock.calls[0]![1].approvalId, true)).toBe(true);
  expect(await pending).toMatchObject({ content: [{ type: "text", text: '{"state":"received"}' }] });
  expect(f.authority.workflow).toHaveBeenCalledWith("original-admission", "task-executor-options", {}, undefined);
  expect(f.authority.mcp).not.toHaveBeenCalled(); expect(f.settled).toHaveBeenCalledWith(f.runId, expect.any(String), expect.any(String), true, false);
});
it("negotiates child-chat tools separately and dispatches only validated input under the current run", async () => {
  const f = await fixture({ ...binding(), tools: [...AGENT_SUBAGENT_WORKFLOW_TOOLS], policy: { default: "run" } });
  const list = (await f.rpc("tools/list")).body.result as { tools: { name: string }[] };
  expect(list.tools.map(tool => tool.name)).toEqual([...AGENT_SUBAGENT_WORKFLOW_TOOLS]);
  const input = { requestId: randomUUID(), profileId: randomUUID(), profileRevision: 3, prompt: "Review the change." };
  for (const args of [{ input: { ...input, parentSessionId: randomUUID() } }, { input, source: binding().executor }, { input: { ...input, profileRevision: 0 } }])
    expect((await f.rpc("tools/call", { name: "subagent_spawn", arguments: args })).body.error).toBeDefined();
  expect((await f.rpc("tools/call", { name: "task_create", arguments: { input: {} } })).body.error).toBeDefined();
  expect(f.authority.workflow).not.toHaveBeenCalled();
  expect((await f.rpc("tools/call", { name: "subagent_spawn", arguments: { input } })).body.error).toBeUndefined();
  expect(f.authority.workflow).toHaveBeenCalledWith("original-admission", "subagent-spawn", input, undefined);
  expect(f.authority.mcp).not.toHaveBeenCalled();
});
it("keeps Disabled and selected tools authoritative for discovery and calls", async () => {
  const f = await fixture({ ...binding(), tools: ["task_get"], policy: { default: "run", tools: { task_get: { mode: "disabled" } } } });
  expect((await f.rpc("tools/list")).body.result).toEqual({ tools: [] });
  for (const name of ["task_get", "task_executor_options", "workspace_list"]) expect((await f.rpc("tools/call", { name, arguments: { input: {} } })).body.error).toBeDefined();
  expect(f.authority.workflow).not.toHaveBeenCalled(); expect(f.notify).not.toHaveBeenCalled(); expect(f.authority.mcp).not.toHaveBeenCalled();
});
it("inherits autonomous mode for the four child-chat operations in a mixed task catalog", async () => {
  const f = await fixture({ ...binding(), tools: ["task_executor_options", ...AGENT_SUBAGENT_WORKFLOW_TOOLS] }, true);
  const inputs = {
    subagent_profiles: {},
    subagent_spawn: { requestId: randomUUID(), profileId: "developer", profileRevision: 1, prompt: "Implement." },
    subagent_status: {},
    subagent_wait: { requestId: randomUUID(), childSessionIds: [randomUUID()], mode: "all" },
  };
  for (const name of AGENT_SUBAGENT_WORKFLOW_TOOLS) {
    const { body } = await f.rpc("tools/call", { name, arguments: { input: inputs[name] } });
    expect(body.error).toBeUndefined();
    expect(f.authority.workflow).toHaveBeenCalledWith("original-admission", name.replaceAll("_", "-"), inputs[name], undefined);
  }
  expect(f.notify).not.toHaveBeenCalled();
  const pending = f.rpc("tools/call", { name: "task_executor_options", arguments: { input: {} } });
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalledOnce());
  expect(f.mcp.resolve(f.runId, f.notify.mock.calls[0]![1].approvalId, false)).toBe(true);
  expect((await pending).body.error).toBeDefined();
  expect(f.authority.workflow).toHaveBeenCalledTimes(4);
});

it("preserves normal mode, explicit Ask, stale Run definitions and Disabled for child-chat tools", async () => {
  const f = await fixture({ ...binding(), tools: ["subagent_profiles", "subagent_status", "subagent_wait"], policy: { default: "ask", tools: {
    subagent_profiles: { mode: "ask" },
    subagent_status: { mode: "run", definition: "f".repeat(64) },
    subagent_wait: { mode: "disabled" },
  } } }, true);
  const normal = await fixture({ ...binding(), tools: ["subagent_profiles"] });
  for (const [target, name] of [[f, "subagent_profiles"], [f, "subagent_status"], [normal, "subagent_profiles"]] as const) {
    target.notify.mockClear();
    const pending = target.rpc("tools/call", { name, arguments: { input: {} } });
    await vi.waitFor(() => expect(target.notify).toHaveBeenCalledOnce());
    target.mcp.resolve(target.runId, target.notify.mock.calls[0]![1].approvalId, false);
    expect((await pending).body.error).toBeDefined();
    expect(target.authority.workflow).not.toHaveBeenCalled();
  }
  const catalog = (await f.rpc("tools/list")).body.result as { tools: { name: string }[] };
  expect(catalog.tools.map(tool => tool.name)).toEqual(["subagent_profiles", "subagent_status"]);
  for (const name of ["subagent_wait", "subagent_spawn"])
    expect((await f.rpc("tools/call", { name, arguments: { input: {} } })).body.error).toBeDefined();
  expect(f.authority.workflow).not.toHaveBeenCalled();
});
it("separates native client request namespaces while retaining one admitted run", async () => {
  const f = await fixture({ ...binding(), policy: { default: "run" } });
  const clients = [new Client({ name: "native-parent", version: "1" }), new Client({ name: "native-child", version: "1" })];
  for (const client of clients) {
    cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(f.config!.url), { requestInit: { headers: f.config!.headers } }));
    await client.listTools();
  }
  for (const client of clients) expect(await client.callTool({ name: "task_plan", arguments: { input: { requestId: randomUUID(), expectedRevision: 0, markdown: "Independent native call" } } })).toMatchObject({ content: [{ type: "text" }] });
  expect(f.authority.workflow).toHaveBeenCalledTimes(2);
});
it.each([undefined, null, "named-source"])("preserves the selected Tasks implementation %s for a definition-pinned explicit rule", async implementationId => {
  const definition = createHash("sha256").update(JSON.stringify(workflowTools().find(tool => tool.name === "task_plan"))).digest("hex");
  const f = await fixture({ ...binding(), policy: { default: "ask", tools: { task_plan: { mode: "run", definition } } } });
  const source = { appId: "different.tasks-source", installationId: "tasks-installation", key: "tasks-key", ...(implementationId !== undefined ? { implementationId } : {}) }, input = { requestId: randomUUID(), expectedRevision: 0, markdown: "The plan" };
  expect((await f.rpc("tools/call", { name: "task_plan", arguments: { input, source } })).body.error).toBeUndefined();
  expect(f.authority.workflow).toHaveBeenCalledWith("original-admission", "task-plan", input, source); expect(f.notify).not.toHaveBeenCalled();
});
it("downgrades a changed Run definition to Ask and cancels it when the native route ends", async () => {
  const f = await fixture({ ...binding(), policy: { default: "run", tools: { task_executor_options: { mode: "run", definition: "f".repeat(64) } } } }, true);
  const pending = f.rpc("tools/call", { name: "task_executor_options", arguments: { input: {} } });
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalledOnce()); expect(f.authority.workflow).not.toHaveBeenCalled();
  f.mcp.close(f.runId); expect((await pending).body.error).toBeDefined(); expect(f.authority.workflow).not.toHaveBeenCalled();
});
it("revalidates current original authority after approval before any business effect", async () => {
  const f = await fixture(binding()), pending = f.rpc("tools/call", { name: "task_executor_options", arguments: { input: {} } });
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalledOnce());
  vi.mocked(f.authority.renew).mockRejectedValue(new Error("Original task authority was revoked"));
  f.mcp.resolve(f.runId, f.notify.mock.calls[0]![1].approvalId, true);
  expect((await pending).body.error?.message).toContain("revoked"); expect(f.authority.workflow).not.toHaveBeenCalled();
});
it("cancels a pending Ask when that bounded native MCP client deletes its session", async () => {
  const f = await fixture(binding());
  const opened = await fetch(f.config!.url, { method: "POST", headers: f.config!.headers, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize" }) });
  const id = opened.headers.get("mcp-session-id"); expect(id).toBeTruthy(); await opened.body?.cancel();
  const headers = { ...f.config!.headers, "mcp-session-id": id! };
  const pending = fetch(f.config!.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "task_executor_options", arguments: { input: {} } } }) });
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalledOnce());
  expect((await fetch(f.config!.url, { method: "DELETE", headers })).status).toBe(202);
  expect(await (await pending).json()).toMatchObject({ error: { code: -32001 } });
  expect((await fetch(f.config!.url, { method: "POST", headers, body: '{}' })).status).toBe(404);
  expect(f.authority.workflow).not.toHaveBeenCalled();
});
it("rejects malformed, unknown-field, oversized and cross-run inputs before workflow dispatch", async () => {
  const f = await fixture({ ...binding(), policy: { default: "run" } });
  for (const args of [{ input: [] }, { input: {}, rawUrl: "http://untrusted.invalid" }, { input: { unexpected: true } }, { input: {}, source: { appId: "other" } }])
    expect((await f.rpc("tools/call", { name: "task_executor_options", arguments: args })).body.error).toBeDefined();
  const oversized = await fetch(f.config!.url, { method: "POST", headers: f.config!.headers, body: "x".repeat(65537) }); expect(oversized.status).toBe(413);
  expect((await fetch(f.config!.url.replace(f.runId, randomUUID()), { method: "POST", headers: f.config!.headers })).status).toBe(401);
  expect(f.authority.workflow).not.toHaveBeenCalled(); expect(f.notify).not.toHaveBeenCalled();
});
