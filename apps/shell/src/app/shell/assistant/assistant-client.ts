import type { CoreApp } from "../types";

// Client for the AI gateway system app (docs/features/ai-gateway/plan.md, phase 3). Shell talks to
// the gateway origin directly with a short-TTL delegated token minted by Core — Core stays out of
// the data path. EventSource cannot carry an Authorization header, so the SSE stream is consumed
// with fetch + a hand-rolled reader; reattach uses the gateway's `?after=<seq>` cursor.

// Discovery only. The chat itself is a page the gateway serves and Shell embeds as a panel tab
// (docs/features/assistant-entry-points/plan.md); Shell keeps no client for it.
export const AI_GATEWAY_INTERFACE = "ai-gateway";

export type AssistantGateway = {
  appId: string;
  /** Resolved interface URL, e.g. http://127.0.0.1:3400/api */
  baseUrl: string;
  running: boolean;
};

/** Finds the installed ai-gateway provider among the apps Core reports. Hidden ⇒ no assistant UI. */
export function findAssistantGateway(apps: CoreApp[]): AssistantGateway | null {
  for (const app of apps) {
    const declarations = app.interfaces?.[AI_GATEWAY_INTERFACE];
    const url = declarations?.find((declaration) => declaration.url)?.url;
    if (url) {
      return { appId: app.id, baseUrl: url.replace(/\/$/, ""), running: app.runtimeState === "running" };
    }
  }
  return null;
}
