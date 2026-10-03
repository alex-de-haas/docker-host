import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageRoot = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8"));

describe("workspace exports", () => {
  it.each(Object.entries(manifest.exports))("%s resolves without generated dist files", (_subpath, target) => {
    // Clean CI consumers transpile workspace source; prepare-publish owns the dist mapping.
    expect(target).toEqual(expect.stringMatching(/^\.\/src\/.+\.tsx?$/));
    expect(existsSync(new URL(target as string, packageRoot))).toBe(true);
  });
});
