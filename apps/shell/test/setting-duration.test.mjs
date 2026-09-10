import assert from "node:assert/strict";
import test from "node:test";
import { settingDurationHint, settingUnitLabel } from "../src/app/shell/setting-duration.ts";

test("duration equivalents preserve exact values and stored units", () => {
  assert.equal(settingDurationHint("168", "h"), "168 hours = 7 days");
  assert.equal(settingDurationHint("25", "h"), "25 hours = 1 day 1 hour");
  assert.equal(settingDurationHint("90", "min"), "90 minutes = 1 hour 30 minutes");
  assert.equal(settingDurationHint("1.5", "day"), "1.5 days = 1 day 12 hours");
  assert.equal(settingUnitLabel("min"), "minutes");
  assert.equal(settingUnitLabel("h"), "hours");
});

test("zero, invalid drafts, unknown units and redundant conversions have no hint", () => {
  for (const value of ["", " ", "0", "-1", "oops", "Infinity", "1e30"]) assert.equal(settingDurationHint(value, "h"), null);
  assert.equal(settingDurationHint("10", "day"), null);
  assert.equal(settingDurationHint("12", "h"), null);
  assert.equal(settingDurationHint("7070", null), null);
});
