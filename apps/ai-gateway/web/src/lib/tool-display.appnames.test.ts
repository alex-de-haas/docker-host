import { describe, expect, it } from "vitest";
import { appLabel, describeApproval, summarizeToolUse } from "./tool-display";

// A server name is the app id with dots replaced and a hash appended when that changed it — unique
// on the wire, unreadable in a transcript. The wire name cannot change (the client builds
// `mcp__<server>__<tool>` from it and grants are keyed on it), so the label is translated instead.
describe("app display names in tool labels", () => {
  const names = { "com-haas-media-server-f9a077": "Media Server" };

  it("labels a tool row with the app's name when it is known", () => {
    const summary = summarizeToolUse("mcp__com-haas-media-server-f9a077__add_torrent", {}, names);

    expect(summary.label).toBe("Media Server · add_torrent");
  });

  it("falls back to the wire name, never to a blank", () => {
    // An older gateway has no /api/apps, and discovery can fail. Both leave the transcript exactly
    // as readable as it was before display names existed — which is the point of the fallback.
    expect(summarizeToolUse("mcp__com-haas-media-server-f9a077__add_torrent", {}).label)
      .toBe("com-haas-media-server-f9a077 · add_torrent");
    expect(appLabel("unknown-server", names)).toBe("unknown-server");
    expect(appLabel("unknown-server")).toBe("unknown-server");
  });

  it("labels the approval card from the same map", () => {
    // The card is where the operator decides. It showed the same id, and a decision is not helped by
    // an unreadable subject.
    const view = describeApproval("mcp__com-haas-media-server-f9a077__add_torrent", {}, names);

    expect(view.kind).toBe("mcp");
    expect(view.kind === "mcp" && view.server).toBe("Media Server");
  });

  it("leaves a non-app tool alone", () => {
    expect(summarizeToolUse("Bash", { description: "list files" }, names).label).toBe("Shell");
  });

  it("uses explicit MCP names even when aliases and known server prefixes are ambiguous", () => {
    const mcp = { server: "foo__bar", tool: "get__item" };
    const aliases = { foo: "Wrong app", foo__bar: "Right app", foo__bar__get: "Another app" };
    expect(summarizeToolUse("mcp__foo__bar__get__item", {}, aliases, mcp).label)
      .toBe("Right app · get__item");
    expect(summarizeToolUse("mcp__foo__bar__get__item", {}, undefined, mcp).label)
      .toBe("foo__bar · get__item");
  });

  it.each([null, {}, { server: "foo__bar" }, { server: 42, tool: "get_item" }])(
    "falls back to the alias when MCP metadata is invalid: %j", (mcp) => {
      expect(summarizeToolUse("mcp__hosty-core__list_apps", {}, undefined, mcp).label)
        .toBe("hosty-core · list_apps");
    },
  );
});
