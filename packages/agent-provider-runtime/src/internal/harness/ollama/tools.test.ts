import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { OllamaMcp } from "./tools.js";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  vi.spyOn(Client.prototype, "connect").mockResolvedValue();
  const close = vi.spyOn(Client.prototype, "close").mockResolvedValue();
  const list = vi.spyOn(Client.prototype, "listTools");
  return { list, close };
}
const definition = (index: number) => ({
  name: `tool_${index}`,
  description: `Catalog tool ${index}`,
  inputSchema: { type: "object" as const, properties: {} },
});
const servers = { fixture: { url: "http://fixture/mcp" } };

it("loads tools beyond 128 across MCP pages and servers", async () => {
  const { list, close } = fixture();
  list.mockResolvedValueOnce({ tools: Array.from({ length: 128 }, (_, i) => definition(i)), nextCursor: "next" });
  list.mockResolvedValueOnce({ tools: [definition(128)] });
  list.mockResolvedValueOnce({ tools: [definition(129)] });
  const catalog = new OllamaMcp();
  try {
    await catalog.load({ ...servers, second: { url: "http://second/mcp" } }, new AbortController().signal);
    expect(catalog.tools).toHaveLength(130);
    expect(list.mock.calls.map(([params]) => params)).toEqual([{}, { cursor: "next" }, {}]);
    expect(catalog.bindings.get(catalog.tools[128]!.function.name)?.name).toBe("tool_128");
    expect(catalog.bindings.get(catalog.tools[129]!.function.name)?.server).toBe("second");
  } finally {
    await catalog.close();
  }
  expect(close).toHaveBeenCalledTimes(2);
  expect(catalog.tools).toEqual([]);
  expect(catalog.bindings.size).toBe(0);
});

it("bounds aggregate catalog bytes even when individual schemas fit", async () => {
  const { list } = fixture();
  const tools = Array.from({ length: 100 }, (_, i) => ({
    ...definition(i), description: "я".repeat(90_000),
  }));
  list.mockResolvedValueOnce({ tools: tools.slice(0, 50) });
  list.mockResolvedValueOnce({ tools: tools.slice(50) });
  const catalog = new OllamaMcp();
  try {
    await expect(catalog.load({ ...servers, second: { url: "http://second/mcp" } }, new AbortController().signal)).rejects.toThrow("MCP tool catalog exceeds its size limit");
  } finally {
    await catalog.close();
  }
});

it("retains individual schema and repeated-cursor guards", async () => {
  const { list } = fixture();
  const catalog = new OllamaMcp();
  try {
    list.mockResolvedValueOnce({ tools: [{ ...definition(0), inputSchema: {
      type: "object", description: "x".repeat(32_001),
    } }] });
    await expect(catalog.load(servers, new AbortController().signal)).rejects.toThrow("MCP tool schema exceeds its limit");
    list.mockResolvedValue({ tools: [], nextCursor: "same" });
    await expect(catalog.load(servers, new AbortController().signal)).rejects.toThrow("MCP catalog repeated its cursor");
  } finally {
    await catalog.close();
  }
});

it("still validates remote tool arguments", async () => {
  const { list } = fixture();
  list.mockResolvedValue({ tools: [{ ...definition(0), inputSchema: {
    type: "object", properties: { count: { type: "integer" } }, required: ["count"],
  } }] });
  const catalog = new OllamaMcp();
  try {
    await catalog.load(servers, new AbortController().signal);
    const remote = catalog.bindings.get(catalog.tools[0]!.function.name)!;
    expect(remote.validate({ count: 1 })).toBe(true);
    expect(remote.validate({ count: "invalid" })).toBe(false);
  } finally { await catalog.close(); }
});


it("bounds the tool count without silently truncating the catalog", async () => {
  const { list } = fixture();
  list.mockResolvedValue({ tools: Array.from({ length: 4097 }, (_, i) => definition(i)) });
  const catalog = new OllamaMcp();
  try {
    await expect(catalog.load(servers, new AbortController().signal)).rejects.toThrow("4096-tool limit");
    expect(catalog.tools).toHaveLength(4096);
  } finally { await catalog.close(); }
});

it("resets the byte budget when reloading the authorized catalog", async () => {
  const { list } = fixture();
  list.mockResolvedValue({ tools: [{ ...definition(0), description: "x".repeat(9 * 1024 * 1024) }] });
  const catalog = new OllamaMcp();
  try {
    await catalog.load(servers, new AbortController().signal);
    await catalog.load(servers, new AbortController().signal);
    expect(catalog.tools).toHaveLength(1);
  } finally { await catalog.close(); }
});
