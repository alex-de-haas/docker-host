import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_TOOL_NAME_CHARS, escapeAppId, interfaceKey, toolName } from "./tool-key.js";

// This mapping is a port of the CLI connector's, and the point of the port is that both surfaces
// produce the *same* strings — a client's permission rules are written against them, so a divergence
// would mean a rule that works through `hosty mcp` and silently does not through the facade. The
// worked examples below are the connector's own.

describe("facade tool naming", () => {
  it("produces the name the connector produces for demo-app", () => {
    // The name a real Claude Code session has already seen through `hosty mcp`.
    expect(interfaceKey("com.haas.demo-app")).toBe("com_dhaas_ddemo-app");
    expect(toolName(interfaceKey("com.haas.demo-app"), "list_people")).toBe(
      "com_dhaas_ddemo-app__list_people",
    );
  });

  it("keeps ids distinct that a naive sanitizer would merge", () => {
    // The bug this escape exists for: replacing dots with hyphens maps these two onto one string,
    // and one app would then silently shadow the other.
    expect(escapeAppId("com.example.notes")).not.toBe(escapeAppId("com-example-notes"));
  });

  it("never emits a double underscore from an app id, whatever the id contains", () => {
    // The property the whole mapping rests on: the first `__` in a composed name is the boundary
    // between key and tool, which is only true if the escaped id can never contain one.
    for (const id of ["com.example.notes", "a_b__c", "a__b", "weird!id", "___"]) {
      expect(escapeAppId(id)).not.toContain("__");
    }
  });

  it("is injective on the ids that collide under simpler schemes", () => {
    const ids = ["a.b", "a-b", "a_b", "a_db", "a_ub", "a.b.c", "a_d_b"];
    const escaped = ids.map(escapeAppId);
    expect(new Set(escaped).size).toBe(ids.length);
  });

  it("truncates an over-long key by identity, not by position in the fleet", () => {
    const long = "com.example.a-very-long-application-identifier-here";
    const key = interfaceKey(long);

    expect(key.length).toBeLessThanOrEqual(32);
    // Stability is the property being asserted: the key depends only on its own id, so installing
    // anything else never renames this app's tools.
    expect(interfaceKey(long)).toBe(key);
    expect(interfaceKey(`${long}x`)).not.toBe(key);
  });

  it("appends a non-default interface key and leaves the default one out", () => {
    expect(interfaceKey("com.example.notes", "default")).toBe(interfaceKey("com.example.notes"));
    expect(interfaceKey("com.example.notes", "admin")).toBe("com_dexample_dnotes__admin");
  });

  it("refuses a tool it cannot name unambiguously rather than mangling it", () => {
    const key = interfaceKey("com.example.notes");

    // `__` in a tool's own name would make the boundary ambiguous: app X's tool `admin__foo` would
    // collide with X's `admin` interface offering `foo`.
    expect(toolName(key, "admin__foo")).toBeNull();
    expect(toolName(key, "")).toBeNull();

    // Over the ceiling: refused, never truncated, because truncating collides tool names with each
    // other — strictly worse than not offering one.
    expect(toolName(key, "x".repeat(DEFAULT_MAX_TOOL_NAME_CHARS))).toBeNull();
    expect(toolName(key, "ok")).toBe(`${key}__ok`);
  });
});
