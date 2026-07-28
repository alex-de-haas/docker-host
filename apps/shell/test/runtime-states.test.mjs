import assert from "node:assert/strict";
import test from "node:test";
import { isAppBusy, isAppIdle, isAppUp } from "../src/app/shell/runtime-states.ts";

test("isAppUp admits only a fully started app", () => {
  assert.equal(isAppUp("running"), true);
  for (const state of ["starting", "stopping", "stopped", "unknown", undefined, null]) {
    assert.equal(isAppUp(state), false, `isAppUp(${state})`);
  }
});

test("isAppBusy admits exactly the transitional states", () => {
  assert.equal(isAppBusy("starting"), true);
  assert.equal(isAppBusy("stopping"), true);
  for (const state of ["running", "stopped", "unknown", undefined, null]) {
    assert.equal(isAppBusy(state), false, `isAppBusy(${state})`);
  }
});

test("isAppIdle is narrower than the negation of isAppUp", () => {
  // The whole reason these are three predicates and not one boolean: a destructive action gated on
  // "not running" would also fire while the app is still shutting down.
  assert.equal(isAppIdle("stopped"), true);
  assert.equal(isAppUp("stopping"), false);
  assert.equal(isAppIdle("stopping"), false);
  assert.equal(isAppIdle("starting"), false);
  assert.equal(isAppIdle("unknown"), false);
});

test("the three predicates are mutually exclusive", () => {
  for (const state of ["running", "starting", "stopping", "stopped", "unknown"]) {
    const matches = [isAppUp(state), isAppBusy(state), isAppIdle(state)].filter(Boolean).length;
    assert.ok(matches <= 1, `${state} matched ${matches} predicates`);
  }
});
