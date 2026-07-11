import { describe, expect, it } from "vitest";
import { optionsFromEnvironment } from "@/lib/options";

describe("optionsFromEnvironment", () => {
  it("reads and normalizes the one source setting this app owns", () => {
    expect(optionsFromEnvironment({
      HOSTY_MARKETPLACE_SOURCE_URL: " https://catalog.example/catalog.json ",
    })).toEqual({
      sourceUrl: "https://catalog.example/catalog.json",
    });
  });

  it("does not accept local paths, non-HTTP schemes, or credentials as a source", () => {
    for (const source of ["/tmp/catalog.json", "file:///tmp/catalog.json", "https://u:p@example/catalog.json"]) {
      expect(optionsFromEnvironment({ HOSTY_MARKETPLACE_SOURCE_URL: source }).sourceUrl).toBeNull();
    }
  });
});
