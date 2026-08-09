import { createRequire } from "node:module";

// Resolves the Codex CLI the adapter drives. Order matters:
//   1. HOSTY_AI_GATEWAY_CODEX_COMMAND — an operator escape hatch, and what the tests point at a
//      scripted stand-in.
//   2. The pinned @openai/codex dependency — the version this adapter's protocol handling and tests
//      were written against, so a host without Codex installed still works and a host with a
//      different Codex version does not silently change behavior.
//   3. `codex` on PATH — an operator's own install, used when the dependency is unavailable (for
//      example a platform whose optional binary package did not install).
//
// Resolved per call rather than cached at import: the override is read from the live environment,
// and the app's node_modules can be populated by the manifest's setup step after this module loads.
export function resolveCodexCommand(): string {
  const override = process.env.HOSTY_AI_GATEWAY_CODEX_COMMAND?.trim();
  if (override) {
    return override;
  }

  try {
    return createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");
  } catch {
    return "codex";
  }
}

/** True when the resolved command is the JS entry of the pinned dependency (spawned via node). */
export function isNodeEntry(command: string): boolean {
  return command.endsWith(".js") || command.endsWith(".mjs");
}
