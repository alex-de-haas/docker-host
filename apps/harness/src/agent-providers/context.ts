import { AsyncLocalStorage } from "node:async_hooks";
import { AgentApiError } from "@hosty-sdk/app/agent";
import type { AgentConsumerAuthority } from "./types.js";

const authorities = new AsyncLocalStorage<AgentConsumerAuthority>();

/** Request scope is consumer-side only; admitted execution renews directly through the provider. */
export function withAgentAuthority<T>(authority: AgentConsumerAuthority, action: () => T): T {
  return authorities.run(authority, action);
}
export async function currentAgentAuthority(): ReturnType<AgentConsumerAuthority> {
  const authority = authorities.getStore();
  if (!authority) throw new AgentApiError("actor_required", "Refresh Hosty sign-in before selecting an agent provider.", 401);
  return authority();
}
