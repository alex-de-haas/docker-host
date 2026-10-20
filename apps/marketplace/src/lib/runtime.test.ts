import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntime, updateMarketplaceSettings } from "./runtime";
const key = Symbol.for("hosty.marketplace.runtime.v2");
const reset = () => { Reflect.deleteProperty(globalThis, key); };
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "hosty-marketplace-settings-"));
  vi.stubEnv("HOSTY_APP_DATA_DIR", directory); vi.stubEnv("HOSTY_MARKETPLACE_SOURCE_URL", "https://legacy.example/catalog.json"); reset();
});
afterEach(() => { reset(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
describe("application-owned catalog settings", () => {
  it("migrates the legacy launch value once and keeps saved preferences across restart", () => {
    expect(getRuntime().options.sourceUrl).toBe("https://legacy.example/catalog.json");
    updateMarketplaceSettings("https://custom.example/catalog.json", "https://legacy.example/catalog.json");
    vi.stubEnv("HOSTY_MARKETPLACE_SOURCE_URL", "https://changed-environment.example/catalog.json"); reset();
    expect(getRuntime().options.sourceUrl).toBe("https://custom.example/catalog.json");
    expect(statSync(join(directory, "settings.json")).mode & 0o777).toBe(0o600);
  });
  it("rejects stale edits and credential-bearing URLs without changing the file or catalog", () => {
    const original = getRuntime(); const bytes = readFileSync(join(directory, "settings.json"), "utf8");
    expect(() => updateMarketplaceSettings("https://new.example/", "https://stale.example/")).toThrow("Settings changed");
    expect(() => updateMarketplaceSettings("https://user:password@example.test/", original.options.sourceUrl!)).toThrow("without credentials");
    expect(readFileSync(join(directory, "settings.json"), "utf8")).toBe(bytes);
    expect(getRuntime()).toBe(original);
  });
  it("does not overwrite damaged persisted settings with defaults", () => {
    writeFileSync(join(directory, "settings.json"), "{damaged");
    expect(() => getRuntime()).toThrow();
    expect(readFileSync(join(directory, "settings.json"), "utf8")).toBe("{damaged");
  });
});
