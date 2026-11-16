import { describe, expect, it } from "vitest";
import { summarizeProviderUsage } from "./settings-usage.mjs";
const observedAt = "2026-11-04T20:00:00.000Z";
const now = Date.parse(observedAt);
const later = "2026-11-04T21:00:00.000Z";
const row = (overrides = {}) => ({
  id: "account:short",
  group: "account",
  label: "Short window",
  kind: "quota",
  unit: "percent",
  used: 30,
  remaining: 70,
  limit: 100,
  observedAt,
  resetsAt: later,
  ...overrides
});
const usage = (rows, overrides = {}) => ({
  state: "available",
  rows,
  observedAt,
  ...overrides
});
const unknown = (value, at = now, model) => {
  expect(summarizeProviderUsage(value, at, model)).toMatchObject({ remaining: null, reason: expect.any(String) });
};
describe("summarizeProviderUsage", () => {
  it("does not turn absent, unavailable or incomplete observations into a percentage", () => {
    unknown(null);
    for (const state of ["unavailable", "unsupported", "not_applicable"]) unknown(usage([row()], { state }));
    for (const flag of ["stale", "partial", "invalidated"]) unknown(usage([row()], { [flag]: true }));
    unknown(usage([]));
    unknown(usage([row()], { observedAt: null }));
  });
  it("honors the provider's headline rather than a lower unrelated model window", () => {
    const headline = row({ id: "independent:session::", group: "independent:session::", active: true, used: 20, remaining: 80 });
    const unselected = row({ id: "independent:weekly_scoped:Other:", group: "independent:weekly_scoped:Other:", scope: "Other", used: 99, remaining: 1 });
    expect(summarizeProviderUsage(usage([unselected, headline]), now)).toEqual({ remaining: 80, row: headline });
  });
  it("keeps missing or conflicting provider headlines unknown", () => {
    unknown(usage([row({ active: true, used: void 0, remaining: void 0 }), row({ active: false })]));
    unknown(usage([row({ active: true }), row({ id: "other", active: true })]));
    unknown(usage([row({ active: true, kind: "credits", unit: "credits" }), row()]));
  });
  it("excludes inactive windows from a generic account limit", () => {
    const selected = row();
    expect(summarizeProviderUsage(usage([row({ id: "inactive", active: false, used: 99, remaining: 1 }), selected]), now)).toEqual({ remaining: 70, row: selected });
    unknown(usage([row({ active: false })]));
  });
  it("does not combine unrelated or scoped generic limits", () => {
    unknown(usage([row(), row({ group: "other-account" })]));
    unknown(usage([row({ scope: "display model" })]), now, "display model");
  });
  it.each(["requests", "tokens"])("compares %s quota and rate windows by their reported limit", (unit) => {
    const short = row({ unit, kind: "rate_limit", used: 20, remaining: void 0, limit: 50 });
    const long = row({ id: "long", unit, used: void 0, remaining: 5, limit: 20 });
    expect(summarizeProviderUsage(usage([short, long]), now)).toEqual({ remaining: 25, row: long });
  });
  it("supports a percentage without a separate total and a numeric total without a named unit", () => {
    const percent = row({ unit: "percent", used: 12.5, remaining: void 0, limit: void 0 });
    expect(summarizeProviderUsage(usage([percent]), now)).toEqual({ remaining: 87.5, row: percent });
    const count = row({ unit: void 0, used: void 0, remaining: 1, limit: 4 });
    expect(summarizeProviderUsage(usage([count]), now)).toEqual({ remaining: 25, row: count });
  });
  it("requires a percentage for every applicable window instead of overstating the available quota", () => {
    unknown(usage([row(), row({ id: "missing", used: void 0, remaining: void 0 })]));
    unknown(usage([row({ unit: "tokens", used: void 0, remaining: 200, limit: void 0 })]));
  });
  it("ignores balances, monetary amounts, disabled and unlimited rows", () => {
    const selected = row();
    const excluded = [
      row({ id: "credits", kind: "credits", unit: "credits", remaining: 0 }),
      row({ id: "money", unit: "minor_currency", remaining: 0 }),
      row({ id: "usd", unit: "USD", remaining: 0 }),
      row({ id: "currency", currency: "EUR", remaining: 0 }),
      row({ id: "disabled", enabled: false, remaining: 0 }),
      row({ id: "unlimited", unlimited: true, remaining: 0 })
    ];
    expect(summarizeProviderUsage(usage([selected, ...excluded]), now)).toEqual({ remaining: 70, row: selected });
    unknown(usage(excluded));
  });
  it("checks each numeric observation's freshness even when the top-level snapshot was refreshed", () => {
    unknown(usage([row({ observedAt: new Date(now - 120001).toISOString() })]));
    unknown(usage([row()], { observedAt: new Date(now - 120001).toISOString() }));
    unknown(usage([row({ observedAt: "invalid" })]));
    expect(summarizeProviderUsage(usage([row()]), now + 12e4).remaining).toBe(70);
    expect(summarizeProviderUsage(usage([row()]), now - 1e3).remaining).toBe(70);
  });
  it("does not assume quota restored after its reset or use an invalid reset", () => {
    for (const resetsAt of [observedAt, new Date(now - 1).toISOString(), "invalid"]) unknown(usage([row({ resetsAt })]));
    unknown(usage([row(), row({ id: "elapsed", resetsAt: observedAt, used: 100, remaining: 0 })]));
    expect(summarizeProviderUsage(usage([row({ resetsAt: void 0 })]), now).remaining).toBe(70);
  });
  it("keeps zero remaining valid and bounds exceeded and fully available quotas", () => {
    expect(summarizeProviderUsage(usage([row({ used: 100, remaining: 0 })]), now).remaining).toBe(0);
    expect(summarizeProviderUsage(usage([row({ used: 150, remaining: 0 })]), now).remaining).toBe(0);
    expect(summarizeProviderUsage(usage([row({ used: 0, remaining: 100 })]), now).remaining).toBe(100);
    expect(summarizeProviderUsage(usage([row({ used: void 0, remaining: 150 })]), now).remaining).toBe(100);
    expect(summarizeProviderUsage(usage([row({ unit: "requests", used: Number.MAX_VALUE, remaining: void 0, limit: Number.MIN_VALUE })]), now).remaining).toBe(0);
    expect(summarizeProviderUsage(usage([row({ unit: "requests", used: void 0, remaining: Number.MAX_VALUE, limit: Number.MIN_VALUE })]), now).remaining).toBe(100);
  });
  it("rejects malformed numeric observations", () => {
    for (const overrides of [
      { used: NaN },
      { remaining: Infinity },
      { used: -1 },
      { remaining: -1 },
      { limit: 0 },
      { limit: -1 }
    ]) unknown(usage([row(overrides)]));
    unknown(usage([row()]), NaN);
  });
  it("does not mutate retained provider observations and resolves ties in provider order", () => {
    const first = row(), second = row({ id: "same-remaining" });
    const value = usage([first, second]);
    const before = JSON.stringify(value);
    expect(summarizeProviderUsage(value, now)).toEqual({ remaining: 70, row: first });
    expect(JSON.stringify(value)).toBe(before);
  });
});
