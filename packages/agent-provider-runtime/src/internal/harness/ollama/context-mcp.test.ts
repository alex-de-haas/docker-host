import { expect, it } from "vitest";
import { ollamaMcpContextDetail } from "./context-mcp.js";
import { readMcpContextDetail } from "../context-mcp.js";
import type { OllamaTool } from "./client.js";

const definition = (name: string, description = "Read 文档 🙂"): OllamaTool => ({
  type: "function", function: { name, description, parameters: { type: "object", properties: { query: { type: "string" } } } },
});
it("counts transformed wire definitions and separates available copies without retaining their content", () => {
  const catalog = [definition("opaque_a", "old description"), definition("opaque_b")];
  const wire = definition("opaque_a");
  const result = ollamaMcpContextDetail(catalog, [definition("read_file"), wire], new Map([
    ["opaque_a", { server: "one", name: "read" }], ["opaque_b", { server: "two", name: "read" }],
  ]));
  expect(result).toMatchObject({ method: "local-estimate", estimator: "utf8-json-div4-v1", omittedTools: 0,
    tools: [{ server: "one", name: "read", inclusion: "loaded" }, { server: "two", name: "read", inclusion: "available" }] });
  expect(result.tools[0]!.tokens).toBe(Math.ceil(new TextEncoder().encode(JSON.stringify(wire)).length / 4));
  expect(result.tools[0]!.tokens).toBeGreaterThan(Math.ceil(JSON.stringify(wire).length / 4));
  expect(JSON.stringify(result)).not.toMatch(/opaque|description|query|文档/);
  expect(readMcpContextDetail(result)).toEqual(result);
  expect(ollamaMcpContextDetail([], [definition("read_file")], new Map()).tools).toEqual([]);
});
it("caps detail and preserves sent tools ahead of available entries", () => {
  const catalog = Array.from({ length: 260 }, (_, i) => definition(`alias${i}`));
  const result = ollamaMcpContextDetail(catalog, [catalog[259]!], new Map(catalog.map((t, i) => [t.function.name, { server: "server", name: `tool${i}` }])));
  expect(result.tools).toHaveLength(256);
  expect(result.omittedTools).toBe(4);
  expect(result.tools[0]).toMatchObject({ name: "tool259", inclusion: "loaded" });
});
it("requires an understood local estimator and preserves only bounded public metadata", () => {
  const detail = { version: 1, method: "local-estimate", tools: [], omittedTools: 0 };
  for (const estimator of [undefined, null, "model-exact", ["utf8-json-div4-v1"]])
    expect(readMcpContextDetail({ ...detail, estimator })).toBeUndefined();
  expect(readMcpContextDetail({ ...detail, estimator: "utf8-json-div4-v1", secret: "never retain" }))
    .toEqual({ ...detail, estimator: "utf8-json-div4-v1" });
});
