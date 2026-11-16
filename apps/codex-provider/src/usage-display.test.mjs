import { describe, expect, it } from "vitest";
import { codexUsage } from "./adapter/provider-usage.js";
import { codexSettings } from "./connections.js";
import { summarizeProviderUsage as runtimeSummary } from "../../../packages/agent-provider-runtime/src/settings-usage.mjs";
const summarizeProviderUsage = (value, now, model) => runtimeSummary(value, now, model, codexSettings.usage);
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

});
