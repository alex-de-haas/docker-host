import { afterEach, expect, it, vi } from "vitest";
import { absentUsage, claudeLimitEvent, claudeUsage, codexUsage, mergeUsage, UsageReader, type ProviderUsage } from "./provider-usage.js";
afterEach(() => vi.useRealTimers());
it("keeps zero, unknown, exceeded percentages, bucket identity and credit units separate", () => {
  const result = codexUsage({ rateLimits: { primary: { usedPercent: 90 } }, rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1700000000 }, secondary: { usedPercent: 120 }, credits: { balance: "0", hasCredits: false, unlimited: false } },
    fast: { primary: { usedPercent: null }, credits: { balance: "bad", unlimited: true } },
  } });
  expect(result.rows).toHaveLength(5);
  expect(result.rows[0]).toMatchObject({ id: "codex:codex:primary", used: 0, remaining: 100, resetsAt: "2023-11-14T22:13:20.000Z" });
  expect(result.rows[1]).toMatchObject({ used: 120, remaining: 0 });
  expect(result.rows[2]).toMatchObject({ remaining: 0, unit: "credits" });
  expect(result.rows[3]?.used).toBeUndefined();
  expect(result.rows[4]?.remaining).toBeUndefined();
  expect(codexUsage({ rateLimits: { primary: { usedPercent: NaN } } }).rows[0]?.used).toBeUndefined();
});
it("replaces one Codex bucket on update without discarding another model's limits", () => {
  const initial = codexUsage({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 10 }, secondary: { usedPercent: 20 } }, fast: { primary: { usedPercent: 80 } } } });
  const updated = mergeUsage(initial, codexUsage({ rateLimits: { limitId: "codex", primary: { usedPercent: 50 } } }, true));
  expect(updated.rows.map(row => [row.id, row.used])).toEqual([["codex:fast:primary", 80], ["codex:codex:primary", 50]]);
  expect(mergeUsage(updated, absentUsage())).toMatchObject({ stale: true, rows: updated.rows, observedAt: updated.observedAt });
  expect(mergeUsage(updated, { ...absentUsage(), invalidated: true }).rows).toEqual([]);
  expect(mergeUsage(updated, absentUsage("unsupported")).rows).toEqual([]);
});
it("uses Claude getter percentages, ISO resets, monetary minor units and partial event status", () => {
  const full = claudeUsage({ rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 0, resets_at: "2026-10-28T12:00:00Z" }, seven_day: null,
    model_scoped: [{ display_name: "New model", utilization: 55, resets_at: null }],
    extra_usage: { is_enabled: false, monthly_limit: 1000, used_credits: 300, currency: "USD" },
  } });
  expect(full.rows).toHaveLength(3);
  expect(full.rows[0]).toMatchObject({ used: 0, remaining: 100 });
  expect(full.rows[2]).toMatchObject({ used: 300, remaining: 700, unit: "minor_currency", currency: "USD" });
  const event = claudeLimitEvent({ rateLimitType: "five_hour", utilization: .9, status: "rejected" });
  expect(event.rows[0]?.used).toBeUndefined();
  expect(mergeUsage(full, event).rows[0]).toMatchObject({ used: 0, status: "rejected" });
  expect(claudeUsage({ rate_limits_available: false, rate_limits: null }).state).toBe("unavailable");
  expect(claudeUsage({ rate_limits: { five_hour: { utilization: -1 } } }).rows[0]?.used).toBeUndefined();
});
it("preserves provider-selected rows and future model scopes from structured Claude usage reports", () => {
  const result = claudeUsage({ rate_limits: { limits: [{ kind: "weekly_scoped", group: "weekly", percent: 42, resets_at: null,
    scope: { model: { display_name: "New model" } }, severity: "warning", is_active: true }] } });
  expect(result.rows[0]).toMatchObject({ scope: "New model", used: 42, active: true, status: "warning" });
});
it("keeps neutral local and Ollama Cloud credit/window fixtures distinct", () => {
  const local = absentUsage("not_applicable", "local");
  const cloud: ProviderUsage = { state: "available", observedAt: "2026-10-28T10:00:00Z", rows: [
    { id: "ollama:included", group: "ollama:included", kind: "credits", label: "Included", remaining: 2.5, limit: 20, unit: "USD", observedAt: "2026-10-28T10:00:00Z" },
    { id: "ollama:purchased", group: "ollama:purchased", kind: "credits", label: "Purchased", remaining: 0, unit: "USD", observedAt: "2026-10-28T10:00:00Z" },
    { id: "ollama:legacy:session", group: "ollama:legacy:session", kind: "quota", label: "Session", remaining: 25, unit: "percent", observedAt: "2026-10-28T10:00:00Z" },
  ] };
  expect(mergeUsage(cloud, local)).toEqual(local);
  expect(mergeUsage(cloud, { ...cloud, partial: true, rows: [{ ...cloud.rows[1]!, remaining: 5 }] }).rows.map(row => row.remaining)).toEqual([2.5, 5, 25]);
  expect(mergeUsage(cloud, absentUsage()).rows).toEqual(cloud.rows);
});
it("coalesces diagnostics and disables a timed-out native getter without accepting late results", async () => {
  vi.useFakeTimers(); let complete!: (value: ProviderUsage) => void;
  const read = vi.fn(() => new Promise<ProviderUsage>(resolve => { complete = resolve; }));
  const reader = new UsageReader(read, 20);
  const one = reader.refresh(), two = reader.refresh(); expect(one).toBe(two);
  await vi.advanceTimersByTimeAsync(21);
  expect(await one).toMatchObject({ state: "unavailable" });
  complete(codexUsage({ rateLimits: { primary: { usedPercent: 10 } } }));
  expect((await reader.refresh()).state).toBe("unavailable"); expect(read).toHaveBeenCalledTimes(1);
});
