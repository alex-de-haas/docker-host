import { MAX_CONTEXT_MCP_TOOLS, readMcpContextDetail, type McpContextDetail } from "../context-mcp.js";
import type { OllamaTool } from "./client.js";

/** Rough definition-size comparison only; Ollama applies its model-specific template later. */
export function ollamaMcpContextDetail(
  catalog: readonly OllamaTool[],
  sent: readonly OllamaTool[],
  bindings: ReadonlyMap<string, { server: string; name: string }>,
): McpContextDetail {
  const sentNames = new Set(sent.map(tool => tool.function.name));
  // Sent wire definitions take precedence over catalog copies. Local tools have no MCP binding.
  const definitions = new Map<string, OllamaTool>();
  for (const tool of [...sent, ...catalog]) {
    const alias = tool.function.name;
    if (bindings.has(alias) && !definitions.has(alias)) definitions.set(alias, tool);
  }
  return readMcpContextDetail({
    version: 1, method: "local-estimate", estimator: "utf8-json-div4-v1",
    omittedTools: Math.max(0, definitions.size - MAX_CONTEXT_MCP_TOOLS),
    tools: [...definitions.values()].slice(0, MAX_CONTEXT_MCP_TOOLS).map(tool => {
      const origin = bindings.get(tool.function.name)!;
      return { server: origin.server, name: origin.name,
        tokens: Math.ceil(Buffer.byteLength(JSON.stringify(tool), "utf8") / 4),
        inclusion: sentNames.has(tool.function.name) ? "loaded" : "available" };
    }),
  })!;
}
