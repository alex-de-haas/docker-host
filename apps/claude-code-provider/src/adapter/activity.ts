import { activeTool as normalizedTool, type ActiveTool } from "@hosty/agent-provider-runtime/harness/activity";

/** Only native file tools expose their allowlisted path as a display detail. */
export function activeTool(toolName: string, input?: unknown): ActiveTool {
  const fields = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const detail = ["Read", "Write", "Edit", "MultiEdit"].includes(toolName) && typeof fields.file_path === "string"
    ? fields.file_path : undefined;
  return normalizedTool(toolName, detail);
}
