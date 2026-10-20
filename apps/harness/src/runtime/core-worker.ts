import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { DockerCommands } from "./docker.js";
import { workerEnvironment, WorkerError } from "./worker.js";

/** Adapts the existing worker lifecycle to Core's typed, installation-scoped operations. */
export class CoreWorkerCommands implements DockerCommands {
  readonly remote = true;
  private readonly generations = new Map<string, string>();
  private readonly root: string;
  constructor(origin: string, appId: string, private readonly token: string) {
    this.root = `${origin.replace(/\/$/, "")}/api/internal/apps/${encodeURIComponent(appId)}/agent-worker`;
  }
  private generation(name: string): string {
    const generation = this.generations.get(name) ?? name.match(/^hosty-agent-[a-f0-9]{12}-[a-f0-9]{12}-([a-f0-9-]{36})$/)?.[1];
    if (!generation) throw new Error("Unknown worker ownership reference.");
    return generation;
  }
  private async call(operation: string, input: object, timeoutMs: number): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.root}/${operation}`, {
        method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify(input), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new WorkerError("worker_core_unavailable", `Core worker ${operation} could not be reached. Check Core connectivity and retry.`, 503);
    }
    const body = await response.json().catch(() => ({})) as { output?: string };
    // Core's constrained worker API returns operator-facing lifecycle/admission diagnostics.
    // Keep them typed so the HTTP layer does not mask a repairable refusal as an internal error.
    if (!response.ok) throw new WorkerError("worker_operation_failed", body.output ?? (response.status === 404
      ? "This Core does not provide the agent worker API. Update Core before selecting the Docker runtime."
      : response.status === 403 ? "Core refused worker access. Check the installed assistant and its reviewed source permission."
      : `Core worker ${operation} failed (${response.status}).`), response.status === 404 ? 503 : response.status);
    if (typeof body.output !== "string") throw new Error("Core returned an invalid worker response.");
    return body.output;
  }
  async run(args: string[], timeoutMs = 30_000): Promise<string> {
    const first = args[0];
    if (first === "info" || first === "context") return this.call(first, {}, timeoutMs);
    if (first === "image" || first === "pull") return this.call(first, {}, timeoutMs);
    if (first === "create") {
      const name = args[args.indexOf("--name") + 1]!;
      const mounts = args.flatMap((value, index) => {
        if (value !== "--mount") return [];
        const mount = args[index + 1]!;
        const parts = Object.fromEntries(mount.split(",").map(part => {
          const separator = part.indexOf("=");
          return separator < 0 ? [part, ""] : [part.slice(0, separator), part.slice(separator + 1)];
        }));
        if (parts.dst === "/worker/home" || parts.dst === "/worker/cache") return [];
        return [{ source: parts.src, readonly: mount.endsWith(",readonly") }];
      });
      return this.call("create", { generation: this.generation(name), imageId: args.at(-1), mounts }, timeoutMs);
    }
    if (first === "ps") {
      const name = args[args.indexOf("--filter") + 1]!.replace(/^name=\^\//, "").replace(/\$$/, "");
      const generation = this.generation(name);
      const id = await this.call("inventory", { generation }, timeoutMs);
      if (id) this.generations.set(id, generation);
      return id;
    }
    if (first === "inspect" || first === "start" || first === "stop" || first === "rm")
      return this.call(first === "rm" ? "remove" : first, { generation: this.generation(args.at(-1)!) }, timeoutMs);
    if (first === "exec" && args[2] === "cat")
      return this.call("usage", { generation: this.generation(args[1]!) }, timeoutMs);
    if (first === "exec" && args[2] === "du")
      return this.call("disk", { generation: this.generation(args[1]!), paths: args.slice(5) }, timeoutMs);
    throw new Error("Unsupported Core worker operation.");
  }
  spawn(args: string[], environment: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
    let index = 4;
    while (args[index] === "--env") index += 2;
    const name = args[index]!, command = args[index + 1]!;
    if (args[0] !== "exec" || args[1] !== "-i" || args[2] !== "--workdir"
      || !["/opt/hosty-worker/codex", "/opt/hosty-worker/claude"].includes(command))
      throw new Error("Invalid worker execution request.");
    // The helper runs in the trusted coordinator. Neither its credentials nor configuration reach
    // agent argv/environment; Core accepts only the provider and the filtered worker environment.
    return spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./core-exec.ts", import.meta.url))], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH,
        HOSTY_WORKER_URL: `${this.root}/exec`, HOSTY_WORKER_TOKEN: this.token,
        HOSTY_WORKER_REQUEST: JSON.stringify({ generation: this.generation(name), provider: command.split("/").at(-1),
          arguments: args.slice(index + 2), cwd: args[3], environment: workerEnvironment(environment) }) },
    });
  }
}
