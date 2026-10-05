"use client";

import { appFetch } from "@hosty-sdk/app/browser-auth";

export type Provider = { appId: string; displayName: string; url: string | null; running: boolean };

/** The provider id Core's own tools are offered under — the gateway's constant, mirrored here. */
export const CORE_PROVIDER_ID = "hosty:core";

export type ToolCatalog = { provider: string; identity: string; tools: { name: string; description?: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }[] };
export type ToolRule = { identity: string; mode: "ask" | "run" | "disabled" };
export type Settings = {
  mcpToolRules?: Record<string, ToolRule>;
  immediateHandoffs?: boolean;
  systemPrompt: string;
  mcpProviders: Record<string, boolean>;
  mcpAutoAllow: Record<string, boolean>;
};

/** A skill whose text changed since it was accepted, with the new text to read before approving. */
export type PendingSkill = {
  appId: string;
  displayName: string;
  markdown: string;
  /** The digest this text was measured against, or null when the app was never approved at all. */
  approvedDigest: string | null;
};

export type SettingsResponse = {
  toolCatalogs?: ToolCatalog[];
  mcpReviewBaseUrl?: string | null;
  instructions?: { appId: string; markdown: string | null; approved: boolean }[];
  settings: Settings;
  agentConnections?: boolean;
  providers: Provider[];
  pendingSkills?: PendingSkill[];
  discovery: string;
  harness?: { name?: string; capabilities?: { liveReconfigure?: boolean; autoAllow?: boolean } };
};

/**
 * Every request is relative and same-origin.
 *
 * Deliberately: this page is a static export, and an absolute origin resolved at build time is the
 * bug the telemetry UI already shipped once — `next build` baked a localhost origin into static
 * layouts, so the bundle worked only on the machine that built it. Relative means the page works
 * from whatever origin the gateway is actually reached at, embedded or standalone.
 *
 * `credentials: "include"` because the Hosty app session is a cookie the gateway set: the page
 * authenticates as the operator who opened it, exactly as every other embedded Hosty page does.
 */
export async function call(path: string, init?: RequestInit): Promise<Response> {
  const response = await appFetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message || `Request failed (${response.status}).`);
  }
  return response;
}

export async function loadSettings(): Promise<SettingsResponse> {
  return (await call("/settings")).json() as Promise<SettingsResponse>;
}

/**
 * Accepts one app's changed skill, naming the text that was on screen.
 *
 * The digest travels with the click because the page can go stale: another update could land between
 * rendering the text and approving it, and "approve whatever is current" would approve words nobody
 * read — the exact failure this mechanism exists to prevent, arriving through its own approval path.
 */
export async function approveSkill(appId: string, markdown: string): Promise<void> {
  const digest = await digestOf(markdown);
  await call("/settings/skills/approve", { method: "POST", body: JSON.stringify({ appId, digest }) });
}

/** Must match the server's digest exactly; see `skillDigest` in the gateway. */
async function digestOf(markdown: string): Promise<string> {
  const bytes = new TextEncoder().encode(markdown.trim());
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export async function saveSettings(patch: Partial<Settings>): Promise<SettingsResponse> {
  return (await call("/settings", { method: "PUT", body: JSON.stringify(patch) })).json() as Promise<SettingsResponse>;
}
