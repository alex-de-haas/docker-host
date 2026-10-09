import { describe, expect, it } from "vitest";
import { ActivityTracker, activeTool, type HarnessActivity } from "./activity.js";

describe("live activity observations", () => {
  it("tracks overlapping tools by ID, coalesces progress, and resets between turns", () => {
    const states: HarnessActivity[] = [];
    const tracker = new ActivityTracker(value => states.push(value));
    tracker.reset();
    tracker.phase("r", "thinking");
    tracker.phase("r", "thinking");
    expect(states).toHaveLength(2);
    tracker.finish("r");
    tracker.start("a", activeTool("Read", { file_path: "/file" }));
    tracker.start("b", activeTool("Command"));
    tracker.start("a", activeTool("Read", { file_path: "/file" }));
    expect(states.at(-1)).toMatchObject({ tool: { toolName: "Command" }, toolCount: 2 });
    tracker.finish("a");
    expect(states.at(-1)?.toolCount).toBe(1);
    tracker.finish("b");
    expect(states.at(-1)).toEqual({ phase: "working", tool: null, toolCount: 0 });
    tracker.start("c", activeTool("Bash"));
    tracker.reset();
    expect(states.at(-1)?.tool).toBeNull();
  });

  it("bounds labels and only carries allowlisted details", () => {
    expect(activeTool("Bash", { command: "secret", token: "secret", description: "secret" })).toEqual({ toolName: "Bash" });
    expect(activeTool("Read", { file_path: "a\n".repeat(500), result: "secret" }).detail?.length).toBe(120);
    expect(activeTool("mcp__app__read", { token: "secret" }, { server: "app", tool: "read" }))
      .toEqual({ toolName: "mcp__app__read", mcp: { server: "app", tool: "read" } });
  });
});
