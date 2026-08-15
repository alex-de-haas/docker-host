#!/usr/bin/env node
// PreToolUse gate for the Hosty connector.
//
// What it does and, more importantly, what it does NOT do.
//
// The connector is read-only and enforces that server-side: an app tool is exported only when it
// declares `readOnlyHint: true`, and one that declares nothing is treated as possibly mutating and
// never offered. So auto-allowing these calls rests on an enforced property of the server, not on a
// guess about what a tool named `list_*` probably does.
//
// That is why there is no "deny destructive" branch. A name-based blacklist would be exactly the
// wrong instinct: it reads safety off a string the app chose, and it would give the appearance of a
// guard over a surface that has nothing dangerous on it. If the connector ever exports writes, the
// decision about approving them belongs with that change, informed by the annotations it would then
// be carrying — not pre-written here against tools that do not exist.
//
// The one real check: the tool has to look like something this connector produced. Anything else on
// a server named `hosty` is unexpected, and unexpected means the normal permission flow, not a pass.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PREFIX = "mcp__hosty__";

/**
 * True when `toolName` has the shape this connector produces: `mcp__hosty__<key>__<tool>`.
 *
 * Split at the LAST `__` rather than matched with one regex. A tool name may contain single
 * underscores — `list_people` does — while the connector refuses to export one containing `__`, so
 * the final separator is unambiguous and everything before it is the key. A regex that treated `_`
 * as a separator rejected every ordinary tool name; this is why the check is written out.
 */
export function isConnectorTool(toolName) {
  if (typeof toolName !== "string" || !toolName.startsWith(PREFIX)) {
    return false;
  }

  const rest = toolName.slice(PREFIX.length);
  const split = rest.lastIndexOf("__");
  if (split <= 0) {
    return false;
  }

  const key = rest.slice(0, split);
  const tool = rest.slice(split + 2);
  return /^[a-z0-9][a-z0-9_-]*$/.test(key) && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(tool);
}

function decide() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    // Unreadable input is not a reason to wave a call through.
    return null;
  }

  if (!isConnectorTool(payload?.tool_name)) {
    return null;
  }

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason:
        "Hosty connector tools are read-only: the server exports a tool only when it declares readOnlyHint, so this call cannot change host or app state.",
    },
  };
}

// Only when run as the hook. Importing this file — which the tests do, to exercise the shape check
// without a stdin — must not consume stdin or exit the process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const decision = decide();
  if (decision) {
    process.stdout.write(JSON.stringify(decision));
  }

  // Exit 0 either way. Saying nothing leaves the normal permission flow in charge, which is the
  // right answer for anything this hook does not recognise.
  process.exit(0);
}
