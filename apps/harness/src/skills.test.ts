import { afterEach, expect, it, vi } from "vitest";
import { prepareSkills, validSkillIds } from "./skills.js";
import type { SettingsStore } from "./settings/store.js";

const id = "a".repeat(64);
const skill = { id, sourceKind: "core", coreVersion: "1.0.0", introductionPath: "references/introduction.md" };
const introduction = { skillId: id, coreVersion: "1.0.0", path: skill.introductionPath, text: "Core context" };
const store = { read: async () => ({ skillIds: [] }) } as unknown as SettingsStore;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it.each([
  { skills: [{ ...skill, sourceKind: "app" }], platformIntroduction: introduction },
  { skills: [skill], platformIntroduction: { ...introduction, text: "x".repeat(8001) } },
  { skills: [skill], platformIntroduction: { ...introduction, coreVersion: "other" } },
  { skills: [skill] },
])("refuses inconsistent or non-Core standing context", async response => {
  vi.stubEnv("HOSTY_CORE_ORIGIN", "http://core.test");
  vi.stubEnv("HOSTY_APP_ID", "example.consumer");
  vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "fixture");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id, path: "/export", ...response }));
  await expect(prepareSkills("chat", store, [])).rejects.toThrow(/Core/);
});

it("accepts a full managed library plus both built-in IDs", () => {
  const ids = Array.from({ length: 202 }, (_, i) => i.toString(16).padStart(64, "0"));
  expect(validSkillIds(ids)).toBe(true);
  expect(validSkillIds([...ids, "f".repeat(64)])).toBe(false);
});
