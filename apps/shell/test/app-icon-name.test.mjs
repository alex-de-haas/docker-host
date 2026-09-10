import assert from "node:assert/strict";
import test from "node:test";
import { createAppIconNameResolver } from "../src/app/shell/app-icon-name.ts";

const resolve = createAppIconNameResolver(["bar-chart", "bar-chart-3", "cpu", "chart-no-axes-column-increasing"]);
for (const [input, expected] of [["BarChart", "bar-chart"], ["barChart", "bar-chart"], ["bar-chart", "bar-chart"], ["BarChart3", "bar-chart-3"], ["CPU", "cpu"], [" ChartNoAxesColumnIncreasing ", "chart-no-axes-column-increasing"], ["UnknownIcon", null], ["", null], [null, null]]) {
  test(`manifest icon ${JSON.stringify(input)} resolves to ${expected}`, () => assert.equal(resolve(input), expected));
}
