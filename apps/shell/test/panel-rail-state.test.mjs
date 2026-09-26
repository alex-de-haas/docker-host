import assert from "node:assert/strict";
import test from "node:test";
import { activatePanel, panelFocusIndex } from "../src/app/shell/surfaces/panel-rail-state.ts";

test("activating icons opens, switches or collapses without losing the selection", () => {
  assert.deepEqual(activatePanel("a", "a", false), { key: "a", expanded: true });
  assert.deepEqual(activatePanel("b", "a", false), { key: "b", expanded: true });
  assert.deepEqual(activatePanel("a", "a", true), { key: "a", expanded: false });
  assert.deepEqual(activatePanel("b", "a", true), { key: "b", expanded: true });
  assert.deepEqual(activatePanel("a", null, false), { key: "a", expanded: true });
});

test("rail focus wraps and supports Home/End without handling activation keys", () => {
  assert.equal(panelFocusIndex("ArrowUp", 0, 3), 2);
  assert.equal(panelFocusIndex("ArrowDown", 2, 3), 0);
  assert.equal(panelFocusIndex("Home", 2, 3), 0);
  assert.equal(panelFocusIndex("End", 0, 3), 2);
  for (const key of ["Enter", " ", "Tab", "ArrowLeft"]) assert.equal(panelFocusIndex(key, 0, 3), null);
  assert.equal(panelFocusIndex("ArrowDown", 0, 0), null);
});
