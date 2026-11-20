import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { codexEngine } from "./provider.js";

it("declares its agent and named speech interfaces", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  expect(manifest.provides).toEqual(["agent", "speech-to-text", "text-to-speech"]);
  expect(Object.keys(manifest.interfaces)).toEqual(["agent", "speech-to-text", "text-to-speech"]);
  expect(manifest.interfaces.agent[0].capabilities.some((capability: string) => capability.startsWith("translation."))).toBe(false);
  for (const kind of ["speech-to-text", "text-to-speech"]) expect(manifest.interfaces[kind][0].capabilities).toContain("implementations.named");
  const choices = codexEngine.settings.authentication.filter(auth => auth.interfaceChoices?.length);
  expect(choices.map(auth => auth.id)).toEqual(["api-key"]);
  expect(choices[0]?.interfaceChoices?.map(choice => choice.label)).toEqual(["Provide speech to text", "Provide text to speech"]);
  expect(codexEngine.capabilities.version).toBe(1);
  expect(codexEngine.settings.authentication.length).toBeGreaterThan(0);
});
