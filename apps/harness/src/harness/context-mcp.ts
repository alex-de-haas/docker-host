/** Portable, bounded metadata about tool definitions in one context observation. */
export type McpContextDetail = {
  version: 1;
  tools: Array<{ server: string; name: string; tokens: number; inclusion: "loaded" | "deferred" | "available" | "unknown" }>;
  omittedTools: number;
} & ({ method: "provider-estimate" } | { method: "local-estimate"; estimator: "utf8-json-div4-v1" });

export const MAX_CONTEXT_MCP_TOOLS = 256;
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const name = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
  && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);

/** Rebuild at the browser boundary too: malformed detail must not hide a valid total. */
export function readMcpContextDetail(value: unknown): McpContextDetail | undefined {
  const source = record(value);
  if (!source || source.version !== 1
    || !(source.method === "provider-estimate" || source.method === "local-estimate" && source.estimator === "utf8-json-div4-v1")
    || !Array.isArray(source.tools)
    || !count(source.omittedTools)) return undefined;
  const tools: McpContextDetail["tools"] = [], seen = new Set<string>();
  let total = 0;
  let omittedTools = source.omittedTools + Math.max(0, source.tools.length - MAX_CONTEXT_MCP_TOOLS);
  for (const value of source.tools.slice(0, MAX_CONTEXT_MCP_TOOLS)) {
    const tool = record(value);
    if (!tool || !name(tool.server) || !name(tool.name) || !count(tool.tokens)
      || typeof tool.inclusion !== "string" || !["loaded", "deferred", "available", "unknown"].includes(tool.inclusion)) { omittedTools++; continue; }
    const key = JSON.stringify([tool.server, tool.name]);
    if (seen.has(key) || !Number.isSafeInteger(total + tool.tokens)) { omittedTools++; continue; }
    total += tool.tokens;
    seen.add(key);
    tools.push({ server: tool.server, name: tool.name, tokens: tool.tokens,
      inclusion: tool.inclusion as McpContextDetail["tools"][number]["inclusion"] });
  }
  const method = source.method === "local-estimate"
    ? { method: "local-estimate" as const, estimator: "utf8-json-div4-v1" as const }
    : { method: "provider-estimate" as const };
  return { version: 1, ...method, tools, omittedTools: Math.min(Number.MAX_SAFE_INTEGER, omittedTools) };
}

/** Summary mode does not issue per-tool token-counting requests. Missing inclusion stays unknown. */
export function claudeMcpContextDetail(value: unknown): McpContextDetail | undefined {
  const source = record(value);
  if (!source || !Array.isArray(source.mcpTools)) return undefined;
  return readMcpContextDetail({ version: 1, method: "provider-estimate",
    omittedTools: Math.max(0, source.mcpTools.length - MAX_CONTEXT_MCP_TOOLS),
    tools: source.mcpTools.slice(0, MAX_CONTEXT_MCP_TOOLS).map(value => {
      const tool = record(value);
      return { server: tool?.serverName, name: tool?.name, tokens: tool?.tokens,
        inclusion: tool?.isLoaded === true ? "loaded" : tool?.isLoaded === false ? "deferred" : "unknown" };
    }) });
}
