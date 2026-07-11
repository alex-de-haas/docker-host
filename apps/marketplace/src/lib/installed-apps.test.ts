import { describe, expect, it } from "vitest";
import { extractAppIds } from "@/lib/installed-apps";

describe("extractAppIds", () => {
  it("returns the app ids from a Core installed-apps response", () => {
    expect(extractAppIds({ appIds: ["com.haas.media-server", "com.haas.torrent-engine"] })).toEqual([
      "com.haas.media-server",
      "com.haas.torrent-engine",
    ]);
  });

  it("drops non-string and empty ids", () => {
    expect(extractAppIds({ appIds: ["com.haas.demo-app", "", 42, null, "com.haas.media-server"] })).toEqual([
      "com.haas.demo-app",
      "com.haas.media-server",
    ]);
  });

  it("returns an empty list for an empty or missing set", () => {
    expect(extractAppIds({ appIds: [] })).toEqual([]);
    expect(extractAppIds({})).toEqual([]);
  });

  it.each([null, "string", [], 42, { appIds: "nope" }])("returns [] for malformed payload %#", value => {
    expect(extractAppIds(value)).toEqual([]);
  });
});
