import { describe, expect, it } from "vitest";
import { extractAppIds, extractUpdateStatus } from "@/lib/installed-apps";

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

describe("extractUpdateStatus", () => {
  it("reads installed/updateAvailable booleans strictly", () => {
    expect(extractUpdateStatus({ appId: "x", installed: true, updateAvailable: true })).toEqual({ installed: true, updateAvailable: true });
    expect(extractUpdateStatus({ installed: true, updateAvailable: false })).toEqual({ installed: true, updateAvailable: false });
    expect(extractUpdateStatus({ installed: false, updateAvailable: false })).toEqual({ installed: false, updateAvailable: false });
  });

  it("treats non-boolean / missing / malformed payloads as not-installed, no-update", () => {
    expect(extractUpdateStatus({ installed: "yes", updateAvailable: 1 })).toEqual({ installed: false, updateAvailable: false });
    expect(extractUpdateStatus({})).toEqual({ installed: false, updateAvailable: false });
    expect(extractUpdateStatus(null)).toEqual({ installed: false, updateAvailable: false });
    expect(extractUpdateStatus("nope")).toEqual({ installed: false, updateAvailable: false });
  });
});
