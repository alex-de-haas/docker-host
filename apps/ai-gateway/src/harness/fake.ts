import { randomUUID } from "node:crypto";
import type {
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
  HarnessRun,
  HarnessStartOptions,
} from "./adapter.js";

// Deterministic in-process harness for tests and for running the gateway on machines without
// harness credentials (HOSTY_AI_GATEWAY_HARNESS=fake). Behavior: echoes every message; a message
// containing "write" first pauses on an approval exactly like a real proposed write, and one
// containing "ask" pauses on a question.
export class FakeHarnessAdapter implements HarnessAdapter {
  readonly name = "fake";
  readonly capabilities: HarnessCapabilities = { questions: true, liveReconfigure: true };

  async probe(): Promise<{ available: boolean; reason?: string }> {
    return { available: true };
  }

  start(options: HarnessStartOptions): HarnessRun {
    return new FakeRun(options.onEvent, options.sessionId);
  }
}

class FakeRun implements HarnessRun {
  private readonly pending = new Map<string, { toolName: string }>();
  private readonly pendingQuestions = new Map<string, { question: string }>();

  constructor(
    private readonly onEvent: (event: HarnessEvent) => void,
    sessionId: string,
  ) {
    // Emitted asynchronously like a real harness init message.
    queueMicrotask(() => this.onEvent({ type: "harness_session", harnessSessionId: `fake-${sessionId}` }));
  }

  send(text: string): void {
    queueMicrotask(() => {
      if (text.includes("ask")) {
        const questionId = randomUUID();
        const question = "Which one?";
        this.pendingQuestions.set(questionId, { question });
        this.onEvent({
          type: "question_request",
          questionId,
          questions: [
            {
              question,
              header: "Choice",
              multiSelect: false,
              options: [
                { label: "First", description: "The first option." },
                { label: "Second", description: "The second option." },
              ],
            },
          ],
        });
        return;
      }

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

  // Echoes the answer back into the transcript, so a test can assert that the harness *acted on*
  // what the operator chose rather than merely that the card closed — the distinction that hid two
  // near-miss bugs in the Codex adapter.
  resolveQuestion(questionId: string, answers: Record<string, string>): boolean {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) {
      return false;
    }

    this.pendingQuestions.delete(questionId);
    queueMicrotask(() => {
      this.onEvent({ type: "assistant_text", text: `answered: ${answers[pending.question] ?? ""}` });
      this.onEvent({ type: "result", status: "success" });
    });
    return true;
  }

  /** Records what it was handed, so a test can assert the servers the gateway actually built. */
  lastMcpServers: Record<string, unknown> | null = null;

  async setMcpServers(servers: Record<string, unknown>): Promise<boolean> {
    this.lastMcpServers = servers;
    return true;
  }

  async interrupt(): Promise<void> {}

  async stop(): Promise<void> {
    this.pending.clear();
    this.pendingQuestions.clear();
  }
}
