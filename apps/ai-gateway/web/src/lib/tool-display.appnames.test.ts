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
});
