import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isNodeEntry, resolveCodexCommand } from "../harness/codex-binary.js";

export function cleanAgentEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_USE_|CODEX_API_KEY$|OPENAI_API_KEY$|OPENAI_AUTH_TOKEN$|CODEX_HOME$|CLAUDE_CONFIG_DIR$|HOSTY_APP_SERVICE_TOKEN$)/.test(
        key,
      )
    )
      delete env[key];
  }
  return env;
}

/** Bounded login-only app-server; no agent thread or model request is started. */
export class CodexLogin {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private buffer = "";
  private pending = new Map<
    number,
    {
      resolve(value: Record<string, unknown>): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  onComplete: (success: boolean) => void = () => {};
  constructor(home: string, fileStorage = true) {
    const command = resolveCodexCommand();
    const args = [
      "app-server",
      ...(fileStorage ? ["-c", 'cli_auth_credentials_store="file"'] : []),
    ];
    this.child = isNodeEntry(command)
      ? spawn(process.execPath, [command, ...args], {
          env: { ...cleanAgentEnvironment(), CODEX_HOME: home },
          stdio: "pipe",
        })
      : spawn(command, args, {
          env: { ...cleanAgentEnvironment(), CODEX_HOME: home },
          stdio: "pipe",
        });
    this.child.stderr.resume(); // Native diagnostics can contain credentials; never forward them.
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      if (this.buffer.length > 1024 * 1024) {
        this.close();
        return;
      }
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          const pending = this.pending.get(message.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(message.id);
            if (message.error)
              pending.reject(
                new Error(
                  "Codex could not complete the authentication request.",
                ),
              );
            else pending.resolve(message.result ?? {});
          } else if (message.method === "account/login/completed")
            this.onComplete(message.params?.success === true);
        } catch {
          /* Ignore non-protocol output. */
        }
      }
    });
    this.child.stdin.on("error", () => {
      this.fail();
      this.onComplete(false);
    });
    this.child.on("error", () => {
      this.fail();
      this.onComplete(false);
    });
    this.child.on("exit", () => {
      this.fail();
      this.onComplete(false);
    });
  }
  private fail(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex login process ended."));
    }
    this.pending.clear();
  }
  request(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex authentication timed out."));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "hosty-provider-setup", version: "1" },
      capabilities: {},
    });
    this.child.stdin.write(
      `${JSON.stringify({ method: "initialized", params: {} })}\n`,
    );
  }
  close(): void {
    this.child.kill("SIGTERM");
    this.fail();
  }
}
