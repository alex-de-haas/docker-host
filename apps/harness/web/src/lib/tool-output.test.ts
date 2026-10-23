import { expect, it } from "vitest";
import { recordedToolOutput } from "./tool-output";
const result = { seq: 1, ts: "", type: "tool_result", toolUseId: "call", status: "completed", output: "" };
it("keeps empty and bounded recorded output and discards arbitrary envelope fields", () => {
  expect(recordedToolOutput({ ...result, _meta: { token: "secret" } })).toEqual({ status: "completed", output: "" });
  const output = recordedToolOutput({ ...result, output: "a".repeat(32_767) + "😀" });
  expect(output?.output).toHaveLength(32_767); expect(output?.truncated).toBe(true);
});
it("rejects malformed recorded results instead of presenting arbitrary restored payloads", () => {
  for (const invalid of [{ toolUseId: "bad\nid" }, { status: "invented" }, { status: ["completed"] }, { output: {} }, { type: "tool_use" }])
    expect(recordedToolOutput({ ...result, ...invalid })).toBeNull();
});
