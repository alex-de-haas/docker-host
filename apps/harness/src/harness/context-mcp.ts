import { MAX_CONTEXT_MCP_TOOLS, readMcpContextDetail, type McpContextDetail } from "./context-sources.js";
export { MAX_CONTEXT_MCP_TOOLS, readMcpContextDetail, type McpContextDetail } from "./context-sources.js";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

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
