import { afterEach, expect, it, vi } from "vitest";
import { callSkillChatTool, platformSkillContext, prepareSkills, validSkillIds } from "./skills.js";
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

function chatLibrary() {
  vi.stubEnv("HOSTY_CORE_ORIGIN", "http://core.test");
  vi.stubEnv("HOSTY_APP_ID", "unrelated.chat");
  vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service");
  return vi.spyOn(globalThis, "fetch");
}
const source = { repository: "https://git.example.test/guides", ref: "main", path: "", connectionId: "my-source" };
const commit = "abc123";
const selectedSkill = { id, sourceKind: "git", repository: source.repository, ref: source.ref, path: "", commit, name: "guide", description: "Review code." };

it("can recommend skills by listing the library and discovering a repository without installing anything", async () => {
  const fetch = chatLibrary().mockResolvedValueOnce(Response.json({ skills: [selectedSkill] }))
    .mockResolvedValueOnce(Response.json({ repository: source.repository, ref: "HEAD", commit, skills: [{ path: "", name: "guide", description: "Review code." }] }));
  expect(await callSkillChatTool("skill_list", {}, "owner")).toEqual({ skills: [selectedSkill] });
  expect(await callSkillChatTool("skill_discover", { source: { repository: source.repository, connectionId: null } }, "owner"))
    .toMatchObject({ commit, skills: [{ path: "", name: "guide" }] });
  expect(fetch.mock.calls.map(([url, init]) => [String(url), init?.method, init?.body])).toEqual([
    ["http://core.test/api/skills", "GET", undefined],
    ["http://core.test/api/skills/discover", "POST", JSON.stringify({ repository: source.repository, ref: "HEAD", path: "" })],
  ]);
});

it("installs the exact selected paths using the current operator and returns only matching packages and stable IDs", async () => {
  const other = { ...selectedSkill, id: "b".repeat(64), repository: "https://other.test/guides" };
  const fetch = chatLibrary().mockResolvedValue(Response.json({ skills: [other, selectedSkill] }));
  const input = { source, commit, paths: [""] };
  expect(await callSkillChatTool("skill_install", input, "owner")).toEqual({ commit, skills: [selectedSkill] });
  const [url, init] = fetch.mock.calls[0]!;
  expect(String(url)).toBe("http://core.test/api/skills/install");
  expect(init?.headers).toMatchObject({ authorization: "Bearer service", "X-Hosty-App-Identity": "owner" });
  expect(JSON.parse(String(init?.body))).toEqual(input);
});

it.each([
  [403, "source_access_required"], [403, "app_permission_required"], [401, "token_revoked"], [409, "skill_source_changed"],
])("keeps Core's refusal %s %s", async (status, code) => {
  chatLibrary().mockResolvedValue(Response.json({ code, message: "Request refused by Core." }, { status }));
  await expect(callSkillChatTool("skill_install", { source, commit, paths: ["guide"] }, "owner")).rejects.toMatchObject({ status, code });
});

it("returns no false installation receipt when the catalog shows a different commit", async () => {
  chatLibrary().mockResolvedValue(Response.json({ skills: [{ ...selectedSkill, commit: "moved" }] }));
  await expect(callSkillChatTool("skill_install", { source, commit, paths: [""] }, "owner"))
    .rejects.toMatchObject({ code: "skill_install_unconfirmed" });
});

it("refuses missing authority, a supplied actor or selection by name before reaching Core", async () => {
  const fetch = chatLibrary();
  await expect(callSkillChatTool("skill_install", { source, commit, paths: [""] }, null)).rejects.toMatchObject({ status: 401 });
  await expect(callSkillChatTool("skill_install", { source, commit, paths: [""], userId: "admin" }, "owner")).rejects.toMatchObject({ status: 400 });
  await expect(callSkillChatTool("skill_install", { source, commit, names: ["guide"] }, "owner")).rejects.toMatchObject({ status: 400 });
  expect(fetch).not.toHaveBeenCalled();
});


it("returns only Source connection handles available to the operator when explicitly requested", async () => {
  const fetch = chatLibrary().mockResolvedValueOnce(Response.json({ skills: [] }))
    .mockResolvedValueOnce(Response.json({ connections: [{ id: "my-source", provider: "git", label: "Team\n repo",
      accountId: "private", grantedScopes: ["write"], organization: "private", accessToken: "never-to-model" }], gitIdentity: { email: "private" } }));
  expect(await callSkillChatTool("skill_list", { includeSourceConnections: true }, "owner")).toEqual({
    skills: [], sourceConnections: [{ id: "my-source", provider: "git", label: "Team repo" }],
  });
  const [url, init] = fetch.mock.calls[1]!;
  expect(String(url)).toBe("http://core.test/api/source-connections");
  expect(init?.headers).toMatchObject({ authorization: "Bearer service", "X-Hosty-App-Identity": "owner" });
});

it("preserves the app's Source connection selection permission when listing private sources", async () => {
  chatLibrary().mockResolvedValueOnce(Response.json({ skills: [] }))
    .mockResolvedValueOnce(Response.json({ code: "app_permission_required", message: "Source access required." }, { status: 403 }));
  await expect(callSkillChatTool("skill_list", { includeSourceConnections: true }, "owner")).rejects.toMatchObject({
    status: 403, code: "app_permission_required",
  });
});
