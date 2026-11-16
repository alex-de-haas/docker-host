import { shouldRetainToolOutput as retainSharedOutput } from "@hosty/agent-provider-runtime/harness/tool-result";

/** Native routing and questions contain no transcript output. */
export const shouldRetainToolOutput = (name: string): boolean =>
  !["ToolSearch", "AskUserQuestion"].includes(name) && retainSharedOutput(name);
