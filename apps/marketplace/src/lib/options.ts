import path from "node:path";

// Runtime configuration resolved from the environment Core injects. Kept as a plain object built by
// a pure function so tests construct options directly and route handlers resolve them once per
// process (see runtime.ts).
export type MarketplaceOptions = {
  dataDirectory: string;
  // Initial catalog sources used only while no stored source list has been materialized in app
  // data. Core's bootstrap import (Phase 1 proxy work) writes the one-time handoff seed; this env
  // fallback keeps standalone/dev runs configurable the same way Core was (HOSTY_CATALOG_SOURCES).
  seedSources: string[];
  // The Core-minted app service token (HOSTY_APP_SERVICE_TOKEN). Every non-health request must
  // present it; when Core did not inject one (standalone run) the API fails closed.
  serviceToken: string | null;
};

export function optionsFromEnvironment(env: NodeJS.ProcessEnv = process.env): MarketplaceOptions {
  const dataDirectory =
    readString(env.HOSTY_MARKETPLACE_DATA_DIR) ??
    readString(env.HOSTY_APP_DATA_DIR) ??
    readString(env.HOSTY_APP_DATA) ??
    path.join(process.cwd(), "data");

  return {
    dataDirectory,
    seedSources: readList(env.HOSTY_CATALOG_SOURCES),
    serviceToken: readString(env.HOSTY_APP_SERVICE_TOKEN),
  };
}

function readString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

// Comma-separated, trimmed, de-duplicated, order-preserving (same parsing Core used for the env seed).
function readList(value: string | undefined): string[] {
  const raw = readString(value);
  if (raw === null) {
    return [];
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }

  return result;
}
