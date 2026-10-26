export interface ToolResult {
  type: "tool_result";
  toolUseId: string;
  status: "completed" | "failed" | "cancelled" | "unknown";
  output: string;
  truncated?: true;
  durationMs?: number;
}

export const MAX_TOOL_OUTPUT_CHARS = 32_768;
/** Optional provider execution time; malformed timing must not discard a valid outcome. */
export const toolDuration = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 604_800_000 ? value : undefined;
const safeId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
const statuses: readonly string[] = ["completed", "failed", "cancelled", "unknown"];
const fields = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Keep a clipped prefix valid when a Unicode code point straddles the character budget. */
function clippedText(text: string, limit: number): string {
  const prefix = text.slice(0, limit), last = prefix.charCodeAt(prefix.length - 1);
  return text.length > limit && last >= 0xD800 && last <= 0xDBFF ? prefix.slice(0, -1) : prefix;
}

/** These results are either hidden routing or contain private setup/answer material. */
export function shouldRetainToolOutput(toolName: string): boolean {
  return !["ToolSearch", "AskUserQuestion", "hosty:development: environment_setup", "mcp__hosty-workspaces__environment_setup"].includes(toolName);
}

/** Rebuild the display payload at each persistence/transport boundary; never copy its envelope. */
export function sanitizeToolResult(value: unknown): ToolResult | null {
  const source = fields(value);
  if (!source || source.type !== "tool_result" || !safeId(source.toolUseId)
    || typeof source.status !== "string" || !statuses.includes(source.status) || typeof source.output !== "string"
    || source.truncated !== undefined && source.truncated !== true) return null;
  return { type: "tool_result", toolUseId: source.toolUseId, status: source.status as ToolResult["status"],
    output: clippedText(source.output, MAX_TOOL_OUTPUT_CHARS),
    ...(toolDuration(source.durationMs) !== undefined ? { durationMs: toolDuration(source.durationMs) } : {}),
    ...(source.truncated === true || source.output.length > MAX_TOOL_OUTPUT_CHARS ? { truncated: true } : {}) };
}

/** Only provider tool content belongs here, never an SDK response or transport configuration. */
export function toolResult(toolUseId: string, status: ToolResult["status"], content: unknown, durationMs?: unknown): ToolResult {
  if (!safeId(toolUseId) || !statuses.includes(status)) throw new TypeError("Invalid tool result identity or status.");
  const rendered = renderContent(content);
  return { type: "tool_result", toolUseId, status, ...rendered,
    ...(toolDuration(durationMs) !== undefined ? { durationMs: toolDuration(durationMs) } : {}) };
}

function binaryPlaceholder(value: unknown): string | null {
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return "[Binary content omitted]";
  const item = fields(value);
  if (!item) return null;
  if (item.type === "image" || item.type === "image_url" || item.type === "input_image") return "[Image content omitted]";
  if (item.type === "audio" || item.type === "input_audio") return "[Audio content omitted]";
  if (item.type === "resource" && fields(item.resource)?.blob !== undefined) return "[Binary resource content omitted]";
  if (item.blob !== undefined && (item.mimeType !== undefined || item.uri !== undefined)) return "[Binary resource content omitted]";
  return null;
}

function renderContent(content: unknown): Pick<ToolResult, "output" | "truncated"> {
  let output = "", truncated = false;
  const seen = new Set<object>();
  const write = (text: string) => {
    if (truncated) return;
    const remaining = MAX_TOOL_OUTPUT_CHARS - output.length;
    output += clippedText(text, remaining);
    if (text.length > remaining) truncated = true;
  };
  const quoted = (text: string) => {
    // Limit the temporary escaped string as well as the final retained text.
    const remaining = MAX_TOOL_OUTPUT_CHARS - output.length;
    const head = clippedText(text, remaining + 1);
    write(JSON.stringify(head));
    if (head.length < text.length) truncated = true;
  };
  const json = (value: unknown, depth: number): void => {
    if (truncated) return;
    const omitted = binaryPlaceholder(value);
    if (omitted) { quoted(omitted); return; }
    if (value === null) { write("null"); return; }
    if (typeof value === "string") { quoted(value); return; }
    if (typeof value === "number" || typeof value === "boolean") { write(JSON.stringify(value)); return; }
    if (typeof value !== "object") { quoted(value === undefined ? "[No value]" : String(value)); return; }
    if (seen.has(value)) { quoted("[Circular reference]"); return; }
    if (depth >= 20) { quoted("[Maximum nesting depth reached]"); return; }
    seen.add(value);
    const array = Array.isArray(value), entries = array ? value.entries() : Object.entries(value).filter(([key]) => key !== "_meta");
    write(array ? "[" : "{");
    let count = 0;
    for (const [key, item] of entries) {
      if (truncated) break;
      write(`${count++ ? "," : ""}\n${"  ".repeat(depth + 1)}`);
      if (!array) { quoted(String(key)); write(": "); }
      json(item, depth + 1);
    }
    if (count) write(`\n${"  ".repeat(depth)}`);
    write(array ? "]" : "}");
    seen.delete(value);
  };
  const block = (value: unknown): void => {
    if (truncated) return;
    const omitted = binaryPlaceholder(value), item = fields(value);
    if (omitted) write(omitted);
    else if (typeof value === "string") write(value);
    else if (item?.type === "text" && typeof item.text === "string") write(item.text);
    else if (item?.type === "resource" && typeof fields(item.resource)?.text === "string") write(String(fields(item.resource)!.text));
    else if (value !== undefined) json(value, 0);
  };
  if (Array.isArray(content) && content.every(item => typeof item === "string" || typeof fields(item)?.type === "string")) {
    for (let index = 0; index < content.length && !truncated; index++) { if (index) write("\n"); block(content[index]); }
  } else block(content);
  return { output, ...(truncated ? { truncated: true } : {}) };
}
