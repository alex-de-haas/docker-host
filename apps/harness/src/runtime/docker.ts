import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface DockerCommands {
  run(args: string[], timeoutMs?: number): Promise<string>;
  spawn(args: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams;
}

/** Never log argv/output: exec configuration can contain a selected provider or MCP credential. */
export class DockerCli implements DockerCommands {
  spawn(args: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
    return spawn("docker", args, { env, stdio: ["pipe", "pipe", "pipe"] });
  }
  run(args: string[], timeoutMs = 30_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = this.spawn(args, process.env);
      let output = "";
      let done = false;
      const finish = (error?: Error) => {
        if (done) return;
        done = true; clearTimeout(timer);
        if (error) reject(error); else resolve(output.trim());
      };
      const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error("Docker operation timed out; its outcome requires reconciliation.")); }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.length > 2_000_000) { child.kill("SIGKILL"); finish(new Error("Docker response exceeded its limit.")); }
      });
      child.stderr.resume();
      child.stdin.end();
      child.on("error", () => finish(new Error("Docker could not be started. Check Docker Desktop and the Docker CLI.")));
      child.on("close", code => finish(code === 0 ? undefined : new Error(`Docker ${args[0]} failed (exit ${code ?? "unknown"}).`)));
    });
  }
}
