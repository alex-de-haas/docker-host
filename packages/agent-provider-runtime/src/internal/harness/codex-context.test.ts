import { expect, it, vi } from "vitest";
import { estimateInstructionSources, readCodexMcpContext } from "./codex-context.js";
import { estimateLocalTokens, MAX_ESTIMATE_BYTES } from "./local-context-estimator.js";
import { LOCAL_BPE_ESTIMATOR, readLocalContextSources } from "./context-sources.js";

const tool = { name: "inspect", description: "Прочитать состояние 🚀", inputSchema: { type: "object", properties: { query: { type: "string" } } }, _meta: { secret: "not measured" } };
const page = (name = "server", tools: Record<string, unknown> = { alias: tool }) => ({ data: [{ name, tools, runtimeStatus: "connected" }] });
it("uses local BPE on Unicode, JSON and special-token-like literal text with explicit size limits", () => {
  expect(estimateLocalTokens("hello world")).toBe(2);
  expect(estimateLocalTokens("")).toBe(0);
  for (const text of ["Привет, мир!", "你好世界 🚀", JSON.stringify(tool), "<|endoftext|>", "x".repeat(1023) + "🚀"]) {
    expect(estimateLocalTokens(text)).toBeGreaterThan(0);
    expect(estimateLocalTokens(text)).toBe(estimateLocalTokens(text));
  }
  expect(estimateLocalTokens("x".repeat(MAX_ESTIMATE_BYTES + 1))).toBeUndefined();
  expect(estimateLocalTokens("🚀".repeat(MAX_ESTIMATE_BYTES / 2))).toBeUndefined();
});
it("keeps proven instruction blocks and treats unmatched legacy snapshots as one operator block", () => {
  const sources = [{ source: "runtime" as const, text: "hello world" }, { source: "operator" as const, text: "Привет" }];
  expect(estimateInstructionSources("hello world\n\nПривет", sources).instructions.map(row => row.source)).toEqual(["runtime", "operator"]);
  expect(estimateInstructionSources("legacy", sources).instructions).toEqual([{ source: "operator", tokens: expect.any(Number) }]);
  expect(estimateInstructionSources("x".repeat(MAX_ESTIMATE_BYTES + 1))).toEqual({ instructions: [], omittedInstructions: 1 });
});
it("paginates, preserves original identities, excludes private fields and never infers loaded state", async () => {
  const request = vi.fn().mockResolvedValueOnce({ ...page("first"), nextCursor: "next" }).mockResolvedValueOnce(page("second"));
  const result = await readCodexMcpContext(request, () => true);
  expect(request.mock.calls[1]![0]).toMatchObject({ cursor: "next", detail: "toolsAndAuthOnly" });
  expect(result.catalog.state).toBe("complete");
  expect(result.mcp?.tools.map(t => [t.server, t.name, t.inclusion])).toEqual([["first", "inspect", "unknown"], ["second", "inspect", "unknown"]]);
  const serialized = JSON.stringify(result);
  for (const hidden of ["not measured", "inputSchema", "Прочитать", "query", "alias"]) expect(serialized).not.toContain(hidden);
});
it("reports failed, partial and bounded catalogs without inventing zero measurements", async () => {
  expect((await readCodexMcpContext(async () => { throw Error("secret endpoint"); }, () => true))).toMatchObject({ catalog: { state: "unavailable" } });
  const failedPage = vi.fn().mockResolvedValueOnce({ ...page(), nextCursor: "a" }).mockRejectedValueOnce(Error("no"));
  expect((await readCodexMcpContext(failedPage, () => true))).toMatchObject({ catalog: { state: "partial" }, mcp: { tools: [expect.anything()] } });
  const repeated = vi.fn().mockResolvedValue({ ...page(), nextCursor: "repeat" });
  const result = await readCodexMcpContext(repeated, () => true);
  expect(repeated).toHaveBeenCalledTimes(2); expect(result.catalog.state).toBe("partial"); expect(result.mcp?.omittedTools).toBe(1);
  const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [String(i), { ...tool, name: `tool${i}` }]));
  const limited = await readCodexMcpContext(async () => page("many", many), () => true);
  expect(limited.mcp?.tools).toHaveLength(256); expect(limited.mcp?.omittedTools).toBe(44); expect(limited.catalog.state).toBe("partial");
  expect((await readCodexMcpContext(async () => ({ data: [{ name: "offline", tools: {}, toolsError: "private failure" }] }), () => true)).catalog.state).toBe("partial");
});
it("stops cancelled collection and omits invalid or oversized definitions", async () => {
  const request = vi.fn().mockResolvedValue(page());
  expect((await readCodexMcpContext(request, () => false)).catalog.state).toBe("unavailable"); expect(request).not.toHaveBeenCalled();
  const result = await readCodexMcpContext(async () => page("server", { a: { ...tool, name: "invalid\nname" }, b: { ...tool, description: "x".repeat(MAX_ESTIMATE_BYTES + 1) } }), () => true);
  expect(result.mcp?.tools).toEqual([]); expect(result.mcp?.omittedTools).toBe(2); expect(result.catalog.state).toBe("partial");
});
it("allowlists local metadata and rejects invalid, duplicate or future measurements", () => {
  const value = { version: 1, method: "local-estimate", estimator: LOCAL_BPE_ESTIMATOR, instructions: [{ source: "operator", tokens: 5, text: "secret" }], omittedInstructions: 0, catalog: { state: "complete", observedAt: "2026-11-04T12:00:00Z", url: "secret" }, secret: true };
  expect(JSON.stringify(readLocalContextSources(value))).not.toContain("secret");
  for (const changed of [{ version: 2 }, { estimator: "unknown" }, { instructions: [...value.instructions, ...value.instructions] }, { instructions: [{ source: "operator", tokens: -1 }] }, { catalog: { state: "complete", observedAt: "bad" } }]) expect(readLocalContextSources({ ...value, ...changed })).toBeUndefined();
});
