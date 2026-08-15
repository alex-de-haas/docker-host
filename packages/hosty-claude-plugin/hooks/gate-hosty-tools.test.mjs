import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isConnectorTool } from "./gate-hosty-tools.mjs";

const HOOK = fileURLToPath(new URL("./gate-hosty-tools.mjs", import.meta.url));

function run(payload) {
  const out = execFileSync("node", [HOOK], { input: payload, encoding: "utf8" });
  return out ? JSON.parse(out) : null;
}

describe("connector tool shape", () => {
  it("accepts the names the connector actually produces", () => {
    // The case a regex got wrong first: tool names carry single underscores, and treating `_` as a
    // separator rejected every real one while the hook still looked like it worked.
    expect(isConnectorTool("mcp__hosty__com_dhaas_ddemo-app__list_people")).toBe(true);
    expect(isConnectorTool("mcp__hosty__com_dhaas_ddemo-app__get_my_app_role")).toBe(true);
    // A non-default interface adds a segment; the split is still at the last `__`.
    expect(isConnectorTool("mcp__hosty__com_dhaas_ddemo-app__admin__list_people")).toBe(true);
    // A truncated key ends in a digest.
    expect(isConnectorTool("mcp__hosty__com_dexample_daaaaaaa-1a2b3c4d__list_people")).toBe(true);
  });

  it("rejects anything it cannot account for", () => {
    expect(isConnectorTool("mcp__hosty__something")).toBe(false);
    expect(isConnectorTool("mcp__hosty____list_people")).toBe(false);
    expect(isConnectorTool("mcp__hosty-core__list_apps")).toBe(false);
    expect(isConnectorTool("Bash")).toBe(false);
    expect(isConnectorTool(undefined)).toBe(false);
  });
});

describe("the hook process", () => {
  it("allows a connector tool, and says why", () => {
    const decision = run(JSON.stringify({ tool_name: "mcp__hosty__com_dhaas_ddemo-app__list_people" }));

    expect(decision.hookSpecificOutput.permissionDecision).toBe("allow");
    // The reason names the enforced property rather than a guess about the tool's name — that
    // distinction is the whole justification for auto-allowing.
    expect(decision.hookSpecificOutput.permissionDecisionReason).toMatch(/readOnlyHint/);
  });

  it("stays silent on everything else, leaving the normal permission flow in charge", () => {
    // Paired with the allow above: a hook that emitted nothing at all would pass every one of these
    // while doing its job for nobody.
    expect(run(JSON.stringify({ tool_name: "Bash" }))).toBeNull();
    expect(run(JSON.stringify({ tool_name: "mcp__hosty__something" }))).toBeNull();
    expect(run("not json at all")).toBeNull();
    expect(run("")).toBeNull();
  });
});
