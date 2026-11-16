import { describe,it,expect } from "vitest";
import { resolveHarnessKind } from "./config.js";
describe("harness selection", () => {
  it("uses public provider selection while retaining only the hidden in-process test mode", () => {
    expect(resolveHarnessKind("codex")).toBe("agent");
    expect(resolveHarnessKind(" Codex ")).toBe("agent");
    expect(resolveHarnessKind("claude")).toBe("agent");
    expect(resolveHarnessKind("fake")).toBe("fake");
    expect(resolveHarnessKind(undefined)).toBe("agent");
    expect(resolveHarnessKind("gpt-9")).toBe("agent");
  });
});
