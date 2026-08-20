import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { toCodexMcpConfig } from "./codex-mcp.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  HarnessAdapter,
  HarnessAvailability,
  HarnessCapabilities,
  HarnessEvent,
  HarnessRun,
  HarnessStartOptions,
} from "./adapter.js";
import {
  APPROVAL_METHODS,
  APPROVAL_POLICY,
  approvalDecision,
  CODEX_METHODS,
  describeApproval,
  type JsonRpcMessage,
} from "./codex-protocol.js";
import { isNodeEntry, resolveCodexCommand } from "./codex-binary.js";
import { authMode, ensureCodexAuth, type CodexAuthConfig } from "./codex-auth.js";

// Second harness adapter (spike outcome 2026-08-09, docs/features/ai-gateway/plan.md): OpenAI Codex
// CLI driven over `codex app-server` stdio JSON-RPC. Approvals arrive as server→client *requests*
// with an id and block until answered — the same pause the Claude adapter gets from canUseTool.
//
// Fail-closed by decision: every approval request the server raises becomes a Hosty approval card;
// nothing is auto-allowed on Codex's behalf, and "approved_for_session" is never sent.

// The pinned dependency's JS entry must run under node; a bare binary (PATH install, or the test
// stand-in with its own shebang) is spawned directly.
function spawnTarget(args: string[]): { command: string; args: string[] } {
  const resolved = resolveCodexCommand();
  return isNodeEntry(resolved)
    ? { command: process.execPath, args: [resolved, ...args] }
    : { command: resolved, args };
}

export class CodexHarnessAdapter implements HarnessAdapter {
  readonly name = "codex-app-server";
  // No questions: the mechanism exists but is experimental, off by default, and its shape is only
  // inferable from binary symbols — see REQUEST_USER_INPUT_METHOD in codex-protocol.ts. No live
  // reconfiguration either: the protocol has no setMcpServers equivalent, so a settings change here
  // takes effect at the next session and the UI must say so.
  readonly capabilities: HarnessCapabilities = { questions: false, appMcp: true, liveReconfigure: false };

  constructor(private readonly auth: CodexAuthConfig) {}

  async probe(): Promise<HarnessAvailability> {
    const probe = await runCodex(["--version"], {}).catch((error: Error) => error);
    if (probe instanceof Error) {
      return {
        available: false,
        reason: `The Codex CLI could not be started (${probe.message}). Install it on the host or set HOSTY_AI_GATEWAY_CODEX_COMMAND to its path.`,
      };
    }

    // In API-key mode this also performs (or refreshes) the login, so an operator who pastes a key
    // into app settings is signed in by the next health check without touching the host.
    const resolution = await ensureCodexAuth(this.auth);
    if (resolution.error) {
      return { available: false, reason: resolution.error };
    }

    const status = await runCodex(["login", "status"], resolution.env).catch(() => null);
    if (status === null || /not logged in|no credentials/i.test(status)) {
      // A login run without the configured CODEX_HOME writes credentials into the default home,
      // where the harness never looks — so the suggested command carries the same directory the
      // probe reads from. Only in interactive mode: the key mode owns its home and signs itself in.
      const homePrefix = resolution.env.CODEX_HOME ? `CODEX_HOME=${resolution.env.CODEX_HOME} ` : "";
      return {
        available: false,
        // Codex accepts an API key only through `login --with-api-key` (over stdin), never from the
        // environment. The operator picks the mode, so the reason names both routes.
        reason:
          resolution.mode === "api-key"
            ? "The configured Codex API key did not produce a signed-in session. Check that the key is valid, or clear it to use an interactive `codex login` on the host instead."
            : `Codex is installed but not signed in. Either run \`${homePrefix}codex login\` on the host as the user Core runs as, or set a Codex API key in this app's settings and the gateway will sign in for you.`,
      };
    }

    return { available: true };
  }

  start(options: HarnessStartOptions): HarnessRun {
    return new CodexRun(options, this.auth);
  }
}

interface PendingApproval {
  requestId: number | string;
  /** Protocol item this approval guards, so a refused item is never reported as executed. */
  itemId: string | null;
  /** The method that asked, which decides the decision vocabulary of the reply. */
  method: string;
}

class CodexRun implements HarnessRun {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pendingRequests = new Map<number | string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly approvals = new Map<string, PendingApproval>();
  // Items whose approval the operator refused. Codex still emits item/completed for them, so
  // without this the transcript would claim a refused command ran.
  private readonly deniedItems = new Set<string>();
  private readonly queue: string[] = [];
  private nextId = 1;
  private buffer = "";
  private threadId: string | null = null;
  private ready: Promise<void>;
  private turnActive = false;
  private stopped = false;
  /** The operator prompt rides on the first message only; later turns must not repeat it. */
  private systemPromptSent = false;

  constructor(
    private readonly options: HarnessStartOptions,
    auth: CodexAuthConfig,
  ) {
    // Resolved synchronously from the mode: the login itself already happened during probe, and a
    // session must not wait on it. In interactive mode this is the operator's own home.
    const env = authMode(auth) === "api-key"
      ? { CODEX_HOME: path.join(auth.dataDir, "codex-home") }
      : auth.codexHome?.trim()
        ? { CODEX_HOME: auth.codexHome.trim() }
        : {};
    // App MCP is configured at spawn time because that is the only door Codex offers: `-c`
    // overrides layered on top of whatever config it would otherwise load, with the bearer read from
    // the environment. Nothing is written to the operator's ~/.codex — these servers belong to one
    // session of one gateway, not to the machine.
    const mcp = toCodexMcpConfig(options.mcpServers);
    const target = spawnTarget(["app-server", ...mcp.args]);
    this.child = spawn(target.command, target.args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: options.cwd,
      env: { ...process.env, ...env, ...mcp.env },
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      // Codex logs routine startup noise (MCP status, OAuth refreshes) to stderr; only surface a
      // hard failure, which arrives as the process exiting.
      if (text) {
        console.warn(`[codex] ${text.slice(0, 400)}`);
      }
    });
    this.child.on("exit", (code) => {
      if (!this.stopped) {
        this.emit({ type: "error", message: `The Codex app-server exited unexpectedly (code ${code ?? "unknown"}).` });
      }
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error("codex app-server exited"));
      }
      this.pendingRequests.clear();
    });
    this.ready = this.handshake();
  }

  send(text: string): void {
    // Codex's app-server protocol exposes no instruction channel the gateway can set per session, so
    // the operator prompt rides in once as a header on the first message — the same shape the panel
    // already uses for page context. Additive by construction: it prepends, and Codex's own
    // instruction sources are untouched.
    const prompt = this.options.systemPrompt?.trim();
    if (prompt && !this.systemPromptSent) {
      this.systemPromptSent = true;
      this.queue.push(`[Hosty operator instructions]\n${prompt}\n\n${text}`);
    } else {
      this.queue.push(text);
    }
    void this.pump();
  }

  resolveApproval(approvalId: string, decision: "allow" | "deny", message?: string): boolean {
    const pending = this.approvals.get(approvalId);
    if (!pending) {
      return false;
    }

    this.approvals.delete(approvalId);
    if (decision === "deny" && pending.itemId) {
      this.deniedItems.add(pending.itemId);
    }
    this.respond(pending.requestId, {
      decision: approvalDecision(
        pending.method,
        decision,
        message ??
          "The Hosty operator refused this action. Do not attempt it another way; explain what you would have done instead.",
      ),
    });
    return true;
  }

  // Never any pending question: this adapter reports questions: false, so the manager will not route
  // one here. Present because the contract requires it, and returning false is the correct answer.
  resolveQuestion(): boolean {
    return false;
  }

  // Providers reach a Codex session at spawn time, not while it runs: Codex takes its MCP servers
  // from configuration read at startup and exposes no method to change them afterwards. So this
  // returns false and `capabilities.liveReconfigure` stays false — a toggle takes effect in the next
  // session, and the settings UI says so rather than implying immediacy.
  async setMcpServers(): Promise<boolean> {
    return false;
  }

  async interrupt(): Promise<void> {
    if (this.threadId) {
      await this.request(CODEX_METHODS.turnInterrupt, { threadId: this.threadId }).catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Release anything the harness is blocked on before tearing the process down, or the child
    // can sit forever waiting for an approval reply that will never come.
    for (const [, pending] of this.approvals) {
      this.respond(pending.requestId, {
        decision: approvalDecision(pending.method, "deny", "The session was stopped."),
      });
    }
    this.approvals.clear();
    this.child.kill("SIGTERM");
  }

  private async handshake(): Promise<void> {
    await this.request(CODEX_METHODS.initialize, {
      clientInfo: { name: "hosty-ai-gateway", version: "1" },
      capabilities: null,
    });
    this.notify(CODEX_METHODS.initialized, {});

    if (this.options.resumeHarnessSessionId) {
      const resumed = (await this.request(CODEX_METHODS.threadResume, {
        threadId: this.options.resumeHarnessSessionId,
      }).catch(() => null)) as { thread?: { id?: string } } | null;
      if (resumed) {
        this.threadId = resumed.thread?.id ?? this.options.resumeHarnessSessionId;
      }
    }

    if (!this.threadId) {
      const started = (await this.request(CODEX_METHODS.threadStart, {
        cwd: this.options.cwd,
        // MUST stay a restricted sandbox. Codex only raises an approval request when an action
        // needs to escalate *out of* its sandbox — with danger-full-access there is nothing to
        // escalate past, so writes execute silently and the approval gate is bypassed entirely
        // (observed live on 2026-08-09: three approvals were denied and the file was still
        // created). Read-only means every write escalates, which is exactly the gate we want; an
        // approved action then runs with escalated privileges, outside the sandbox.
        sandbox: "read-only",
        approvalPolicy: APPROVAL_POLICY,
      })) as { threadId?: string; thread?: { id?: string } };
      this.threadId = started.threadId ?? started.thread?.id ?? null;
    }

    if (this.threadId) {
      this.emit({ type: "harness_session", harnessSessionId: this.threadId });
    }
  }

  /** One turn at a time: Codex rejects a second turn/start while one is running. */
  private async pump(): Promise<void> {
    if (this.turnActive || this.stopped) {
      return;
    }
    const text = this.queue.shift();
    if (text === undefined) {
      return;
    }

    this.turnActive = true;
    try {
      await this.ready;
      if (!this.threadId) {
        throw new Error("Codex did not return a thread id.");
      }
      await this.request(CODEX_METHODS.turnStart, {
        threadId: this.threadId,
        input: [{ type: "text", text }],
        approvalPolicy: APPROVAL_POLICY,
        // Same reason as thread/start's sandbox: a permissive policy here silently bypasses the
        // approval gate. Note the asymmetric vocabulary — string there, tagged object here.
        sandboxPolicy: { type: "readOnly" },
      });
    } catch (error) {
      this.turnActive = false;
      if (!this.stopped) {
        this.emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    // turnActive is cleared by the turn/completed notification, which also drives the next pump.
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString();
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      try {
        this.dispatch(JSON.parse(line) as JsonRpcMessage);
      } catch {
        // A non-JSON line is log noise on stdout; ignore it rather than killing the session.
      }
    }
  }

  private dispatch(message: JsonRpcMessage): void {
    // Response to one of our requests.
    if (message.id !== undefined && !message.method && this.pendingRequests.has(message.id)) {
      const pending = this.pendingRequests.get(message.id)!;
      this.pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "Codex returned an error."));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    // Server→client request. Approvals block until answered; anything else gets a minimal reply so
    // the harness never wedges on an unimplemented capability.
    if (message.id !== undefined && message.method) {
      if (APPROVAL_METHODS.has(message.method)) {
        const approvalId = randomUUID();
        const params = message.params ?? {};
        this.approvals.set(approvalId, {
          requestId: message.id,
          itemId: typeof params.itemId === "string" ? params.itemId : null,
          method: message.method,
        });
        const { toolName, input } = describeApproval(message.method, params);
        this.emit({ type: "approval_request", approvalId, toolName, input });
      } else {
        this.respond(message.id, {});
      }
      return;
    }

    if (!message.method) {
      return;
    }

    const params = message.params ?? {};
    // Codex reports each configured MCP server's startup, which is the only signal that a provider
    // the operator enabled did not actually come up. Verified on 0.147.0 (2026-08-19): `starting`
    // then `ready` for a reachable server.
    //
    // Anything that is neither is treated as a failure rather than matching a specific status name —
    // the failure names are not part of any contract this adapter can see, and guessing at Codex's
    // vocabulary is what has bitten it before. Reporting one status too many is a visible message;
    // missing the real one leaves an app silently toolless.
    if (message.method === "mcpServer/startupStatus/updated") {
      const params = message.params as { name?: unknown; status?: unknown; error?: unknown; failureReason?: unknown } | undefined;
      const status = typeof params?.status === "string" ? params.status : "";
      if (status && status !== "starting" && status !== "ready") {
        const name = typeof params?.name === "string" ? params.name : "an app";
        const reason = typeof params?.failureReason === "string" && params.failureReason
          ? params.failureReason
          : typeof params?.error === "string" && params.error
            ? params.error
            : status;
        // A notice, not an error: this provider is optional, and the session keeps whatever else
        // started. Reporting it as an error would drop the run and fail the session over one app.
        this.emit({ type: "notice", message: `MCP server "${name}" did not start (${reason}). Its tools are unavailable for this session.` });
      }
      return;
    }

    if (message.method === "item/agentMessage/delta") {
      this.emit({ type: "assistant_delta", text: String(params.delta ?? "") });
      return;
    }

    if (message.method === "item/completed") {
      const item = (params.item ?? {}) as Record<string, unknown>;
      const type = String(item.type ?? "");
      if (type === "agentMessage") {
        const text = readItemText(item);
        if (text) {
          this.emit({ type: "assistant_text", text });
        }
      } else if (type === "commandExecution" || type === "fileChange") {
        // Codex reports a refused item as completed too; reporting it as a tool use would tell the
        // operator their denial ran anyway.
        const itemId = typeof item.id === "string" ? item.id : null;
        if (itemId && this.deniedItems.has(itemId)) {
          this.deniedItems.delete(itemId);
          return;
        }
        this.emit({
          type: "tool_use",
          toolName: type === "commandExecution" ? "Command" : "FileChange",
          input: type === "commandExecution" ? { command: item.command ?? null } : { changes: item.changes ?? null },
        });
      }
      return;
    }

    if (message.method === "turn/completed") {
      this.turnActive = false;
      const usage = (params.turn as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined;
      this.emit({
        type: "result",
        status: "success",
        usage: usage
          ? {
              inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : undefined,
              outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : undefined,
            }
          : undefined,
      });
      void this.pump();
      return;
    }

    if (message.method === "turn/failed" || message.method === "thread/error") {
      this.turnActive = false;
      this.emit({ type: "error", message: String(params.message ?? "The Codex turn failed.") });
      void this.pump();
    }
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => this.pendingRequests.set(id, { resolve, reject }));
  }

  private respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: unknown): void {
    if (!this.child.stdin.destroyed) {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  }

  private emit(event: HarnessEvent): void {
    this.options.onEvent(event);
  }
}

function readItemText(item: Record<string, unknown>): string {
  if (typeof item.text === "string") {
    return item.text;
  }
  const content = item.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text ?? "") : ""))
      .join("");
  }
  return "";
}

function runCodex(args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const target = spawnTarget(args);
    const child = spawn(target.command, target.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", (error) => reject(error));
    child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(out.trim().slice(0, 200) || `exit ${code}`))));
    setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out"));
    }, 10_000).unref();
  });
}
