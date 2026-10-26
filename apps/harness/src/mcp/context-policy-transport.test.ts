import { expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevelopmentMcp, DEVELOPMENT_PROVIDER, DEVELOPMENT_IDENTITY, developmentTools } from "../sessions/development.js";
import { SettingsStore } from "../settings/store.js";
import { McpToolPolicy, ruleKey, type ToolMode } from "./policy.js";
import { toCodexMcpConfig, tokenEnvVar } from "../harness/codex-mcp.js";

const cases = ["claude", "codex"].flatMap(provider => [false, true].flatMap(autonomous =>
  (["ask", "run", "disabled"] as ToolMode[]).map(mode => ({ provider, autonomous, mode }))));
it.each(cases)("keeps context tools session-bound for $provider with autonomous=$autonomous and mode=$mode", async ({ provider, autonomous, mode }) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hosty-context-policy-"));
  const invoked = vi.fn(async (_id, _action, _input, guard?: () => Promise<void>) => { await guard?.(); return { revision: 1, appIds: ["notes"] }; });
  const approvals: string[] = [];
  const policy = new McpToolPolicy(new SettingsStore(dir), async (_id, event) => { approvals.push(event.approvalId); }, async () => {}, 10_000, () => autonomous);
  const mcp = new DevelopmentMcp(invoked); mcp.policy = policy;
  const server = createServer((req, res) => { void mcp.handle(req, res, new URL(req.url!, "http://local").pathname); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = mcp.config("one", origin);
  const entry = config["hosty-workspaces"] as { url: string; headers: Record<string, string> };
  // Claude uses the HTTP descriptor; Codex receives the same secret only through its environment.
  const converted = toCodexMcpConfig(config);
  const headers = provider === "claude" ? entry.headers : { authorization: "Bearer " + converted.env[tokenEnvVar("hosty-workspaces")] };
  if (provider === "codex") expect(converted.args.join(" ")).toContain(JSON.stringify(entry.url));
  const call = (url: string, id: number, method: string, name?: string) => fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { name, arguments: { appIds: ["notes"], expectedRevision: 0, requestId: "8c6b802d-ea6a-4bb7-9abb-342cc7a17156" } } }) });
  try {
    await policy.catalog(DEVELOPMENT_PROVIDER, DEVELOPMENT_IDENTITY, developmentTools());
    await policy.update({ [ruleKey(DEVELOPMENT_PROVIDER, "context_add")]: { identity: DEVELOPMENT_IDENTITY, mode } });
    const tools = await (await call(entry.url, 1, "tools/list")).json() as any;
    expect(tools.result.tools.some((tool: any) => tool.name === "context_add")).toBe(mode !== "disabled");
    expect(tools.result.tools.filter((tool: any) => tool.name.startsWith("context_")).length).toBe(mode === "disabled" ? 3 : 4);
    const pending = call(entry.url, 2, "tools/call", "context_add");
    if (mode === "ask" && !autonomous) {
      await vi.waitFor(() => expect(approvals).toHaveLength(1));
      expect(invoked).not.toHaveBeenCalled();
      expect(policy.resolve("one", approvals[0]!, true)).toBe(true);
    }
    const result = await (await pending).json() as any;
    expect(Boolean(result.result.isError)).toBe(mode === "disabled");
    expect(invoked).toHaveBeenCalledTimes(mode === "disabled" ? 0 : 1);
    if (mode !== "disabled") {
      expect(invoked.mock.calls[0]?.[0]).toBe("one");
      expect(JSON.parse(result.result.content[0].text)).toEqual({ revision: 1, appIds: ["notes"] });
    }
    if (mode !== "ask" || autonomous) expect(approvals).toHaveLength(0);
    mcp.config("two", origin);
    expect((await call(origin + "/internal/workspaces/two", 3, "tools/call", "context_add")).status).toBe(403);
    mcp.unregister("one");
    expect((await call(entry.url, 4, "tools/call", "context_add")).status).toBe(403);
  } finally {
    policy.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
