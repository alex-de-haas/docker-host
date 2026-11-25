import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentMcpPolicy, AgentMcpSelection, AgentMcpTarget } from "@hosty-sdk/app/agent";
import type { ProviderAuthority } from "./core.js";
import type { UpstreamTool } from "./internal/mcp/upstream.js";
import { ProviderMcp, mcpTargetKey } from "./mcp.js";

const target: AgentMcpTarget = { kind: "core" };
const other: AgentMcpTarget = { kind: "app", appId: "unrelated.tools", installationId: "tools-installation", key: "mcp" };
const tools: UpstreamTool[] = [
  { name: "write", inputSchema: { type: "object" } },
  { name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "blocked", inputSchema: { type: "object" } },
];
const pinnedRun: AgentMcpPolicy = { default: "ask", tools: {
  write: { mode: "run", definition: createHash("sha256").update(JSON.stringify(tools[0])).digest("hex") },
  blocked: { mode: "disabled" },
} };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture(writerScope = false) {
  const notify = vi.fn(async (_run: string, _event: { approvalId: string }) => {});
  const settled = vi.fn(async () => {});
  const credential = { url: "http://unrelated.invalid/mcp", token: "test-only-token", expiresAt: "2099-01-01T00:00:00Z" };
  const mint = vi.fn(async () => credential);
  const authority = { mcp: mint } as unknown as ProviderAuthority;
  const mcp = new ProviderMcp(authority, () => "http://provider.invalid", notify, settled, undefined, writerScope), runs = new Set<string>();
  cleanups.push(() => { for (const run of runs) mcp.close(run); });
  const configure = async (run: string, targets: NonNullable<AgentMcpSelection["targets"]>, autonomous = false) => {
    runs.add(run);
    const configured = await mcp.configure(run, "original-admission", { targets }, autonomous);
    return Object.keys(configured.servers);
  };
  const catalog = (key: string, value = target) => mcp.policy.catalog(key, mcpTargetKey(value), tools);
  const mode = (key: string, tool: string, value = target) => mcp.policy.mode(key, mcpTargetKey(value), tool);
  const authorize = (run: string, key: string, tool = "write") => mcp.policy.authorize(run, key, mcpTargetKey(target), randomUUID(), tool, {}, new AbortController().signal);
  return { mcp, mint, credential, notify, settled, configure, catalog, mode, authorize };
}

it("replaces removed Run and Disabled exceptions with Ask and invalidates an issued automatic dispatch", async () => {
  const f = fixture(), run = randomUUID(), [key] = await f.configure(run, [{ target, policy: pinnedRun }]);
  expect((await f.catalog(key!)).map(tool => tool.name)).toEqual(["write", "read"]);
  expect(await f.mode(key!, "write")).toBe("run"); expect(await f.mode(key!, "blocked")).toBe("disabled");
  const oldDispatch = await f.authorize(run, key!);
  await f.configure(run, [{ target, policy: { default: "ask" } }]);
  expect((await f.catalog(key!)).map(tool => tool.name)).toEqual(["write", "read", "blocked"]);
  expect(await f.mode(key!, "write")).toBe("ask"); expect(await f.mode(key!, "blocked")).toBe("ask");
  await expect(oldDispatch()).rejects.toThrow("Tool policy changed");
  const pending = f.authorize(run, key!);
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalledOnce());
  expect(f.mcp.resolve(run, f.notify.mock.calls[0]![1].approvalId, true)).toBe(true);
  await (await pending)();
  expect(f.settled).toHaveBeenLastCalledWith(run, expect.any(String), expect.any(String), true, false);
});

it("preserves explicit Ask in Autonomous mode and refuses an unpinned Run replacement", async () => {
  const f = fixture(), run = randomUUID(), [key] = await f.configure(run, [{ target, policy: pinnedRun }]);
  await f.catalog(key!);
  await f.configure(run, [{ target, policy: { default: "run", tools: { write: { mode: "ask" }, read: { mode: "run" } } } }], true);
  await f.catalog(key!);
  expect(await f.mode(key!, "write")).toBe("ask"); expect(await f.mode(key!, "read")).toBe("ask");
  const pending = f.authorize(run, key!);
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalledOnce());
  f.mcp.resolve(run, f.notify.mock.calls[0]![1].approvalId, true);
  await (await pending)();
  expect(f.settled).toHaveBeenLastCalledWith(run, expect.any(String), expect.any(String), true, false);
});

it("replaces read-only automatic grants and migration state when a target is updated or reselected", async () => {
  const f = fixture(), run = randomUUID(), [key] = await f.configure(run, [{ target, policy: { default: "ask", autoAllowReadOnly: true } }]);
  await f.catalog(key!); expect(await f.mode(key!, "read")).toBe("run");
  await f.configure(run, [{ target }]);
  await f.catalog(key!); expect(await f.mode(key!, "read")).toBe("ask");
  await f.configure(run, [{ target, policy: { default: "ask", autoAllowReadOnly: true } }]);
  await f.catalog(key!); expect(await f.mode(key!, "read")).toBe("run");
  await f.configure(run, []);
  await f.configure(run, [{ target }]);
  await f.catalog(key!); expect(await f.mode(key!, "read")).toBe("ask");
});

it("isolates replacement by target and run and does not restore exceptions after close", async () => {
  const f = fixture(), run = randomUUID(), otherRun = randomUUID();
  const [key, otherKey] = await f.configure(run, [{ target, policy: pinnedRun }, { target: other, policy: { default: "run" } }]);
  const [otherRunKey] = await f.configure(otherRun, [{ target, policy: pinnedRun }]);
  await f.catalog(key!); await f.catalog(otherKey!, other); await f.catalog(otherRunKey!);
  await f.configure(run, [{ target }, { target: other, policy: { default: "run" } }]);
  expect(await f.mode(key!, "write")).toBe("ask");
  expect(await f.mode(otherKey!, "write", other)).toBe("run");
  expect(await f.mode(otherRunKey!, "write")).toBe("run");
  expect(await f.mode(otherRunKey!, "blocked")).toBe("disabled");
  f.mcp.close(otherRun);
  await f.configure(otherRun, [{ target }]); await f.catalog(otherRunKey!);
  expect(await f.mode(otherRunKey!, "write")).toBe("ask"); expect(await f.mode(otherRunKey!, "blocked")).toBe("ask");
});

it("preserves the accepted policy and routes when preparing a replacement target fails", async () => {
  const f = fixture(), run = randomUUID(), [key] = await f.configure(run, [{ target, policy: pinnedRun }]);
  await f.catalog(key!);
  f.mint.mockResolvedValueOnce(f.credential).mockRejectedValueOnce(new Error("Admission expired"));
  await expect(f.configure(run, [{ target }, { target: other }])).rejects.toThrow("Admission expired");
  expect(await f.mode(key!, "write")).toBe("run"); expect(await f.mode(key!, "blocked")).toBe("disabled");
  expect(f.mcp.proxy.allowedTool!(run, key!, "write")).toBe(true);
});

it("retains the latest policy of another run while credential preparation is pending", async () => {
  const f = fixture(), run = randomUUID(), otherRun = randomUUID();
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  f.mint.mockImplementationOnce(async () => { await ready; return f.credential; });
  const pending = f.configure(run, [{ target }]);
  const [otherKey] = await f.configure(otherRun, [{ target, policy: pinnedRun }]); await f.catalog(otherKey!);
  release(); const [key] = await pending; await f.catalog(key!);
  expect(await f.mode(key!, "write")).toBe("ask");
  expect(await f.mode(otherKey!, "write")).toBe("run"); expect(await f.mode(otherKey!, "blocked")).toBe("disabled");
});

it("preserves an existing manual Ask for an unchanged target and tool definition", async () => {
  const f = fixture(), run = randomUUID(), [key] = await f.configure(run, [{ target }]); await f.catalog(key!);
  const pending = f.authorize(run, key!);
  await vi.waitFor(() => expect(f.notify).toHaveBeenCalledOnce());
  await f.configure(run, [{ target, policy: { default: "ask", tools: { write: { mode: "ask" } } } }]);
  expect(f.mcp.resolve(run, f.notify.mock.calls[0]![1].approvalId, true)).toBe(true);
  await (await pending)();
  expect(f.settled).toHaveBeenLastCalledWith(run, expect.any(String), expect.any(String), true, false);
});

it("does not restore removed exceptions through concurrent catalog publication", async () => {
  const f = fixture(), run = randomUUID(), [key] = await f.configure(run, [{ target, policy: pinnedRun }]);
  await f.catalog(key!); expect(await f.mode(key!, "write")).toBe("run");
  const replacement = f.configure(run, [{ target, policy: { default: "ask" } }]);
  const discovery = f.catalog(key!);
  await replacement; await discovery;
  expect(await f.mode(key!, "write")).toBe("ask"); expect(await f.mode(key!, "blocked")).toBe("ask");
});


it("requires an owned writer scope for both Core workspace acquisition tools", async () => {
  for (const writerScope of [false, true]) {
    const f = fixture(writerScope), run = randomUUID();
    const [core, app] = await f.configure(run, [{ target }, { target: other }]);
    for (const tool of ["prepare_workspace", "acquire_workspace_lease"]) {
      expect(f.mcp.proxy.allowedTool!(run, core!, tool)).toBe(writerScope);
      expect(f.mcp.proxy.allowedTool!(run, app!, tool)).toBe(true);
    }
    expect(f.mcp.proxy.allowedTool!(run, core!, "get_workspace_diff")).toBe(true);
  }
});
