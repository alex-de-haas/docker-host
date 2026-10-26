import { call } from "./api";
import type { ModelCatalog, AssistantSession } from "./assistant-api";
export type { AgentProfileConfig, AgentProfile, ProfileDirectory } from "../../../src/profiles/types";
import type { AgentProfileConfig, ProfileDirectory } from "../../../src/profiles/types";
export type ProfileSkill = { id: string; name: string; description: string };
export const listProfiles = async (): Promise<ProfileDirectory> => (await call("/profiles")).json();
export const profileSkills = async (): Promise<{ skills: ProfileSkill[] }> => (await call("/skills")).json();
export const connectionModels = async (id: string): Promise<ModelCatalog> => (await call(`/connections/${encodeURIComponent(id)}/models`)).json();
export const saveProfile = async (profile: AgentProfileConfig, expectedRevision: number, id?: string): Promise<ProfileDirectory> =>
  (await call(id ? `/profiles/${encodeURIComponent(id)}` : "/profiles", { method: id ? "PUT" : "POST", body: JSON.stringify({ profile, expectedRevision }) })).json();
export const deleteProfile = async (id: string, expectedRevision: number): Promise<ProfileDirectory> =>
  (await call(`/profiles/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ expectedRevision }) })).json();
export const defaultProfile = async (profileId: string | null, expectedRevision: number): Promise<ProfileDirectory> =>
  (await call("/profiles/default", { method: "PUT", body: JSON.stringify({ profileId, expectedRevision }) })).json();
export const selectSessionProfile = async (id: string, profileId: string | null, profileRevision: number | undefined, expectedRevision: number): Promise<AssistantSession> =>
  (await call(`/sessions/${encodeURIComponent(id)}/profile`, { method: "PUT", body: JSON.stringify({ profileId, profileRevision, expectedRevision }) })).json();
