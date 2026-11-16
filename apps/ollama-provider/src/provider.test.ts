import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { ollamaEngine } from "./provider.js";

it("declares only the agent interface and owns its runtime engine definition", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  expect(manifest.provides).toEqual(["agent"]);
  expect(Object.keys(manifest.interfaces)).toEqual(["agent"]);
  expect(manifest.interfaces.agent[0].capabilities.some((capability: string) => capability.startsWith("translation."))).toBe(false);
  expect(ollamaEngine.capabilities.version).toBe(1);
  expect(ollamaEngine.settings.authentication.length).toBeGreaterThan(0);
});
