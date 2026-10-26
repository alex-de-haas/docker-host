import { expect, it } from "vitest";
import { MAX_TOOL_OUTPUT_CHARS, sanitizeToolResult, shouldRetainToolOutput, toolResult } from "./tool-result.js";

const result = { type: "tool_result", toolUseId: "command:run:1", status: "completed", output: "hello" } as const;
it("retains explicit tool text and empty output while dropping event/envelope metadata", () => {
  expect(sanitizeToolResult({ ...result, headers: { authorization: "transport-secret" }, credential: "transport-secret", _meta: "secret" })).toEqual(result);
  expect(toolResult("id", "unknown", "")).toEqual({ type: "tool_result", toolUseId: "id", status: "unknown", output: "" });
  expect(toolResult("id", "completed", [{ type: "text", text: "first" }, { type: "text", text: "second" }]).output).toBe("first\nsecond");
  expect(toolResult("id", "completed", []).output).toBe("");
  expect(toolResult("id", "completed", { value: 42, nested: { ready: true } }).output).toBe('{\n  "value": 42,\n  "nested": {\n    "ready": true\n  }\n}');
});
it("bounds both provider rendering and untrusted retained strings without hiding truncation", () => {
  const text = "a".repeat(MAX_TOOL_OUTPUT_CHARS + 1);
  expect(toolResult("id", "failed", text)).toEqual({ type: "tool_result", toolUseId: "id", status: "failed", output: text.slice(0, MAX_TOOL_OUTPUT_CHARS), truncated: true });
  expect(sanitizeToolResult({ ...result, output: text })).toEqual({ ...result, output: text.slice(0, MAX_TOOL_OUTPUT_CHARS), truncated: true });
  const structured = toolResult("id", "completed", { output: text, later: "not-retained" });
  expect(structured.output).toHaveLength(MAX_TOOL_OUTPUT_CHARS); expect(structured.truncated).toBe(true);
  expect(structured.output).not.toContain("not-retained");
  expect(toolResult("id", "completed", "a".repeat(MAX_TOOL_OUTPUT_CHARS)).truncated).toBeUndefined();
});
it("keeps clipped Unicode code points intact without changing untruncated text", () => {
  const prefix = "a".repeat(MAX_TOOL_OUTPUT_CHARS - 1), text = prefix + "🙂tail";
  expect(toolResult("id", "completed", text)).toEqual({ type: "tool_result", toolUseId: "id", status: "completed", output: prefix, truncated: true });
  expect(sanitizeToolResult({ ...result, output: text })).toEqual({ ...result, output: prefix, truncated: true });
  const exact = "a".repeat(MAX_TOOL_OUTPUT_CHARS - 2) + "🙂";
  expect(toolResult("id", "completed", exact)).toEqual({ type: "tool_result", toolUseId: "id", status: "completed", output: exact });
  expect(sanitizeToolResult({ ...result, output: exact })).toEqual({ ...result, output: exact });
  const original = "a".repeat(MAX_TOOL_OUTPUT_CHARS - 1) + String.fromCharCode(0xD83D);
  expect(toolResult("id", "completed", original).output).toBe(original);
  expect(sanitizeToolResult({ ...result, output: original })?.output).toBe(original);
});
it("omits binary blocks and resource blobs with explicit readable placeholders", () => {
  const content = [{ type: "text", text: "normal output" }, { type: "image", data: "image-base64-secret" },
    { type: "audio", data: "audio-base64-secret" }, { type: "resource", resource: { uri: "test://file", blob: "blob-secret" } },
    { type: "resource", resource: { text: "text resource" } }];
  const output = toolResult("id", "completed", content).output;
  expect(output).toBe("normal output\n[Image content omitted]\n[Audio content omitted]\n[Binary resource content omitted]\ntext resource");
  expect(output).not.toContain("secret");
  const nested = toolResult("id", "completed", { content, structuredContent: { bytes: new Uint8Array([42, 17]), _meta: { credential: "metadata-secret" } }, _meta: "metadata-secret" }).output;
  expect(nested).not.toContain("base64-secret"); expect(nested).not.toContain("blob-secret");
  expect(nested).toContain("[Binary content omitted]"); expect(nested).not.toContain("metadata-secret");
});
it("rejects unsafe correlation identities and invalid runtime event shapes", () => {
  for (const toolUseId of ["", "bad id", "bad\nid", "../file", "a".repeat(257), null]) {
    expect(sanitizeToolResult({ ...result, toolUseId })).toBeNull();
    expect(() => toolResult(toolUseId as string, "completed", "text")).toThrow(TypeError);
  }
  for (const altered of [{ status: "new" }, { status: ["completed"] }, { output: { text: "wrong" } }, { truncated: false }, { truncated: "yes" }, { type: "result" }])
    expect(sanitizeToolResult({ ...result, ...altered })).toBeNull();
});
it("renders cyclic and excessively nested structured output without throwing", () => {
  const cyclic: Record<string, unknown> = { message: "readable" }; cyclic.self = cyclic;
  expect(toolResult("id", "unknown", cyclic).output).toContain("[Circular reference]");
  let nested: unknown = 1; for (let index = 0; index < 1000; index++) nested = { value: nested };
  const rendered = toolResult("id", "completed", nested);
  expect(rendered.output).toContain("[Maximum nesting depth reached]"); expect(rendered.output.length).toBeLessThan(MAX_TOOL_OUTPUT_CHARS);
});
it("excludes hidden routing, private operator answers and setup results", () => {
  for (const name of ["ToolSearch", "AskUserQuestion", "hosty:development: environment_setup", "mcp__hosty-workspaces__environment_setup"])
    expect(shouldRetainToolOutput(name)).toBe(false);
  for (const name of ["Bash", "Read", "mcp__hosty-core__list_apps", "custom: environment_status"])
    expect(shouldRetainToolOutput(name)).toBe(true);
});

it("retains bounded producer durations and ignores malformed optional timing without hiding failures", () => {
  for (const durationMs of [0, 1250, 604_800_000]) {
    expect(sanitizeToolResult({ ...result, durationMs })).toEqual({ ...result, durationMs });
    expect(toolResult("id", "failed", "failure", durationMs)).toMatchObject({ status: "failed", durationMs });
  }
  for (const durationMs of [null, "12", -1, 1.5, NaN, Infinity, 604_800_001]) {
    expect(sanitizeToolResult({ ...result, durationMs })).toEqual(result);
    expect(toolResult("id", "failed", "failure", durationMs)).not.toHaveProperty("durationMs");
  }
});
