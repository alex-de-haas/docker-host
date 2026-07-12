import { describe, expect, it } from "vitest";
import { extractRoster } from "./roster";

describe("extractRoster", () => {
  it("parses a well-formed roster payload", () => {
    expect(extractRoster({ apps: [{ id: "a", displayName: "App A" }] })).toEqual([
      { id: "a", displayName: "App A" },
    ]);
  });

  it("falls back displayName to the id when missing/blank", () => {
    expect(extractRoster({ apps: [{ id: "a" }, { id: "b", displayName: "" }] })).toEqual([
      { id: "a", displayName: "a" },
      { id: "b", displayName: "b" },
    ]);
  });

  it("drops entries without a non-empty string id", () => {
    expect(extractRoster({ apps: [{ displayName: "x" }, 5, null, { id: "" }] })).toEqual([]);
  });

  it("returns [] for malformed payloads", () => {
    expect(extractRoster(null)).toEqual([]);
    expect(extractRoster([])).toEqual([]);
    expect(extractRoster({ apps: "nope" })).toEqual([]);
    expect(extractRoster({})).toEqual([]);
  });
});
