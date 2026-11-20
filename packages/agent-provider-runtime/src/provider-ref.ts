import type { AgentProviderRef } from "@hosty-sdk/app/agent";

/** Static providers omit implementationId; a named provider is a distinct resource owner. */
export const sameProvider = (a: AgentProviderRef, b: AgentProviderRef): boolean =>
  a.appId === b.appId && a.installationId === b.installationId && a.key === b.key
  && (a.implementationId ?? null) === (b.implementationId ?? null);
