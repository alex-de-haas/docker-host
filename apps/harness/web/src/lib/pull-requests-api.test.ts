import { describe, expect, it } from "vitest";
import { checkCounts, checkSummary, compactCi, type PrSummary, type PrChecks } from "./pull-requests-api";

describe("PR check evidence", () => {
  it("does not label a partial zero-count observation as no CI", () => {
    const pr = { checks: { items: [], total: 0, completeness: "partial" }, receipt: { freshness: "fresh" } } as unknown as PrSummary;
    expect(compactCi(pr).label).toBe("CI 0/0+"); expect(compactCi(pr).color).toBe("text-muted-foreground");
  });
  it("keeps neutral, skipped and cancelled distinct from passed", () => {
    const checks: PrChecks = { completeness: "complete", total: 5, items: ["passed", "skipped", "neutral", "cancelled", "running"].map((state, i) => ({ id: String(i), name: "CI", state: state as PrChecks["items"][number]["state"] })) };
    expect(checkCounts(checks)).toMatchObject({ completed: 4, passed: 1, skipped: 1, neutral: 1, cancelled: 1, running: 1 });
    expect(checkSummary(checks)).toContain("1 passed"); expect(checkSummary(checks)).toContain("1 skipped");
  });
  it("does not turn missing or partially loaded checks into success", () => {
    expect(checkSummary({ items: [], total: null, completeness: "unknown" })).toBe("CI unknown");
    expect(checkSummary({ items: [], total: 12, completeness: "partial" })).toContain("0/12 completed");
    expect(checkSummary({ items: [], total: 0, completeness: "complete" })).toBe("No checks reported");
  });
});

it.each(["merged", "closed"])("labels cached %s inbox checks as last observed while keeping stale evidence neutral", state => {
  const pr = { state, checks: { items: [{ id: "ci", name: "CI", state: "passed" }], total: 1, completeness: "complete" }, receipt: { freshness: "stale" } } as PrSummary;
  expect(compactCi(pr)).toEqual({ label: "CI last observed", stale: true, color: "text-muted-foreground" });
  expect(compactCi({ ...pr, state: "open" }).label).toBe("CI outdated");
  expect(compactCi({ ...pr, receipt: { ...pr.receipt, freshness: "fresh" } })).toMatchObject({ label: "CI 1/1", stale: false, color: "text-success-foreground" });
});
