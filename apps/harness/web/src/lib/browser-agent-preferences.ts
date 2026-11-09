"use client";

import { appFetch } from "@hosty-sdk/app/browser-auth";
import type { AssistantSession } from "./assistant-api";

export type BrowserAgentDefaults = {
  /** Bound to the current identity when loading creation hints; never persisted. */
  ownerId?: string;
  models?: Record<string, { model: string | null; reasoningEffort: string | null }>;
  autonomy?: "normal" | "autonomous";
};

const PREFIX = "hosty.harness.agent-defaults.v1.";
const MAX_CONNECTIONS = 64;
const MAX_ID_CHARS = 512;
const SELECTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,255}$/;
const MAX_STORAGE_BYTES = 40 * 1024;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_ID_CHARS;
}
function validName(value: unknown): value is string | null {
  return value === null || typeof value === "string" && SELECTION_NAME.test(value);
}
function fitsStorage(value: string): boolean {
  return value.length <= MAX_STORAGE_BYTES && new TextEncoder().encode(value).length <= MAX_STORAGE_BYTES;
}
function decode(raw: string | null): BrowserAgentDefaults | undefined {
  if (!raw || !fitsStorage(raw)) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (!isObject(value)) return undefined;
  const defaults: BrowserAgentDefaults = {};
  if (value.models !== undefined) {
    if (!isObject(value.models)) return undefined;
    const pairs = Object.entries(value.models);
    if (pairs.length > MAX_CONNECTIONS || pairs.some(([id, pair]) => !validId(id) || !isObject(pair)
      || !validName(pair.model) || !validName(pair.reasoningEffort))) return undefined;
    if (pairs.length) defaults.models = Object.fromEntries(pairs.map(([id, pair]) => {
      const selection = pair as NonNullable<BrowserAgentDefaults["models"]>[string];
      return [id, { model: selection.model, reasoningEffort: selection.reasoningEffort }];
    }));
  }
  if (value.autonomy !== undefined) {
    if (value.autonomy !== "normal" && value.autonomy !== "autonomous") return undefined;
    defaults.autonomy = value.autonomy;
  }
  return defaults.models || defaults.autonomy ? defaults : undefined;
}

/** localStorage supplies origin isolation; the key supplies authenticated owner isolation. */
export function readBrowserAgentDefaults(userId: string): BrowserAgentDefaults | undefined {
  if (!validId(userId)) return undefined;
  try {
    return decode(window.localStorage.getItem(PREFIX + encodeURIComponent(userId)));
  } catch {
    return undefined;
  }
}

function remember(record: AssistantSession, update: (defaults: BrowserAgentDefaults) => void): void {
  if (record.taskExecutionId != null || !validId(record.createdBy)) return;
  try {
    const key = PREFIX + encodeURIComponent(record.createdBy);
    // Read on every save so another tab's unrelated connection/autonomy choices are retained.
    const defaults = decode(window.localStorage.getItem(key)) ?? {};
    update(defaults);
    let encoded = JSON.stringify(defaults);
    // Preserve the most recently chosen connections when the convenience store reaches its bound.
    while (defaults.models && (Object.keys(defaults.models).length > MAX_CONNECTIONS || !fitsStorage(encoded))) {
      const oldest = Object.keys(defaults.models)[0];
      if (oldest === undefined) return;
      delete defaults.models[oldest];
      encoded = JSON.stringify(defaults);
    }
    if (fitsStorage(encoded)) window.localStorage.setItem(key, encoded);
  } catch {
    // A blocked/quota-limited browser store must never affect the confirmed chat setting.
  }
}

/** Call only after a successful explicit model save, including a manual choice on a profile chat. */
export function rememberManualModel(record: AssistantSession): void {
  const selection = record.executionSelection;
  if (!validId(record.connectionId) || !selection || !validName(selection.model) || !validName(selection.reasoningEffort)) return;
  remember(record, defaults => {
    const models = { ...defaults.models };
    const connectionId = record.connectionId!;
    delete models[connectionId];
    models[connectionId] = { model: selection.model, reasoningEffort: selection.reasoningEffort };
    defaults.models = models;
  });
}

/** Call only after the server confirms an explicit autonomy change. */
export function rememberAutonomy(record: AssistantSession): void {
  if (record.autonomy !== "normal" && record.autonomy !== "autonomous") return;
  remember(record, defaults => { defaults.autonomy = record.autonomy; });
}

/** Resolve the current owner each time; no session/account identity is cached in browser memory. */
export async function loadBrowserAgentDefaults(): Promise<BrowserAgentDefaults | undefined> {
  try {
    const response = await appFetch("/api/auth/identity");
    if (!response.ok) return undefined;
    const identity: unknown = await response.json();
    if (!isObject(identity) || identity.status !== "active" || !validId(identity.userId)) return undefined;
    const defaults = readBrowserAgentDefaults(identity.userId);
    return defaults ? { ...defaults, ownerId: identity.userId } : undefined;
  } catch {
    return undefined;
  }
}
