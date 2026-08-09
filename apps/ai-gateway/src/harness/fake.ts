import { randomUUID } from "node:crypto";
import type {
  HarnessAdapter,
  HarnessEvent,
  HarnessRun,
  HarnessStartOptions,
} from "./adapter.js";

// Deterministic in-process harness for tests and for running the gateway on machines without
// harness credentials (HOSTY_AI_GATEWAY_HARNESS=fake). Behavior: echoes every message; a message
// containing "write" first pauses on an approval exactly like a real proposed write.
export class FakeHarnessAdapter implements HarnessAdapter {
  readonly name = "fake";

  async probe(): Promise<{ available: boolean; reason?: string }> {
    return { available: true };
  }

  start(options: HarnessStartOptions): HarnessRun {
    return new FakeRun(options.onEvent, options.sessionId);
  }
}

class FakeRun implements HarnessRun {
  private readonly pending = new Map<string, { toolName: string }>();

  constructor(
    private readonly onEvent: (event: HarnessEvent) => void,
    sessionId: string,
  ) {
    // Emitted asynchronously like a real harness init message.
    queueMicrotask(() => this.onEvent({ type: "harness_session", harnessSessionId: `fake-${sessionId}` }));
  }

  send(text: string): void {
    queueMicrotask(() => {
      if (text.includes("write")) {
        const approvalId = randomUUID();
        this.pending.set(approvalId, { toolName: "Write" });
        this.onEvent({
          type: "approval_request",
          approvalId,
          toolName: "Write",
          input: { file_path: "/tmp/fake.txt", content: text },
        });
        return;
      }

      this.onEvent({ type: "assistant_text", text: `echo: ${text}` });
      this.onEvent({ type: "result", status: "success" });
    });
  }

  resolveApproval(approvalId: string, decision: "allow" | "deny"): boolean {
    const pending = this.pending.get(approvalId);
    if (!pending) {
      return false;
    }

    this.pending.delete(approvalId);
    queueMicrotask(() => {
      if (decision === "allow") {
        this.onEvent({ type: "tool_use", toolName: pending.toolName, input: {} });
        this.onEvent({ type: "assistant_text", text: "written" });
      } else {
        this.onEvent({ type: "assistant_text", text: "skipped" });
      }
      this.onEvent({ type: "result", status: "success" });
    });
    return true;
  }

  async interrupt(): Promise<void> {}

  async stop(): Promise<void> {
    this.pending.clear();
  }
}
