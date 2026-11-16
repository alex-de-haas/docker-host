import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isNodeEntry, resolveCodexCommand } from "../harness/codex-binary.js";

const codes = ["launch_failed", "native_exit", "timeout", "network", "rejected", "unsupported", "rpc_failed", "invalid_response", "output_limit", "closed", "failed"] as const;
const phases = ["startup", "initialize", "device-code", "cancel", "account-read", "usage-read", "model-read", "request", "shutdown"] as const;
const methods = ["initialize", "account/login/start", "account/login/cancel", "account/read", "account/rateLimits/read", "model/list", "other"] as const;
const errnos = new Set(["ENOENT", "EACCES", "EPERM", "ENOEXEC", "EAGAIN", "EMFILE", "ENFILE", "ENOMEM", "EPIPE", "EINVAL"]);
const signals = new Set(["SIGABRT", "SIGALRM", "SIGBUS", "SIGFPE", "SIGHUP", "SIGILL", "SIGINT", "SIGKILL", "SIGPIPE", "SIGQUIT", "SIGSEGV", "SIGTERM", "SIGTRAP", "SIGUSR1", "SIGUSR2"]);
export type CodexLoginFailureCode = typeof codes[number];
export type CodexLoginPhase = typeof phases[number];
export type CodexLoginMethod = typeof methods[number];
export type CodexLoginDiagnostic = Readonly<{
  code: CodexLoginFailureCode; phase: CodexLoginPhase; method?: CodexLoginMethod;
  rpcCode?: number; httpStatus?: number; errno?: string; exitCode?: number; signal?: string;
}>;
const descriptions: Record<CodexLoginFailureCode, string> = {
  launch_failed: "The local Codex authentication process could not launch.",
  native_exit: "The local Codex authentication process exited before completing the request.",
  timeout: "The Codex authentication request timed out.",
  network: "The Codex authentication service could not be reached or is temporarily unavailable.",
  rejected: "The Codex authentication service rejected the request.",
  unsupported: "This Codex authentication method is unavailable.",
  rpc_failed: "Codex could not complete the authentication request.",
  invalid_response: "Codex returned an invalid authentication response.",
  output_limit: "The Codex authentication process exceeded its protocol output limit.",
  closed: "The Codex authentication process was closed.",
  failed: "Codex authentication could not be completed.",
};
function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function safeDiagnostic(input: CodexLoginDiagnostic): CodexLoginDiagnostic {
  const code = codes.includes(input.code) ? input.code : "failed", phase = phases.includes(input.phase) ? input.phase : "request";
  return Object.freeze({ code, phase,
    ...(input.method && methods.includes(input.method) ? { method: input.method } : {}),
    ...(integer(input.rpcCode, -2147483648, 2147483647) ? { rpcCode: input.rpcCode } : {}),
    ...(integer(input.httpStatus, 100, 599) ? { httpStatus: input.httpStatus } : {}),
    ...(typeof input.errno === "string" && errnos.has(input.errno) ? { errno: input.errno } : {}),
    ...(integer(input.exitCode, -2147483648, 4294967295) ? { exitCode: input.exitCode } : {}),
    ...(typeof input.signal === "string" && signals.has(input.signal) ? { signal: input.signal } : {}),
  });
}
function failureMessage(diagnostic: CodexLoginDiagnostic): string {
  const facts = [`codex_login_${diagnostic.code}`, `phase=${diagnostic.phase}`];
  for (const key of ["method", "rpcCode", "httpStatus", "errno", "exitCode", "signal"] as const)
    if (diagnostic[key] !== undefined) facts.push(`${key}=${diagnostic[key]}`);
  return `${descriptions[diagnostic.code]} (${facts.join("; ")})`;
}
/** Only closed categories and validated numeric/enum facts cross the native-process boundary. */
export class CodexLoginError extends Error {
  readonly diagnostic: CodexLoginDiagnostic;
  constructor(input: CodexLoginDiagnostic) {
    const diagnostic = safeDiagnostic(input);
    super(failureMessage(diagnostic)); this.name = "CodexLoginError"; this.diagnostic = diagnostic;
    // A logged error must not expose native launch paths through its stack or cause either.
    this.stack = `${this.name}: ${this.message}`;
  }
}
export function codexLoginFailure(error: unknown): { code: CodexLoginFailureCode; message: string; diagnostic: CodexLoginDiagnostic } {
  const diagnostic = error instanceof CodexLoginError ? safeDiagnostic(error.diagnostic) : safeDiagnostic({ code: "failed", phase: "request" });
  return { code: diagnostic.code, message: failureMessage(diagnostic), diagnostic };
}
function context(method: string): { method: CodexLoginMethod; phase: CodexLoginPhase } {
  const safeMethod = methods.includes(method as CodexLoginMethod) ? method as CodexLoginMethod : "other";
  const phase: CodexLoginPhase = safeMethod === "initialize" ? "initialize" : safeMethod === "account/login/start" ? "device-code"
    : safeMethod === "account/login/cancel" ? "cancel" : safeMethod === "account/read" ? "account-read"
    : safeMethod === "account/rateLimits/read" ? "usage-read" : safeMethod === "model/list" ? "model-read" : "request";
  return { method: safeMethod, phase };
}
function launchFailure(error: unknown): CodexLoginDiagnostic {
  const errno = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return safeDiagnostic({ code: "launch_failed", phase: "startup", ...(typeof errno === "string" ? { errno } : {}) });
}
function rpcFailure(method: string, error: unknown): CodexLoginError {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const rpcCode = integer(value.code, -2147483648, 2147483647) ? value.code : undefined;
  let code: CodexLoginFailureCode = rpcCode === -32601 ? "unsupported" : rpcCode === -32602 ? "rejected" : "rpc_failed", httpStatus: number | undefined;
  // Pinned upstream request_user_code errors; inspect no URLs, arbitrary nested data or raw causes.
  if (method === "account/login/start" && typeof value.message === "string" && value.message.length <= 256) {
    const message = value.message.replace(/^failed to request device code: /, "");
    if (message === "device code login is not enabled for this Codex server. Use the browser login or verify the server URL.") {
      code = "unsupported"; httpStatus = 404;
    } else if (message === "ChatGPT login is disabled. Use API key login instead.") {
      code = "rejected";
    } else {
      const status = /^device code request failed with status ([1-5][0-9]{2})(?: ([A-Za-z -]{1,48}))?$/.exec(message);
      const reasons: Record<number, string> = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 408: "Request Timeout", 409: "Conflict", 422: "Unprocessable Entity", 429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout" };
      if (status && (status[2] === undefined || reasons[Number(status[1])] === status[2])) {
        httpStatus = Number(status[1]);
        code = httpStatus === 404 ? "unsupported" : httpStatus === 408 || httpStatus >= 500 ? "network" : "rejected";
      }
    }
  }
  return new CodexLoginError({ code, ...context(method), rpcCode, httpStatus });
}

export function cleanAgentEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_USE_|CODEX_API_KEY$|OPENAI_API_KEY$|OPENAI_AUTH_TOKEN$|CODEX_HOME$|CLAUDE_CONFIG_DIR$|HOSTY_)/.test(key)) delete env[key];
  }
  return env;
}

/** Bounded login-only app-server; no agent thread or model request is started. */
export class CodexLogin {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private buffer = "";
  private failure?: CodexLoginDiagnostic;
  private completionSent = false;
  private stopped: Promise<void>;
  private resolveStopped!: () => void;
  private pending = new Map<number, { method: string; resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  onComplete: (success: boolean) => void = () => {};
  constructor(home: string, fileStorage = true) {
    this.stopped = new Promise(resolve => { this.resolveStopped = resolve; });
    try {
      const command = resolveCodexCommand(), args = ["app-server", ...(fileStorage ? ["-c", 'cli_auth_credentials_store="file"'] : [])];
      this.child = isNodeEntry(command)
        ? spawn(process.execPath, [command, ...args], { env: { ...cleanAgentEnvironment(), CODEX_HOME: home }, stdio: "pipe" })
        : spawn(command, args, { env: { ...cleanAgentEnvironment(), CODEX_HOME: home }, stdio: "pipe" });
    } catch (error) { this.failure = launchFailure(error); this.resolveStopped(); return; }
    this.child.stderr.resume(); // Native diagnostics can contain credentials; never forward or retain them.
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      if (this.failure) return;
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer, "utf8") > 1024 * 1024) {
        this.fail({ code: "output_limit", phase: "request" }); this.close(); return;
      }
      for (;;) {
        const newline = this.buffer.indexOf("\n"); if (newline < 0) break;
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        let message: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
          message = parsed as Record<string, unknown>;
        } catch { continue; } // Non-protocol output is never exposed as diagnostics.
        const pending = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
        if (pending) {
          clearTimeout(pending.timer); this.pending.delete(message.id as number);
          if (message.error) pending.reject(rpcFailure(pending.method, message.error));
          else if (message.result && typeof message.result === "object" && !Array.isArray(message.result)) pending.resolve(message.result as Record<string, unknown>);
          else pending.reject(new CodexLoginError({ code: "invalid_response", ...context(pending.method) }));
        } else if (message.method === "account/login/completed") {
          const params = message.params as { success?: unknown } | null;
          this.complete(params?.success === true);
        }
      }
    });
    this.child.stdin.on("error", error => { this.fail(launchFailure(error)); this.complete(false); });
    this.child.on("error", error => { this.fail(launchFailure(error)); this.complete(false); });
    this.child.on("exit", (exitCode, signal) => {
      this.fail({ code: "native_exit", phase: "startup", ...(exitCode !== null ? { exitCode } : {}), ...(signal !== null ? { signal } : {}) }); this.complete(false);
    });
    this.child.once("close", this.resolveStopped);
  }
  private complete(success: boolean): void { if (!this.completionSent) { this.completionSent = true; this.onComplete(success); } }
  private fail(failure: CodexLoginDiagnostic): void {
    this.failure ??= safeDiagnostic(failure); this.buffer = "";
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.reject(new CodexLoginError({ ...this.failure, ...context(pending.method) }));
    }
    this.pending.clear();
  }
  request(method: string, params: unknown): Promise<Record<string, unknown>> {
    if (this.failure) return Promise.reject(new CodexLoginError({ ...this.failure, ...context(method) }));
    const child = this.child;
    if (!child) return Promise.reject(new CodexLoginError({ code: "launch_failed", ...context(method) }));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.fail({ code: "timeout", ...context(method) }); this.close(); }, 30_000);
      this.pending.set(id, { method, resolve, reject, timer });
      try { child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); }
      catch (error) { this.fail(launchFailure(error)); this.close(); }
    });
  }
  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "hosty-provider-setup", version: "1" }, capabilities: {} });
    if (this.failure) throw new CodexLoginError({ ...this.failure, ...context("initialize") });
    try { this.child!.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`); }
    catch (error) { this.fail(launchFailure(error)); throw new CodexLoginError({ ...this.failure!, ...context("initialize") }); }
  }
  async closeAndWait(): Promise<void> {
    this.fail({ code: "closed", phase: "shutdown" });
    // EOF lets a launcher and its native stdio consumer shut down together, including on Windows.
    try { this.child?.stdin.end(); } catch { /* Confirmation below still owns the outcome. */ }
    const signal = (value: NodeJS.Signals) => { try { this.child?.kill(value); } catch { /* Never treat an unsuccessful signal as exit proof. */ } };
    const term = setTimeout(() => signal("SIGTERM"), 250);
    const kill = setTimeout(() => signal("SIGKILL"), 1000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CodexLoginError({ code: "timeout", phase: "shutdown" })), 3000);
    });
    try { await Promise.race([this.stopped, deadline]); }
    finally { clearTimeout(term); clearTimeout(kill); clearTimeout(timer); }
  }
  close(): void {
    this.fail({ code: "closed", phase: "shutdown" });
    this.child?.kill("SIGTERM");
  }
}
