import { describe, expect, it } from "vitest";
import { claudeUsage, codexUsage } from "./internal/harness/provider-usage.ts";
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
    const headline = row({ id: "claude:session::", group: "claude:session::", active: true, used: 20, remaining: 80 });
    const unselected = row({ id: "claude:weekly_scoped:Other:", group: "claude:weekly_scoped:Other:", scope: "Other", used: 99, remaining: 1 });
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
  it("takes the limiting window within a sole Codex bucket, ignoring credits", () => {
    const value = codexUsage({ rateLimitsByLimitId: { account: {
      primary: { usedPercent: 25, windowDurationMins: 300 },
      secondary: { usedPercent: 70, windowDurationMins: 10080 },
      credits: { balance: "0", hasCredits: false }
    } } }, false, observedAt);
    expect(summarizeProviderUsage(value, now)).toEqual({ remaining: 30, row: value.rows[1] });
  });
  it("selects only an exact canonical Codex model scope", () => {
    const value = codexUsage({ rateLimitsByLimitId: {
      selected: { normalModelSlug: "canonical-model", primary: { usedPercent: 20 } },
      other: { normalModelSlug: "other-model", primary: { usedPercent: 95 } }
    } }, false, observedAt);
    expect(summarizeProviderUsage(value, now, "canonical-model")).toEqual({ remaining: 80, row: value.rows[0] });
    unknown(value);
    unknown(value, now, "Canonical Model");
    unknown(value, now, "canonical-model ");
    unknown(value, now, "default");
  });
  it("does not invent a global Codex bucket or combine ambiguous account buckets", () => {
    const scoped = row({ id: "scoped", group: "codex:model", scope: "selected" });
    const unscoped = row({ group: "codex:account" });
    unknown(usage([scoped, unscoped]), now, "selected");
    unknown(usage([unscoped, row({ group: "codex:other" })]));
    unknown(usage([scoped, row({ ...scoped, id: "inconsistent", scope: "other" })]), now, "selected");
    expect(summarizeProviderUsage(usage([scoped, unscoped]), now, "different")).toEqual({ remaining: 70, row: unscoped });
  });
  it("uses Claude's known account-wide windows without guessing model or OAuth applicability", () => {
    const value = claudeUsage({ rate_limits: {
      five_hour: { utilization: 20 },
      seven_day: { utilization: 50 },
      seven_day_oauth_apps: { utilization: 99 },
      seven_day_opus: { utilization: 98 },
      seven_day_sonnet: { utilization: 97 },
      model_scoped: [{ display_name: "Selected Model", utilization: 96 }]
    } }, observedAt);
    expect(summarizeProviderUsage(value, now, "Selected Model")).toEqual({ remaining: 50, row: value.rows[1] });
    unknown(claudeUsage({ rate_limits: { seven_day_opus: { utilization: 10 }, model_scoped: [{ display_name: "Selected Model", utilization: 20 }] } }, observedAt), now, "Selected Model");
  });
  it("keeps unknown Claude window kinds ambiguous unless the provider selects a headline", () => {
    unknown(usage([row({ group: "claude:five_hour" }), row({ group: "claude:new_meter::" })]));
    const headline = row({ group: "claude:new_meter:Display model:", scope: "Display model", active: true, used: 90, remaining: 10 });
    expect(summarizeProviderUsage(usage([headline]), now)).toEqual({ remaining: 10, row: headline });
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
