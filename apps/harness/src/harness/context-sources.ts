/** Portable metadata only; prompt text and schemas never belong in observation events. */
export const LOCAL_BPE_ESTIMATOR = "o200k-base-chunks-1024-v1" as const;
export const INSTRUCTION_SOURCES = ["platform", "runtime", "operator"] as const;
export type InstructionSource = typeof INSTRUCTION_SOURCES[number];
export type InstructionText = { source: InstructionSource; text: string };
export interface LocalContextSources {
  version: 1;
  method: "local-estimate";
  estimator: typeof LOCAL_BPE_ESTIMATOR;
  instructions: Array<{ source: InstructionSource; tokens: number }>;
  omittedInstructions: number;
  catalog: { state: "pending" | "complete" | "partial" | "unavailable"; observedAt: string };
}

export function validInstructionTexts(value: unknown): value is InstructionText[] {
  return Array.isArray(value) && value.length <= 3 && value.every(row => row && typeof row === "object"
    && INSTRUCTION_SOURCES.includes(row.source) && typeof row.text === "string")
    && new Set(value.map(row => row.source)).size === value.length;
}

export function readLocalContextSources(value: unknown): LocalContextSources | undefined {
  const v = value as LocalContextSources | null;
  if (!v || v.version !== 1 || v.method !== "local-estimate" || v.estimator !== LOCAL_BPE_ESTIMATOR
    || !Array.isArray(v.instructions) || v.instructions.length > 3
    || !Number.isSafeInteger(v.omittedInstructions) || v.omittedInstructions < 0 || v.omittedInstructions > 3
    || !v.catalog || !["pending", "complete", "partial", "unavailable"].includes(v.catalog.state)
    || typeof v.catalog.observedAt !== "string" || !Number.isFinite(Date.parse(v.catalog.observedAt))) return undefined;
  const seen = new Set<string>();
  let total = 0;
  for (const row of v.instructions) {
    if (!row || !INSTRUCTION_SOURCES.includes(row.source) || seen.has(row.source)
      || !Number.isSafeInteger(row.tokens) || row.tokens < 0 || !Number.isSafeInteger(total + row.tokens)) return undefined;
    total += row.tokens; seen.add(row.source);
  }
  return { version: 1, method: "local-estimate", estimator: LOCAL_BPE_ESTIMATOR,
    instructions: v.instructions.map(({ source, tokens }) => ({ source, tokens })),
    omittedInstructions: v.omittedInstructions, catalog: { state: v.catalog.state, observedAt: v.catalog.observedAt } };
}

/** Portable, bounded metadata about tool definitions in one context observation. */
export type McpContextDetail = {
  version: 1;
  tools: Array<{ server: string; name: string; tokens: number; inclusion: "loaded" | "deferred" | "available" | "unknown" }>;
  omittedTools: number;
} & ({ method: "provider-estimate" } | { method: "local-estimate"; estimator: "utf8-json-div4-v1" | typeof LOCAL_BPE_ESTIMATOR });

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
    || !(source.method === "provider-estimate" || source.method === "local-estimate" && ["utf8-json-div4-v1", LOCAL_BPE_ESTIMATOR].includes(source.estimator as string))
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
    ? { method: "local-estimate" as const, estimator: source.estimator as "utf8-json-div4-v1" | typeof LOCAL_BPE_ESTIMATOR }
    : { method: "provider-estimate" as const };
  return { version: 1, ...method, tools, omittedTools: Math.min(Number.MAX_SAFE_INTEGER, omittedTools) };
}

