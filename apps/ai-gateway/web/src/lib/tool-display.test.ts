import { describe, expect, it } from "vitest";
import { describeApproval, parseMcpToolName, summarizeToolUse } from "./tool-display";

describe("summarizeToolUse", () => {
  it("prefers the model's description of a shell command to the command itself", () => {
    const summary = summarizeToolUse("Bash", {
      command: "hosty apps update-plan com.haas.solitaire",
      description: "Get update plan for solitaire app",
    });
    expect(summary).toEqual({ label: "Shell", detail: "Get update plan for solitaire app" });

    // Without a description the command is what there is — first line only, since a heredoc would
    // otherwise put a script into a row.
    expect(summarizeToolUse("Bash", { command: "cat <<'EOF' > x\nline\nEOF" }).detail).toBe("cat <<'EOF' > x");
  });

  it("names an app tool by server and tool, with scalar arguments on the line", () => {
    const summary = summarizeToolUse("mcp__hosty-core__get_app", { appId: "com.haas.solitaire", nested: { a: 1 } });
    expect(summary).toEqual({ label: "hosty-core · get_app", detail: "appId: com.haas.solitaire" });
  });

  it("bounds a long line rather than letting it wrap the row", () => {
    const detail = summarizeToolUse("Read", { file_path: `/${"x".repeat(200)}` }).detail!;
    expect(detail.length).toBeLessThanOrEqual(96);
    expect(detail.endsWith("…")).toBe(true);
  });

  it("degrades to a bare label on an unknown tool or an unexpected input shape", () => {
    expect(summarizeToolUse("Mystery", "not an object")).toEqual({ label: "Mystery", detail: null });
    expect(summarizeToolUse("Bash", null).detail).toBeNull();
  });
});

describe("parseMcpToolName", () => {
  it("splits on the first double underscore so a server name may carry single ones", () => {
    expect(parseMcpToolName("mcp__com_example_notes__list_people")).toEqual({
      server: "com_example_notes",
      tool: "list_people",
    });
    expect(parseMcpToolName("Bash")).toBeNull();
    expect(parseMcpToolName("mcp__nothing")).toBeNull();
  });
});

describe("describeApproval", () => {
  it("shows a shell command under its description, with the command intact", () => {
    const view = describeApproval("Bash", {
      command: "hosty apps update hosty.shell --plan-digest abc",
      description: "Update hosty.shell app to 0.69.0",
    });
    expect(view).toEqual({
      kind: "command",
      heading: "Update hosty.shell app to 0.69.0",
      command: "hosty apps update hosty.shell --plan-digest abc",
      cwd: null,
    });
  });

  it("carries Codex's working directory for a command", () => {
    expect(describeApproval("Command", { command: "ls", cwd: "/srv", reason: null })).toMatchObject({
      kind: "command",
      cwd: "/srv",
    });
  });

  it("renders an edit as the text removed and the text inserted", () => {
    const view = describeApproval("Edit", { file_path: "/etc/x.conf", old_string: "a=1", new_string: "a=2" });
    expect(view).toEqual({
      kind: "file",
      heading: "Edit a file",
      changes: [{ path: "/etc/x.conf", kind: "edit", before: "a=1", after: "a=2", diff: null }],
    });
  });

  it("shows the root a Codex file change asks for when the request carries no change list", () => {
    // The request names the item and the root; the changes live on the item. An empty "Change files"
    // card would hide the only thing the request says about where it is going to write.
    expect(describeApproval("FileChange", { changes: null, grantRoot: "/srv/app", reason: "needs write access" })).toEqual({
      kind: "file",
      heading: "Write under a directory",
      changes: [{ path: "/srv/app", kind: "write access", before: null, after: null, diff: null }],
    });
    // Neither a list nor a root: the raw payload, never a heading over nothing.
    expect(describeApproval("FileChange", { changes: null, grantRoot: null })).toMatchObject({ kind: "generic" });
  });

  it("reads Codex's change list, including a tagged kind and a ready-made diff", () => {
    const view = describeApproval("FileChange", {
      changes: [{ path: "/srv/a.txt", kind: { type: "update" }, diff: "-old\n+new" }],
      reason: "needs write access",
    });
    expect(view).toMatchObject({
      kind: "file",
      changes: [{ path: "/srv/a.txt", kind: "update", diff: "-old\n+new" }],
    });
  });

  it("lists an app tool's arguments by name, strings verbatim and the rest as JSON", () => {
    const view = describeApproval("mcp__notes__delete_person", { id: "p1", force: true });
    expect(view).toEqual({
      kind: "mcp",
      heading: "delete_person",
      server: "notes",
      tool: "delete_person",
      args: [
        ["id", "p1"],
        ["force", "true"],
      ],
    });
  });

  it("falls back to JSON for anything it does not know, without throwing", () => {
    expect(describeApproval("Bash", { description: "no command here" })).toMatchObject({ kind: "generic" });
    expect(describeApproval("Whatever", 42)).toEqual({ kind: "generic", heading: "Whatever", json: "{}" });
  });
});
