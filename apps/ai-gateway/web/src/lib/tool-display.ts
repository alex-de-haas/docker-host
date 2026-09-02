// What a tool call looks like to the operator: a one-line summary for the transcript row and a typed
// view for the approval card. Pure, so both can be unit-tested without rendering anything.
//
// The shapes read here are the harnesses' own — Claude Code's built-in tool inputs (Bash carries
// `command` and `description`, Edit `old_string`/`new_string`, Write `content`), the Codex adapter's
// `Command`/`FileChange` descriptions, and the `mcp__<server>__<tool>` naming a client gives an app
// tool. Every read is defensive: an unexpected shape degrades to the generic JSON view, never to a
// crash in the one component that has to render whatever the harness sent.

type Fields = Record<string, unknown>;

/** Longest one-line summary a transcript row shows before it is cut. */
const MAX_SUMMARY_CHARS = 96;

export interface ToolSummary {
  /** The row's label: the tool's name, or "server · tool" for an app tool. */
  label: string;
  /** One line about this particular call, or null when the input offers nothing readable. */
  detail: string | null;
}

export interface FileChangeView {
  path: string | null;
  kind: string | null;
  /** Text an edit removes. */
  before: string | null;
  /** Text an edit inserts, or the whole content of a write. */
  after: string | null;
  /** A ready-made diff, when the harness sent one instead of before/after. */
  diff: string | null;
}

export type ApprovalView =
  | { kind: "command"; heading: string; command: string; cwd: string | null }
  | { kind: "file"; heading: string; changes: FileChangeView[] }
  | { kind: "mcp"; heading: string; server: string; tool: string; args: Array<[string, string]> }
  | { kind: "generic"; heading: string; json: string };

/** Splits `mcp__server__tool` into its parts, or null for a tool that is not an MCP one. */
export function parseMcpToolName(toolName: string): { server: string; tool: string } | null {
  const prefix = "mcp__";
  if (!toolName.startsWith(prefix)) {
    return null;
  }
  const rest = toolName.slice(prefix.length);
  // The first double underscore is the seam: a server name may carry single underscores, and the
  // client that built the name put the seam after the server, not after the tool.
  const seam = rest.indexOf("__");
  if (seam <= 0 || seam + 2 >= rest.length) {
    return null;
  }
  return { server: rest.slice(0, seam), tool: rest.slice(seam + 2) };
}

export function summarizeToolUse(toolName: string, input: unknown): ToolSummary {
  const fields = asFields(input);
  const mcp = parseMcpToolName(toolName);
  if (mcp) {
    return { label: `${mcp.server} · ${mcp.tool}`, detail: oneLine(summarizeArguments(fields)) };
  }

  switch (toolName) {
    case "Bash":
      // The model's own description of what the command is for reads better than the command, and
      // is what the operator scanning a transcript wants; the command itself is one click away.
      return { label: "Shell", detail: oneLine(text(fields.description) ?? text(fields.command)) };
    case "Command":
      return { label: "Command", detail: oneLine(text(fields.command)) };
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return { label: toolName, detail: oneLine(text(fields.file_path)) };
    case "NotebookEdit":
      return { label: toolName, detail: oneLine(text(fields.notebook_path)) };
    case "Glob":
    case "Grep":
      return { label: toolName, detail: oneLine(joinPresent([text(fields.pattern), text(fields.path)], " in ")) };
    case "WebFetch":
      return { label: toolName, detail: oneLine(text(fields.url)) };
    case "WebSearch":
      return { label: toolName, detail: oneLine(text(fields.query)) };
    case "Task":
      return { label: "Subagent", detail: oneLine(text(fields.description)) };
    case "FileChange":
      return { label: "File change", detail: oneLine(changedPaths(fields.changes)) };
    default:
      return { label: toolName, detail: null };
  }
}

export function describeApproval(toolName: string, input: unknown): ApprovalView {
  const fields = asFields(input);
  const mcp = parseMcpToolName(toolName);
  if (mcp) {
    return { kind: "mcp", heading: mcp.tool, server: mcp.server, tool: mcp.tool, args: argumentsOf(fields) };
  }

  switch (toolName) {
    case "Bash": {
      const command = text(fields.command);
      if (command !== null) {
        return { kind: "command", heading: text(fields.description) ?? "Run a shell command", command, cwd: null };
      }
      break;
    }
    case "Command": {
      const command = text(fields.command);
      if (command !== null) {
        return { kind: "command", heading: "Run a command", command, cwd: text(fields.cwd) };
      }
      break;
    }
    case "Edit":
      return {
        kind: "file",
        heading: "Edit a file",
        changes: [change(text(fields.file_path), "edit", text(fields.old_string), text(fields.new_string))],
      };
    case "MultiEdit": {
      const path = text(fields.file_path);
      const edits = Array.isArray(fields.edits) ? fields.edits : [];
      return {
        kind: "file",
        heading: "Edit a file",
        changes: edits.map((edit) => {
          const each = asFields(edit);
          return change(path, "edit", text(each.old_string), text(each.new_string));
        }),
      };
    }
    case "Write":
      return { kind: "file", heading: "Write a file", changes: [change(text(fields.file_path), "write", null, text(fields.content))] };
    case "NotebookEdit":
      return {
        kind: "file",
        heading: "Edit a notebook",
        changes: [change(text(fields.notebook_path), text(fields.edit_mode) ?? "edit", null, text(fields.new_source))],
      };
    case "FileChange":
      return { kind: "file", heading: "Change files", changes: fileChanges(fields.changes) };
    default:
      break;
  }

  return { kind: "generic", heading: toolName, json: JSON.stringify(fields, null, 2) };
}

function change(path: string | null, kind: string, before: string | null, after: string | null): FileChangeView {
  return { path, kind, before, after, diff: null };
}

/** Codex's `changes` array. Its entries name a path and a kind, and carry a diff when there is one. */
function fileChanges(value: unknown): FileChangeView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    const each = asFields(entry);
    const kind = asFields(each.kind);
    return {
      path: text(each.path),
      kind: text(each.kind) ?? text(kind.type),
      before: null,
      after: text(each.content),
      diff: text(each.diff) ?? text(each.unified_diff),
    };
  });
}

function changedPaths(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const paths = value.map((entry) => text(asFields(entry).path)).filter((path): path is string => path !== null);
  return paths.length > 0 ? paths.join(", ") : null;
}

/** Argument names and values as the card lists them: strings as they are, anything else as JSON. */
function argumentsOf(fields: Fields): Array<[string, string]> {
  return Object.entries(fields).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]);
}

/** `key: value` pairs for a row, scalars only — a nested object says nothing useful in one line. */
function summarizeArguments(fields: Fields): string | null {
  const parts = Object.entries(fields)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    .map(([key, value]) => `${key}: ${String(value)}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

function asFields(value: unknown): Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function joinPresent(parts: Array<string | null>, separator: string): string | null {
  const present = parts.filter((part): part is string => part !== null);
  return present.length > 0 ? present.join(separator) : null;
}

/** The first line, trimmed and bounded, or null when there is nothing to show. */
function oneLine(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const line = value.split("\n", 1)[0]!.trim();
  if (line.length === 0) {
    return null;
  }
  return line.length > MAX_SUMMARY_CHARS ? `${line.slice(0, MAX_SUMMARY_CHARS - 1)}…` : line;
}
