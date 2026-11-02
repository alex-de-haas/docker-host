import { expect, it } from "vitest";
import { panelArrangement } from "../src/app/shell/chrome/shell-concurrent-panels";

it("clamps independent panels while reserving document space and restores their preferred widths", () => {
  const constrained = panelArrangement(1500, 560, [400, 400, 340]);
  expect(constrained.tabs).toBe(false);
  expect(constrained.widths.every(width => width >= 280)).toBe(true);
  expect(constrained.widths.reduce((a, b) => a + b, 0) + 560 + 36).toBeLessThanOrEqual(1500);
  expect(panelArrangement(2000, 560, [400, 400, 340]).widths).toEqual([400, 400, 340]);
});
it("switches to retained tabs before panels squeeze the document, then stacks on phones", () => {
  expect(panelArrangement(1200, 560, [360, 360, 340])).toMatchObject({ tabs: true, stacked: false });
  expect(panelArrangement(599, 560, [360, 340])).toMatchObject({ tabs: true, stacked: true });
});
