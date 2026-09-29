import { expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevelopmentMcp, DEVELOPMENT_PROVIDER, DEVELOPMENT_IDENTITY, developmentTools } from "../sessions/development.js";
import { SettingsStore } from "../settings/store.js";
import { McpToolPolicy, ruleKey } from "./policy.js";

it("gates real local MCP calls once and refuses a disabled mutation before invocation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hosty-policy-transport-"));
  let invoked = 0; let approval!: (id: string) => void;
  const ready = new Promise<string>(resolve => { approval = resolve; });
  const policy = new McpToolPolicy(new SettingsStore(dir), async (_session, event) => { approval(event.approvalId); }, async () => {});
  const mcp = new DevelopmentMcp(async () => { invoked++; return { done: true }; }); mcp.policy = policy;
  const server = createServer((req, res) => { void mcp.handle(req, res, new URL(req.url!, "http://local").pathname); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const entry = mcp.config("session", origin)["hosty-workspaces"] as { url: string; headers: Record<string, string> };
  const call = (id: number) => fetch(entry.url, { method: "POST", headers: { ...entry.headers, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "pr_merge", arguments: { expectedHead: "abc" } } }) });
  try {
    const pending = call(1); const id = await ready;
    expect(invoked).toBe(0); expect(policy.resolve("session", id, true)).toBe(true);
    expect((await (await pending).json() as { result: { isError?: boolean } }).result.isError).toBeUndefined(); expect(invoked).toBe(1);
    await policy.catalog(DEVELOPMENT_PROVIDER, DEVELOPMENT_IDENTITY, developmentTools());
    await policy.update({ [ruleKey(DEVELOPMENT_PROVIDER, "pr_merge")]: { identity: DEVELOPMENT_IDENTITY, mode: "disabled" } });
    expect((await (await call(2)).json() as { result: { isError?: boolean } }).result.isError).toBe(true); expect(invoked).toBe(1);
  } finally { policy.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});
