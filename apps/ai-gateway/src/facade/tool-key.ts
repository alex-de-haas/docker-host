// The name an aggregated tool is offered under.
//
// A deliberate port of the CLI connector's mapping (apps/cli/…/Mcp/ToolKey.cs, settled in
// docs/features/hosty-mcp-connector/feature.md) rather than a second scheme. Both surfaces present
// the same fleet to the same clients, and a client's permission rules are written against these
// strings — two dialects would mean a rule that works through `hosty mcp` and silently does not
// through the facade. The port is asserted against the connector's own worked examples in the tests.
//
// The exported name has to be **unique and stable**, not decodable: nothing ever parses these back,
// because the facade keeps its own table from name to (app, tool). Stability is why collisions are
// avoided by construction rather than by disambiguating after the fact — a name that shifts when
// some *other* app is installed breaks a client rule without any visible failure.

import { createHash } from "node:crypto";

/** The interface key left out of a name, since nearly every app uses it. */
export const DEFAULT_INTERFACE_KEY = "default";

/**
 * Longest key (app + interface) before it is replaced by a truncated form. Core accepts an app id of
 * up to 63 characters and the escape below can nearly double one, so an unbounded key would push
 * whole apps past what clients accept.
 */
const MAX_KEY_CHARS = 32;

/** Characters kept from the digest when a key is truncated: 32 bits of app-specific hash. */
const DIGEST_CHARS = 8;

/**
 * Ceiling on the exported name. A client prepends its own `mcp__<server>__`, so this keeps what the
 * model finally sees within 64 for a server entry named `hosty`.
 */
export const DEFAULT_MAX_TOOL_NAME_CHARS = 52;

/** The stable key for one app interface. Pure in its arguments — nothing about the rest of the
 * fleet reaches it, which is the property that keeps names from shifting. */
export function interfaceKey(appId: string, key: string = DEFAULT_INTERFACE_KEY): string {
  const resolved = key.trim() || DEFAULT_INTERFACE_KEY;
  const escaped = escapeAppId(appId);
  const composed = resolved === DEFAULT_INTERFACE_KEY ? escaped : `${escaped}__${resolved}`;
  if (composed.length <= MAX_KEY_CHARS) {
    return composed;
  }

  // The digest is taken over the *unescaped* identity joined by a space — a character neither part
  // may contain — so two different identities cannot feed the hash the same bytes.
  const digest = createHash("sha256").update(`${appId} ${resolved}`).digest("hex").slice(0, DIGEST_CHARS);
  return `${composed.slice(0, MAX_KEY_CHARS - DIGEST_CHARS - 1)}-${digest}`;
}

/**
 * The exported tool name, or null when the tool cannot be offered under this mapping.
 *
 * Two refusals, both of which the caller logs rather than swallowing: a tool whose own name contains
 * `__`, which would make the boundary between key and tool ambiguous; and a name over the ceiling,
 * refused rather than truncated, because truncating collides tool names with each other — strictly
 * worse than not offering one.
 */
export function toolName(
  key: string,
  tool: string,
  maxToolNameChars: number = DEFAULT_MAX_TOOL_NAME_CHARS,
): string | null {
  if (!tool.trim() || tool.includes("__")) {
    return null;
  }

  const name = `${key}__${tool}`;
  return name.length <= maxToolNameChars ? name : null;
}

/**
 * Escapes an app id into `[a-z0-9_-]` such that the result can never contain `__`: every `_` it
 * emits is immediately followed by `d`, `u`, or `x`. That is the property the whole mapping rests
 * on, because it makes the first `__` in a composed name an unambiguous boundary.
 *
 * Reversible, which is how it stays injective — the naive alternative of replacing `.` with `-` maps
 * `com.example.notes` and `com-example-notes` onto the same string, a bug this repository has
 * already found and fixed once.
 */
export function escapeAppId(appId: string): string {
  let out = "";
  for (const character of appId) {
    if (character === ".") {
      out += "_d";
    } else if (character === "_") {
      out += "_u";
    } else if (/[a-z0-9-]/.test(character)) {
      out += character;
    } else {
      // Unreachable through a validated manifest (Core's id pattern admits only [a-z0-9._-]); it
      // exists so a hand-edited registry cannot produce a colliding key.
      out += `_x${character.codePointAt(0)!.toString(16).padStart(2, "0")}`;
    }
  }
  return out;
}
