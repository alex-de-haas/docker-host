import { createHash } from "node:crypto";
import { AppContextError } from "./sessions/app-context.js";
import { requestSourceConnection } from "./source-connections.js";
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
export type PlatformSkillContext = { skillId: string; coreVersion: string; path: string; text: string };
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

export function manageSkills(method: string, url: URL, credential: string | null, body?: unknown) {
  return requestSkillManagement(method, url.pathname + url.search, credential, body);
}

async function requestSkillManagement(method: string, path: string, credential: string | null, body?: unknown) {
  if (!credential) return { status: 401, body: { code: "reauth_required", message: "Sign in through Core to manage skills." } };
  const { origin, token } = connection();
  const response = await fetch(new URL(path, origin), {
    method, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(150_000),
    headers: { authorization: `Bearer ${token}`, "X-Hosty-App-Identity": credential, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as unknown };
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const invalidSkillInput = () => new AppContextError(400, "skill_input_invalid", "Supply the documented skill source and selections.");

function gitSource(value: unknown) {
  if (!object(value) || !onlyKeys(value, ["repository", "ref", "path", "connectionId"]) ||
    typeof value.repository !== "string" || !value.repository.trim() ||
    value.ref !== undefined && typeof value.ref !== "string" || value.path !== undefined && typeof value.path !== "string" ||
    value.connectionId != null && typeof value.connectionId !== "string") throw invalidSkillInput();
  return { repository: value.repository, ref: value.ref ?? "HEAD", path: value.path ?? "",
    ...(value.connectionId == null ? {} : { connectionId: value.connectionId }) };
}

function managementResult(response: { status: number; body: unknown }) {
  if (response.status >= 200 && response.status < 300) return response.body;
  const error = object(response.body) ? response.body : {};
  throw new AppContextError(response.status, typeof error.code === "string" ? error.code : "skill_request_failed",
    typeof error.message === "string" ? error.message : "The Core skill request failed.");
}

async function listSkillSourceConnections(credential: string | null) {
  const result = managementResult(await requestSourceConnection("GET", "/api/source-connections", credential));
  const invalid = () => new AppContextError(502, "source_connections_invalid", "Core returned an invalid Source connection directory.");
  if (!object(result) || !Array.isArray(result.connections)) throw invalid();
  return result.connections.map(connection => {
    if (!object(connection) || typeof connection.id !== "string" || !connection.id ||
      typeof connection.provider !== "string" || !connection.provider || typeof connection.label !== "string") throw invalid();
    return { id: connection.id, provider: connection.provider, label: connection.label.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 100) };
  });
}

/** A chat operates under its current owner's Core app-session identity, using the same catalog and permissions as Settings. */
export async function callSkillChatTool(name: string, input: Record<string, unknown>, credential: string | null) {
  async function request(method: string, path: string, body?: unknown) {
    let response;
    try { response = await requestSkillManagement(method, path, credential, body); }
    catch {
      throw new AppContextError(503, "skill_library_unavailable", name === "skill_install"
        ? "Core did not confirm the installation. Read the skill catalog before retrying."
        : "The Core skill library is unavailable.");
    }
    return managementResult(response);
  }
  const catalog = (value: unknown) => {
    if (!object(value) || !Array.isArray(value.skills) || !validSkillIds(value.skills.map(skill => skill?.id)))
      throw new AppContextError(502, "skill_catalog_invalid", "Core returned an invalid skill catalog.");
    return value.skills as SharedSkill[];
  };

  if (name === "skill_list") {
    if (!onlyKeys(input, ["includeSourceConnections"]) ||
      input.includeSourceConnections !== undefined && typeof input.includeSourceConnections !== "boolean") throw invalidSkillInput();
    const skills = catalog(await request("GET", "/api/skills"));
    return input.includeSourceConnections ? { skills, sourceConnections: await listSkillSourceConnections(credential) } : { skills };
  }
  if (name === "skill_discover") {
    if (!onlyKeys(input, ["source"])) throw invalidSkillInput();
    const source = gitSource(input.source);
    const result = await request("POST", "/api/skills/discover", source);
    if (!object(result) || result.repository !== source.repository || result.ref !== source.ref ||
      typeof result.commit !== "string" || !result.commit || !Array.isArray(result.skills))
      throw new AppContextError(502, "skill_discovery_invalid", "Core returned an invalid Git skill discovery.");
    return result;
  }
  if (name !== "skill_install") throw new AppContextError(400, "unknown_skill_tool", "Unknown skill library tool.");
  const source = gitSource(input.source), paths = input.paths, commit = input.commit;
  if (!onlyKeys(input, ["source", "commit", "paths"]) || typeof commit !== "string" || !commit ||
    !Array.isArray(paths) || !paths.length || paths.length > 200 || paths.some(path => typeof path !== "string") ||
    new Set(paths).size !== paths.length) throw invalidSkillInput();
  const result = catalog(await request("POST", "/api/skills/install", { source, commit, paths }));
  const skills = paths.map(path => result.find(skill => skill.sourceKind === "git" && skill.repository === source.repository &&
    skill.ref === source.ref && skill.path === path && skill.commit === commit));
  if (skills.some(skill => !skill))
    throw new AppContextError(409, "skill_install_unconfirmed", "Core did not confirm every selected package at the discovered commit. Read the catalog before retrying.");
  return { commit, skills };
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

/** Harness explicitly selects platform guidance; independent provider callers have no such default. */
export async function platformSkillContext(): Promise<PlatformSkillContext | undefined> {
  if (!hasSkillLibrary()) return undefined;
  const catalog = await skillRequest<SkillCatalog>("/");
  const matches = catalog.skills.filter(skill => skill.sourceKind === "core" && skill.introductionPath);
  if (matches.length !== 1) throw new Error("Core platform guidance is unavailable or ambiguous.");
  const skill = matches[0]!;
  if (!/^[a-f0-9]{64}$/.test(skill.id) || !skill.coreVersion || typeof skill.introductionPath !== "string")
    throw new Error("Core returned invalid platform guidance metadata.");
  const content = await skillRequest<{ skill: SharedSkill; path: string; content: string; files: string[] }>(
    `/${skill.id}/content?path=${encodeURIComponent(skill.introductionPath)}`);
  if (content.skill.id !== skill.id || content.skill.sourceKind !== "core" || content.skill.coreVersion !== skill.coreVersion
    || content.skill.introductionPath !== skill.introductionPath || content.path !== skill.introductionPath
    || typeof content.content !== "string" || !Array.isArray(content.files) || !content.files.includes(content.path))
    throw new Error("Core platform guidance changed while preparing this conversation.");
  const bytes = Buffer.from(content.content, "base64");
  if (!bytes.length || bytes.length > 8000 || bytes.toString("base64") !== content.content)
    throw new Error("Core returned invalid platform introduction bytes.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  if (!text) throw new Error("Core returned an empty platform introduction.");
  return { skillId: skill.id, coreVersion: skill.coreVersion, path: content.path, text };
}
