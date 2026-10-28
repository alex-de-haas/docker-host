// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { UsageDetails, usageAmount } from "./provider-usage";
import type { UsageRow } from "@/lib/provider-usage";
const row: UsageRow = { id: "test", group: "test", kind: "quota", label: "Weekly", unit: "percent", used: 120, remaining: 0, limit: 100, observedAt: "2026-10-28T10:00:00Z", resetsAt: "2026-10-29T10:00:00Z" };
afterEach(() => vi.unstubAllGlobals());
it("renders unknown states without a zero or progress bar; retains exceeded and stale data with absolute reset times", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  try {
    await act(async () => root.render(<UsageDetails usage={{ state: "unsupported", rows: [], observedAt: null }} />));
    expect(element.textContent).toContain("does not expose"); expect(element.textContent).not.toContain("remaining");
    expect(element.querySelector('[role="progressbar"]')).toBeNull();
    await act(async () => root.render(<UsageDetails usage={{ state: "available", rows: [row], observedAt: row.observedAt, stale: true }} />));
    expect(element.textContent).toContain("120 / 100"); expect(element.textContent).toContain("may be outdated");
    expect(element.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("100");
    expect(element.querySelector("time")?.getAttribute("datetime")).toBe(row.resetsAt);
    await act(async () => root.render(<UsageDetails usage={{ state: "not_applicable", rows: [], observedAt: null }} />));
    expect(element.textContent).toContain("local provider");
  } finally { await act(async () => root.unmount()); element.remove(); }
});
it("separates purchased money, provider credits and unknown amounts", () => {
  expect(usageAmount({ ...row, unit: "USD", remaining: 0 })).toBe("0 USD remaining");
  expect(usageAmount({ ...row, unit: "credits", remaining: 5 })).toBe("5 credits remaining");
  expect(usageAmount({ ...row, used: undefined, remaining: undefined })).toBe("Amount not reported");
});

it("rejects late HTTP snapshots after a newer streamed sequence and permits a replacement revision", async () => {
  const { newestUsage } = await import("../lib/provider-usage");
  const current = { state: "available" as const, rows: [row], observedAt: row.observedAt, connectionRevision: 1, sequence: 3 };
  expect(newestUsage(current, { ...current, sequence: 2, rows: [] })).toBe(current);
  expect(newestUsage(current, { ...current, connectionRevision: 2, sequence: 1, rows: [] }).rows).toEqual([]);
});
