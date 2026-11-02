// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ProviderUsageIndicator, UsageDetails, usageAmount, usageLabel } from "./provider-usage";
import { useProviderUsage, type ProviderUsage, type UsageRow } from "@/lib/provider-usage";
vi.mock("@/lib/provider-usage", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/provider-usage")>(), useProviderUsage: vi.fn() }));
const row: UsageRow = { id: "test", group: "test", kind: "quota", label: "Weekly", unit: "percent", used: 120, remaining: 0, limit: 100, observedAt: "2026-10-28T10:00:00Z", resetsAt: "2026-10-29T10:00:00Z" };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks(); });
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

it("shows a live Codex reset countdown without assuming that an elapsed deadline restores quota", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
  const quota = { ...row, id: "codex:codex:secondary", group: "codex:codex", label: "codex · 7 days", resetsAt: "2026-11-03T10:01:00Z" };
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  try {
    await act(async () => root.render(<UsageDetails usage={{ state: "available", rows: [quota], observedAt: quota.observedAt }} />));
    expect(element.textContent).toContain("codex · Resets in 1 day");
    expect(element.textContent).not.toContain("7 days");
    expect(element.querySelector("time")?.dateTime).toBe(quota.resetsAt);
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(element.textContent).toContain("Resets in 23 hours 59 minutes");
    vi.setSystemTime(new Date("2026-11-03T10:00:30Z"));
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(element.textContent).toContain("Resets in less than a minute");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(element.textContent).toContain("Reset time reached");
    expect(element.textContent).toContain("120 / 100");
    expect(usageLabel({ ...quota, resetsAt: undefined }, Date.now())).toBe(quota.label);
    expect(usageLabel({ ...quota, resetsAt: "invalid" }, Date.now())).toBe(quota.label);
    expect(usageLabel(row, Date.now())).toBe("Weekly");
    expect(usageLabel({ ...quota, label: "Custom · codex · 5 hours", resetsAt: "2026-11-03T12:05:30Z" }, Date.now())).toBe("Custom · codex · Resets in 2 hours 4 minutes");
  } finally { await act(async () => root.unmount()); element.remove(); }
  expect(vi.getTimerCount()).toBe(0);
});
it("hides unsupported/local limits in every surface but retains unknown, unavailable and replacement-account controls", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  const render = async (usage: ProviderUsage | null, revision = 1) => {
    vi.mocked(useProviderUsage).mockReturnValue({ usage, refreshing: false, refresh: vi.fn().mockResolvedValue(undefined) });
    await act(async () => root.render(<ProviderUsageIndicator connectionId="test-connection" revision={revision} />));
  };
  try {
    for (const state of ["unsupported", "not_applicable"] as const) {
      await render({ state, rows: [], observedAt: null, connectionRevision: 1 });
      expect(element.querySelector('button[aria-label="Provider limits"]')).toBeNull();
    }
    for (const usage of [null, { state: "unavailable", rows: [], observedAt: null, connectionRevision: 1 },
      { state: "available", rows: [row], observedAt: row.observedAt, stale: true, connectionRevision: 1 }] as (ProviderUsage | null)[]) {
      await render(usage);
      expect(element.querySelector('button[aria-label="Provider limits"]')).not.toBeNull();
    }
    await render({ state: "unsupported", rows: [], observedAt: null, connectionRevision: 1 }, 2);
    expect(element.querySelector('button[aria-label="Provider limits"]')).not.toBeNull();
  } finally { await act(async () => root.unmount()); element.remove(); }
});
