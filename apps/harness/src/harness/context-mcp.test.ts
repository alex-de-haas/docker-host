import { expect, it } from "vitest";
import { claudeMcpContextDetail, MAX_CONTEXT_MCP_TOOLS, readMcpContextDetail } from "./context-mcp.js";
import { claudeContextUsage } from "./context-usage.js";

it("attributes equal names to distinct servers, preserves zero and never guesses inclusion", () => {
  const result = claudeMcpContextDetail({ mcpTools: [
    { serverName: "a", name: "read", tokens: 0, isLoaded: true, secret: "never retain" },
    { serverName: "b", name: "read", tokens: 30, isLoaded: false },
    { serverName: "b", name: "write", tokens: 40 },
  ] });
  expect(result).toEqual({ version: 1, method: "provider-estimate", omittedTools: 0, tools: [
    { server: "a", name: "read", tokens: 0, inclusion: "loaded" },
    { server: "b", name: "read", tokens: 30, inclusion: "deferred" },
    { server: "b", name: "write", tokens: 40, inclusion: "unknown" },
  ] });
  expect(readMcpContextDetail(result)).toEqual(result);
});

it("keeps the total when optional diagnostics are absent or invalid; empty is a reported empty list", () => {
  for (const mcpTools of [undefined, null, {}, "broken"])
    expect(claudeContextUsage({ totalTokens: 10, mcpTools })).toMatchObject({ usedTokens: 10 });
  expect(claudeMcpContextDetail({ mcpTools: [] })).toMatchObject({ tools: [], omittedTools: 0 });
  expect(claudeMcpContextDetail({})).toBeUndefined();
  expect(readMcpContextDetail({ version: 2, tools: [] })).toBeUndefined();
});

it("bounds the metadata, drops malformed or duplicate rows and reports partial coverage", () => {
  const valid = { serverName: "a", name: "read", tokens: 100, isLoaded: true };
  const result = claudeMcpContextDetail({ mcpTools: [valid, valid, null,
    { ...valid, name: "bad", tokens: -1 }, { ...valid, name: "x".repeat(257) },
    { ...valid, serverName: "bad\nname" }, { ...valid, name: "float", tokens: 0.5 },
    { ...valid, name: "infinity", tokens: Infinity },
    ...Array.from({ length: MAX_CONTEXT_MCP_TOOLS }, (_, i) => ({ ...valid, name: String(i) })),
  ] });
  expect(result?.tools).toHaveLength(MAX_CONTEXT_MCP_TOOLS - 7);
  expect(result?.omittedTools).toBe(15);
  expect(result?.tools[0]).toEqual({ server: "a", name: "read", tokens: 100, inclusion: "loaded" });
  expect(JSON.stringify(result)).not.toContain("serverName");
});

it("keeps group totals within safe integer precision", () => {
  const result = claudeMcpContextDetail({ mcpTools: [
    { serverName: "a", name: "one", tokens: Number.MAX_SAFE_INTEGER },
    { serverName: "a", name: "two", tokens: 1 },
  ] });
  expect(result).toMatchObject({ omittedTools: 1, tools: [{ name: "one" }] });
});


it("rejects inclusion values that only coerce to an enum string", () => {
  expect(readMcpContextDetail({ version: 1, method: "provider-estimate", omittedTools: 0,
    tools: [{ server: "a", name: "read", tokens: 12, inclusion: ["loaded"] }] }))
    .toEqual({ version: 1, method: "provider-estimate", tools: [], omittedTools: 1 });
});
