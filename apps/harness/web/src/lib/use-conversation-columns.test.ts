import { describe, expect, it } from "vitest";
import { COLUMN_DEFAULTS, fitConversationColumns, readColumnWidths } from "./use-conversation-columns";

describe("conversation column sizing", () => {
  it("keeps space for chat and restores preferred widths after a narrower surface", () => {
    const preferred = { navigation: 450, details: 500 };
    for (const width of [820, 838, 1000, 1200, 1600]) {
      const fitted = fitConversationColumns(width, preferred, true);
      expect(fitted.navigation).toBeGreaterThanOrEqual(220);
      expect(fitted.details).toBeGreaterThanOrEqual(280);
      expect(width - fitted.navigation - fitted.details).toBeGreaterThanOrEqual(320);
    }
    expect(fitConversationColumns(1600, preferred, true)).toEqual(preferred);
    expect(preferred).toEqual({ navigation: 450, details: 500 });
  });
  it("releases hidden details space without changing its saved width", () => {
    expect(fitConversationColumns(838, { navigation: 450, details: 500 }, false)).toEqual({ navigation: 450, details: 500 });
  });
  it("handles missing, invalid and out-of-range storage", () => {
    for (const value of [null, "broken", "[]", '"text"', '{"navigation":"450","details":null}']) expect(readColumnWidths(value)).toEqual(COLUMN_DEFAULTS);
    expect(readColumnWidths('{"navigation":9999,"details":-1}')).toEqual({ navigation: 480, details: 280 });
  });
});
