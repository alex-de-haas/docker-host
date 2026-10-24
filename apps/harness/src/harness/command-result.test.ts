import { expect, it } from "vitest";
import { CommandCallHistory, claudeCommandResult, codexCommandResult, commandTestSummary, commandToolUseId, sanitizeCommandResult } from "./command-result.js";

const result = { type: "command_result", toolUseId: "command:fixture:one", status: "completed", exitCode: 0, durationMs: 4200, summary: "14 passed" };
it("projects only safe bounded command result fields and rejects malformed runtime shapes", () => {
  expect(sanitizeCommandResult({ ...result, stdout: "secret", stderr: "secret", output: "secret", token: "secret" })).toEqual(result);
  for (const status of [[], ["completed"], {}, { toString: "secret" }, null, 1, "new-status"])
    expect(sanitizeCommandResult({ ...result, status })).toBeNull();
  for (const toolUseId of ["", "bad\nsecret", "bad token", "a".repeat(257), "../secret"])
    expect(sanitizeCommandResult({ ...result, toolUseId })).toBeNull();
  for (const durationMs of [-1, NaN, Infinity, 0.5, 604800001]) expect(sanitizeCommandResult({ ...result, durationMs })).toBeNull();
  for (const exitCode of [-2147483649, 2147483648, 0.5, NaN]) expect(sanitizeCommandResult({ ...result, exitCode })).toBeNull();
  expect(sanitizeCommandResult({ ...result, exitCode: 4 })).toBeNull();
});
it("permits only canonical numeric summaries without controls, secrets or injected tails", () => {
  for (const summary of ["14 passed", "2 failed", "14 passed · 2 failed"]) expect(sanitizeCommandResult({ ...result, summary })?.summary).toBe(summary);
  for (const summary of ["14 passed\nsecret", "14 passed secret", "token=secret", "\u001b[31m14 passed", "12345678 passed", "14 passed ", "14 passed · 2 failed\n", "Command completed"])
    expect(sanitizeCommandResult({ ...result, summary })?.summary).toBeUndefined();
  expect(sanitizeCommandResult({ ...result, status: "unknown" })?.summary).toBeUndefined();
});
it("extracts count-only summaries from complete known test formats without returning provider text", () => {
  expect(commandTestSummary("secret output\n Tests  14 passed (14)\napi_key=secret")).toBe("14 passed");
  expect(commandTestSummary("Tests 2 failed | 14 passed | 1 skipped (17)")).toBe("14 passed · 2 failed");
  expect(commandTestSummary("Passed!  - Failed: 0, Passed: 42, Skipped: 0, Total: 42, Duration: 12 s - Tests.dll (net10.0)")).toBe("42 passed");
  for (const output of ["secret 14 passed", "Tests 14 passed (15)", "Tests 14 passed (14) token=secret", "Tests 14 passed | 1 passed (15)", "Tests 12345678 passed (12345678)", "x".repeat(131073)])
    expect(commandTestSummary(output)).toBeUndefined();
});
it("scopes factual provider IDs by live run, turn and parent without truncation collisions", () => {
  const id = commandToolUseId("run", 1, "native", "parent");
  expect(id).toMatch(/^command:run:1:[a-f0-9]{64}$/);
  expect(commandToolUseId("run", 1, "native", "parent")).toBe(id);
  expect(new Set([id, commandToolUseId("other", 1, "native", "parent"), commandToolUseId("run", 2, "native", "parent"), commandToolUseId("run", 1, "native", "other")]).size).toBe(4);
  expect(commandToolUseId("run", 1, "bad\nsecret")).toBeUndefined();
});
it("uses only factual Codex exit/duration fields and never guesses absent outcomes", () => {
  expect(codexCommandResult("id", { status: "completed", exitCode: 0, durationMs: 4200, aggregatedOutput: "Tests 14 passed (14)" })).toEqual({ ...result, toolUseId: "id" });
  expect(codexCommandResult("id", { status: "completed", exitCode: 2 })?.status).toBe("failed");
  expect(codexCommandResult("id", { status: "completed", exitCode: null, aggregatedOutput: "Tests 14 passed (14)" })).toEqual({ type: "command_result", toolUseId: "id", status: "unknown" });
  expect(codexCommandResult("id", { status: "new-status", exitCode: null })?.status).toBe("unknown");
  expect(codexCommandResult("id", { status: "declined", exitCode: 0 })).toBeNull();
});
it("maps confirmed foreground Claude BashOutput with optional error flag without inventing code or duration", () => {
  const output = { stdout: "Tests 14 passed (14)", stderr: "private", interrupted: false, durationMs: 5, exitCode: 0 };
  expect(claudeCommandResult("id", {}, output)).toEqual({ type: "command_result", toolUseId: "id", status: "completed", summary: "14 passed" });
  expect(claudeCommandResult("id", { is_error: true }, output)?.status).toBe("failed");
  expect(claudeCommandResult("id", {}, { ...output, interrupted: true })?.status).toBe("cancelled");
  expect(claudeCommandResult("id", {}, { ...output, backgroundTaskId: "background" })?.status).toBe("unknown");
  expect(claudeCommandResult("id", { is_error: true }, undefined)?.status).toBe("unknown");
  expect(claudeCommandResult("id", { is_error: "false" }, output)?.status).toBe("unknown");
});

it("retains bounded conservative replay tombstones without disabling all new commands after 2048 calls", () => {
  const history = new CommandCallHistory();
  expect(history.seenOrRecord("old")).toBe(false);
  let newCalls = 0;
  for (let index = 0; index < 10000; index++) if (!history.seenOrRecord(`command-${index}`)) newCalls++;
  expect(newCalls).toBeGreaterThan(9950);
  expect(history.seenOrRecord("old")).toBe(true);
  for (let index = 0; index < 10000; index++) expect(history.seenOrRecord(`command-${index}`)).toBe(true);
});
