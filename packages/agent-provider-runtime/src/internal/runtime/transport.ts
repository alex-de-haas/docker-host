import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type AgentSpawnOptions = { cwd: string; env: NodeJS.ProcessEnv; command?: string; signal?: AbortSignal; bearerVariables?: readonly string[] };

/** A ready execution destination. Creating it is asynchronous; adapter spawning stays synchronous. */
export interface AgentProcessTransport {
  stopProcess?(child: ChildProcessWithoutNullStreams): Promise<void>;
  waitForTargetExit?(child: ChildProcessWithoutNullStreams): Promise<void>;
  spawnTool?(args: string[], options: AgentSpawnOptions): ChildProcessWithoutNullStreams;
  spawnCommand?(command: string, args: string[], options: AgentSpawnOptions): ChildProcessWithoutNullStreams;
  spawn(command: string, args: string[], options: AgentSpawnOptions): ChildProcessWithoutNullStreams;
}
