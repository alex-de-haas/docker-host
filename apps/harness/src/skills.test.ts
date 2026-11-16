import { afterEach, expect, it, vi } from "vitest";
import { platformSkillContext, prepareSkills, validSkillIds } from "./skills.js";
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

it("reads only the catalog-declared Core introduction without creating a consumer-owned export", async () => {
  vi.stubEnv("HOSTY_CORE_ORIGIN", "http://core.test"); vi.stubEnv("HOSTY_APP_ID", "consumer"); vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service");
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async url => String(url).endsWith("/skills/")
    ? Response.json({ skills: [skill, { ...skill, id: "b".repeat(64), sourceKind: "app" }] })
    : Response.json({ skill, path: skill.introductionPath, files: [skill.introductionPath], content: Buffer.from("Core context").toString("base64") }));
  expect(await platformSkillContext()).toEqual({ skillId: id, coreVersion: "1.0.0", path: skill.introductionPath, text: "Core context" });
  expect(fetch.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
    ["http://core.test/api/internal/apps/consumer/skills/", "GET"],
    [`http://core.test/api/internal/apps/consumer/skills/${id}/content?path=references%2Fintroduction.md`, "GET"],
  ]);
});

it("refuses a platform introduction whose Core package changed after catalog discovery", async () => {
  vi.stubEnv("HOSTY_CORE_ORIGIN", "http://core.test"); vi.stubEnv("HOSTY_APP_ID", "consumer"); vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service");
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ skills: [skill] }))
    .mockResolvedValueOnce(Response.json({ skill: { ...skill, coreVersion: "replacement" }, path: skill.introductionPath,
      files: [skill.introductionPath], content: Buffer.from("Replacement context").toString("base64") }));
  await expect(platformSkillContext()).rejects.toThrow("changed");
});
