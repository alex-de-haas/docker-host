/** Reusable configuration; no conversation, participant, application or workspace ownership. */
export interface AgentProfileConfig {
  name: string;
  description: string;
  instructions: string;
  connectionId: string | null;
  model: string | null;
  reasoningEffort: string | null;
  skillIds: string[];
}
export interface AgentProfile extends AgentProfileConfig {
  id: string;
  revision: number;
}
export interface ProfileDirectory {
  revision: number;
  defaultId: string | null;
  profiles: AgentProfile[];
  catalogUnavailable?: boolean;
}
