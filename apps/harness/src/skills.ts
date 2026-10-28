import { createHash } from "node:crypto";
import type { SettingsStore } from "./settings/store.js";

export interface SharedSkill {
  id: string; name: string; description: string; sourceKind: "git" | "app" | "core";
  coreVersion?: string | null; introductionPath?: string | null;
  appId?: string | null; appVersion?: string | null; repository?: string | null;
  ref?: string | null; path: string; commit?: string | null; fileCount: number; bytes: number; installedAt: string;
}
export interface SkillCatalog { skills: SharedSkill[] }
export interface SkillExport { id: string; path: string; skills: SharedSkill[];
  platformIntroduction?: { skillId: string; coreVersion: string; path: string; text: string } | null;
}
export const validSkillIds = (value: unknown): value is string[] =>
  // Core contributes two built-ins in addition to the 200-package managed library.
  Array.isArray(value) && value.length <= 202 && value.every(id => typeof id === "string" && /^[a-f0-9]{64}$/.test(id)) && new Set(value).size === value.length;

export function hasSkillLibrary(): boolean {
  return Boolean(process.env.HOSTY_CORE_ORIGIN?.trim() && process.env.HOSTY_APP_SERVICE_TOKEN?.trim() && process.env.HOSTY_APP_ID?.trim());
}

function connection() {
  const origin = process.env.HOSTY_CORE_ORIGIN?.trim(), token = process.env.HOSTY_APP_SERVICE_TOKEN?.trim();
  const appId = process.env.HOSTY_APP_ID?.trim();
  if (!origin || !token || !appId) throw new Error("Core skill library is unavailable.");
  return { origin, token, appId };
}

export async function skillRequest<T>(suffix: string, method = "GET", body?: unknown): Promise<T> {
  const { origin, token, appId } = connection();
  const response = await fetch(new URL(`/api/internal/apps/${encodeURIComponent(appId)}/skills${suffix}`, origin), {
    method, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(result.message ?? "The Core skill request failed.");
  return result;
}

export function isSkillManagementRoute(method: string, pathname: string): boolean {
  return method === "GET" && (pathname === "/api/skills" || /^\/api\/skills\/[a-f0-9]{64}\/content$/.test(pathname)) ||
    method === "POST" && ["/api/skills/discover", "/api/skills/install", "/api/skills/check-updates", "/api/skills/update"].includes(pathname) ||
    method === "DELETE" && /^\/api\/skills\/[a-f0-9]{64}$/.test(pathname);
}

export async function manageSkills(method: string, url: URL, credential: string | null, body?: unknown) {
  if (!credential) return { status: 401, body: { message: "Sign in through Core to manage skills." } };
  const { origin, token } = connection();
  const response = await fetch(new URL(url.pathname + url.search, origin), {
    method, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(150_000),
    headers: { authorization: `Bearer ${token}`, "X-Hosty-App-Identity": credential, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as unknown };
}

/** Preserve explicit old app instruction choices once; newly supplied packages stay unselected. */
export async function migrateSkillSelection(store: SettingsStore): Promise<void> {
  const previous = await store.read();
  if (previous.skillIds !== undefined || !hasSkillLibrary()) return;
  await store.transform(current => {
    if (current.skillIds !== undefined) return {};
    // After the earlier instruction migration, approvals are authoritative: removing one
    // was an explicit opt-out even though its historical digest remained in settings.
    const selectedApps = new Set([
      ...Object.keys(current.mcpSkillApprovals ?? {}),
      ...Object.keys(current.mcpSkillsMigrated ? {} : current.mcpSkillDigests ?? {}),
    ]);
    // Stable app/key identity preserves choices even when an app upgrades after Harness.
    // Missing packages remain unavailable until installed; no old skill bytes are retained.
    return { skillIds: [...selectedApps].map(appId => createHash("sha256").update(["app", appId, "default"].join("\n")).digest("hex")) };
  });
}

export async function prepareSkills(contextId: string, store: SettingsStore, selected?: string[]): Promise<SkillExport | undefined> {
  if (!hasSkillLibrary()) return undefined;
  await migrateSkillSelection(store);
  const result = await skillRequest<SkillExport>("/exports", "POST", { contextId, skillIds: selected ?? (await store.read()).skillIds ?? [], includePlatform: true });
  if (!/^[a-f0-9]{64}$/.test(result.id ?? "") || !Array.isArray(result.skills)) throw new Error("Core returned an invalid skill export.");
  const intro = result.platformIntroduction;
  if (intro == null && result.skills.some(skill => skill.sourceKind === "core" && skill.introductionPath))
    throw new Error("Core omitted the platform introduction.");
  if (intro != null && (!/^[a-f0-9]{64}$/.test(intro.skillId ?? "") || typeof intro.coreVersion !== "string" || !intro.coreVersion ||
      typeof intro.path !== "string" || !intro.path || typeof intro.text !== "string" || !intro.text.trim() || Buffer.byteLength(intro.text, "utf8") > 8000 ||
      !result.skills.some(skill => skill.id === intro.skillId && skill.sourceKind === "core" &&
        skill.coreVersion === intro.coreVersion && skill.introductionPath === intro.path)))
    throw new Error("Core returned invalid platform context.");
  return result;
}
