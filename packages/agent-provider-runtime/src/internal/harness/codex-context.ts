import { MAX_CONTEXT_MCP_TOOLS, readMcpContextDetail, type McpContextDetail } from "./context-mcp.js";
import { INSTRUCTION_SOURCES, LOCAL_BPE_ESTIMATOR, validInstructionTexts, type InstructionText, type LocalContextSources } from "./context-sources.js";
import { estimateLocalTokens } from "./local-context-estimator.js";

const record = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

export function estimateInstructionSources(prompt: string | undefined, sources?: InstructionText[]): Pick<LocalContextSources, "instructions" | "omittedInstructions"> {
  const text = prompt?.trim();
  if (!text) return { instructions: [], omittedInstructions: 0 };
  const blocks = validInstructionTexts(sources) && sources.map(s => s.text).join("\n\n") === text
    ? sources : [{ source: INSTRUCTION_SOURCES[2], text }];
  const instructions: LocalContextSources["instructions"] = [];
  let omittedInstructions = 0;
  for (const block of blocks) {
    const tokens = estimateLocalTokens(block.text);
    if (tokens === undefined) omittedInstructions++;
    else instructions.push({ source: block.source, tokens });
  }
  return { instructions, omittedInstructions };
}

/** Pinned app-server 0.162.1 inventory, not a model request or loaded-context diagnostic. */
export async function readCodexMcpContext(
  request: (params: Record<string, unknown>) => Promise<unknown>,
  active: () => boolean,
): Promise<{ mcp?: McpContextDetail; catalog: LocalContextSources["catalog"] }> {
  const tools: McpContextDetail["tools"] = [];
  const cursors = new Set<string>();
  let omittedTools = 0, partial = false, pages = 0, bytes = 0, entries = 0;
  let cursor: string | undefined;
  const finish = (state: LocalContextSources["catalog"]["state"]) => ({
    ...(pages ? { mcp: readMcpContextDetail({ version: 1, method: "local-estimate", estimator: LOCAL_BPE_ESTIMATOR, tools, omittedTools }) } : {}),
    catalog: { state, observedAt: new Date().toISOString() },
  });
  try {
    do {
      if (!active()) return finish(pages ? "partial" : "unavailable");
      const page = record(await request({ cursor, limit: 32, detail: "toolsAndAuthOnly" }));
      if (!page || !Array.isArray(page.data) || page.data.length > 32) throw new Error("Invalid catalog");
      pages++;
      for (const raw of page.data) {
        const server = record(raw), catalog = record(server?.tools);
        if (!server || typeof server.name !== "string" || !catalog) { partial = true; continue; }
        if (server.toolsError || server.runtimeStatus && server.runtimeStatus !== "connected") partial = true;
        for (const value of Object.values(catalog)) {
          if (++entries > MAX_CONTEXT_MCP_TOOLS) { omittedTools++; partial = true; continue; }
          const tool = record(value);
          if (!tool || typeof tool.name !== "string" || !record(tool.inputSchema)
            || tool.description != null && typeof tool.description !== "string") { omittedTools++; continue; }
          const text = JSON.stringify({ name: tool.name, ...(typeof tool.description === "string" ? { description: tool.description } : {}), inputSchema: tool.inputSchema });
          bytes += new TextEncoder().encode(text).length;
          const tokens = bytes <= 512 * 1024 ? estimateLocalTokens(text) : undefined;
          if (tokens === undefined) omittedTools++;
          else tools.push({ server: server.name, name: tool.name, tokens, inclusion: "unknown" });
          // Let cancellation, native output and other conversations run between definitions.
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          if (!active()) return finish("partial");
        }
      }
      if (page.nextCursor != null && (typeof page.nextCursor !== "string" || !page.nextCursor || page.nextCursor.length > 4096)) throw new Error("Invalid cursor");
      cursor = page.nextCursor as string | undefined;
      if (cursor && (cursors.has(cursor) || pages >= 8 || entries >= MAX_CONTEXT_MCP_TOOLS)) return finish("partial");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const result = finish(partial || omittedTools ? "partial" : "complete");
    if (result.mcp?.omittedTools) result.catalog.state = "partial";
    return result;
  } catch { return finish(pages ? "partial" : "unavailable"); }
}
