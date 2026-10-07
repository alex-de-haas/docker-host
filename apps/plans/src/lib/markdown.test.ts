import { describe, expect, it } from "vitest";
import { markdownTarget } from "./markdown";
describe("safe document navigation", () => {
  const from = "docs/features/example/plan.md";
  it("opens same-repository Markdown docs and renders other relative targets as paths", () => {
    expect(markdownTarget(from, "../other/feature.md#tests")).toMatchObject({ kind: "document", path: "docs/features/other/feature.md" });
    expect(markdownTarget(from, "../../../apps/core/file.cs")).toEqual({ kind: "text", value: "apps/core/file.cs" });
    expect(markdownTarget(from, "diagram.png")).toEqual({ kind: "text", value: "docs/features/example/diagram.png" });
    expect(markdownTarget(from, "../../../../outside.md").kind).toBe("text");
    expect(markdownTarget(from, "/api/secret.md").kind).toBe("text");
  });
  it("allows safe HTTP links and anchors and refuses executable/credentialed schemes", () => {
    expect(markdownTarget(from, "https://example.org/docs").kind).toBe("external");
    expect(markdownTarget(from, "#deliverables").kind).toBe("anchor");
    for (const value of ["javascript:alert(1)", "data:text/html,bad", "https://user:secret@example.org", "//example.org/tracker"]) expect(markdownTarget(from, value).kind).toBe("text");
  });
});
