import assert from "node:assert/strict";
import test from "node:test";
import { readPanelWidth, panelWidthBounds } from "../src/app/shell/chrome/panel-width.ts";

test("stored widths reject invalid cookies but retain constrained mobile preferences", () => {
  for (const value of [undefined, "", "NaN", "Infinity", "-10", "0", "999999", "360px"]) {
    assert.equal(readPanelWidth(value), 360);
  }
  assert.equal(readPanelWidth("480.4"), 480);
  assert.equal(readPanelWidth("195"), 195);
});

test("desktop panel bounds leave room for the workspace and separator", () => {
  assert.deepEqual(panelWidthBounds(750), { workspaceMin: 224.7, panelMin: 280, panelMax: 524.3 });
  assert.deepEqual(panelWidthBounds(1600), { workspaceMin: 240, panelMin: 280, panelMax: 800 });
});

test("narrow and unmeasured groups never have conflicting constraints", () => {
  for (const width of [0, 1, 240, 300, 420, 600]) {
    const bounds = panelWidthBounds(width);
    assert.ok(bounds.panelMin >= 0);
    assert.ok(bounds.panelMax >= bounds.panelMin);
    assert.ok(bounds.workspaceMin + bounds.panelMax <= Math.max(0, width - 1));
  }
});
