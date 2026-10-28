import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { AgentProcessTransport } from "../../runtime/transport.js";
import { FILE_TOOL_SCRIPT } from "./tool-script.js";

export type ToolExecution = {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
};
export function toolEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    [
      "PATH",
      "SystemRoot",
      "WINDIR",
      "TEMP",
      "TMP",
      "TMPDIR",
      "LANG",
      "LC_ALL",
    ].flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])),
  );
}
export async function stopToolGroup(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const killer = spawn(
        "taskkill",
        ["/PID", String(child.pid), "/T", "/F"],
        { stdio: "ignore" },
      );
      killer.on("error", reject);
      killer.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error("Could not confirm command tree termination.")),
      );
    });
    return;
  }
  const signal = (s: NodeJS.Signals | 0) => {
    try {
      process.kill(-child.pid!, s);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw e;
    }
  };
  if (!signal("SIGTERM")) return;
  for (let i = 0; i < 30; i++) {
    if (!signal(0)) return;
    if (i === 5) signal("SIGKILL");
    await new Promise((r) => setTimeout(r, 100));
  }
  if (signal(0))
    throw new Error(
      "Command descendants have not exited; retain the execution claim.",
    );
}
export class OllamaExecutor {
  private active = new Set<Promise<unknown>>();
  private children = new Set<ChildProcessWithoutNullStreams>();
  constructor(
    private readonly cwd: string,
    private readonly transport?: AgentProcessTransport,
  ) {}
  async execute(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    expectedHash?: string,
  ): Promise<ToolExecution> {
    signal.throwIfAborted();
    const operation = this.run(name, args, signal, expectedHash);
    this.active.add(operation);
    try {
      return await operation;
    } finally {
      this.active.delete(operation);
    }
  }
  private async terminate(
    child: ChildProcessWithoutNullStreams,
  ): Promise<void> {
    await stopToolGroup(child);
    this.children.delete(child);
  }
  private async run(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    expectedHash?: string,
  ): Promise<ToolExecution> {
    if (this.transport && !this.transport.spawnTool)
      throw new Error("This execution transport cannot run Ollama tools.");
    const options = { cwd: this.cwd, env: toolEnvironment() };
    const child = this.transport
      ? this.transport.spawnTool!(["-e", FILE_TOOL_SCRIPT], options)
      : spawn(process.execPath, ["-e", FILE_TOOL_SCRIPT], {
          ...options,
          stdio: "pipe",
          detached: process.platform !== "win32",
        });
    this.children.add(child);
    let output = "",
      bytes = 0,
      result: ToolExecution | undefined,
      failure: Error | undefined;
    const decoder = new StringDecoder("utf8");
    let stopping: Promise<void> | undefined;
    let settle!: () => void, reject!: (e: unknown) => void;
    const ready = new Promise<void>((yes, no) => {
      settle = yes;
      reject = no;
    });
    const stop = () => {
      stopping ??= this.terminate(child);
      void stopping.then(settle, reject);
    };
    const abort = () => {
      failure = new Error(
        "Tool execution was interrupted; its effect may be unknown.",
      );
      stop();
    };
    const timer = setTimeout(
      () => {
        failure = new Error(
          "Tool execution timed out; its effect may be unknown.",
        );
        stop();
      },
      name === "run_command"
        ? Math.min(Number(args.timeout_ms) || 120000, 300000)
        : 30000,
    );
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", reject);
    child.on("close", settle);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) {
        failure = new Error("Tool output exceeds its limit.");
        stop();
        return;
      }
      output += decoder.write(chunk);
      if (!output.endsWith("\n")) return;
      try {
        const value = JSON.parse(output);
        if (typeof value.ok !== "boolean")
          throw new Error("Invalid tool result.");
        result = value;
      } catch {
        failure = new Error(
          "Tool did not return a valid result; its effect may be unknown.",
        );
      }
      stop();
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ name, args, expectedHash }));
    if (signal.aborted) abort();
    try {
      await ready;
      stop();
      await stopping;
      signal.throwIfAborted();
      if (failure) throw failure;
      if (!result)
        throw new Error(
          "Tool exited without a complete result; its effect may be unknown.",
        );
      return result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      // Failed cleanup leaves the child registered. close/stopAndWait retries and cannot release it.
      if (!stopping) await this.terminate(child);
    }
  }
  async close(): Promise<void> {
    await Promise.all([...this.children].map((child) => this.terminate(child)));
    await Promise.allSettled([...this.active]);
  }
}
