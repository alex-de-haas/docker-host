import { describe, expect, it } from "vitest";
import { claudeUsage } from "./adapter/provider-usage.js";
import { claudeSettings } from "./connections.js";
import { summarizeProviderUsage as runtimeSummary } from "../../../packages/agent-provider-runtime/src/settings-usage.mjs";
const summarizeProviderUsage = (value, now, model) => runtimeSummary(value, now, model, claudeSettings.usage);
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

});
