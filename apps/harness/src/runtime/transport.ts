import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** A ready execution destination. Creating it is asynchronous; adapter spawning stays synchronous. */
export interface AgentProcessTransport {
  spawn(provider: "codex" | "claude", args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcessWithoutNullStreams;
}
