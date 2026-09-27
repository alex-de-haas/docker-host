import { describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "./harness/adapter.js";

// The Claude adapter's question mechanism, tested against a stand-in for the Agent SDK.
//
// The gateway suite exercises the plumbing through the fake harness, which proves the route, the
// event log and the 409 — but not the one thing that actually makes questions work: that the answer
// goes back as `updatedInput.answers` on an *allow*, so the tool runs and returns the answers to the
// model. Get that wrong and every visible symptom is identical to a working feature: the card
// renders, the operator picks, the card closes. Only the model's next turn differs, and by then the
// bug looks like the model being obtuse.
//
// The SDK is mocked rather than run: driving the real one needs credentials and a network turn, so
// it belongs in the live check. What is pinned here is the shape this adapter constructs.

const queryMock = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => queryMock(args),
}));

/** Starts a run and hands back the canUseTool the adapter registered with the SDK. */
async function startRun(): Promise<{
  canUseTool: (tool: string, input: Record<string, unknown>) => Promise<unknown>;
  events: HarnessEvent[];
  run: import("./harness/adapter.js").HarnessRun;
}> {
  const events: HarnessEvent[] = [];
  let captured: ((tool: string, input: Record<string, unknown>) => Promise<unknown>) | null = null;

  queryMock.mockImplementation((args: { options: { canUseTool: typeof captured } }) => {
    captured = args.options.canUseTool;
    // A query object that never yields: the run stays open, which is what a paused turn looks like.
    return Object.assign(
      { async *[Symbol.asyncIterator]() {} },
      { interrupt: async () => undefined, close: () => undefined },
    );
  });

  const { ClaudeHarnessAdapter } = await import("./harness/claude.js");
  const run = new ClaudeHarnessAdapter().start({
    sessionId: "s1",
    cwd: "/tmp",
    onEvent: (event) => events.push(event),
  });

  // The adapter imports the SDK asynchronously inside its run loop.
  for (let attempt = 0; attempt < 50 && !captured; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!captured) {
    throw new Error("the adapter never registered canUseTool");
  }

  return { canUseTool: captured, events, run };
}

const QUESTION_INPUT = {
  questions: [
    {
      question: "Which media server?",
      header: "Server",
      multiSelect: false,
      options: [
        { label: "Jellyfin", description: "The installed one." },
        { label: "Plex", description: "Not installed." },
      ],
    },
  ],
};

describe("claude adapter questions", () => {
  it("returns the answer as updatedInput.answers on an allow", async () => {
    const { canUseTool, events, run } = await startRun();

    const pending = canUseTool("AskUserQuestion", { ...QUESTION_INPUT });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const asked = events.find((event) => event.type === "question_request");
    expect(asked).toBeDefined();
    if (asked?.type !== "question_request") {
      throw new Error("unreachable");
    }
    expect(asked.questions[0]?.options.map((option) => option.label)).toEqual(["Jellyfin", "Plex"]);

    expect(run.resolveQuestion(asked.questionId, { "Which media server?": "Jellyfin" })).toBe(true);

    // The exact contract: an allow (not a deny carrying the answer in its message, which the model
    // would be free to read as a refusal), and the original input preserved with answers merged in
    // under the SDK's own keying — question text to chosen label.
    await expect(pending).resolves.toEqual({
      behavior: "allow",
      updatedInput: {
        ...QUESTION_INPUT,
        answers: { "Which media server?": "Jellyfin" },
      },
    });
  });

  it("reports an unknown question id rather than resolving something else", async () => {
    const { canUseTool, run } = await startRun();
    void canUseTool("AskUserQuestion", { ...QUESTION_INPUT });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(run.resolveQuestion("not-a-question", { "Which media server?": "Plex" })).toBe(false);
  });

  it("declines a malformed ask instead of parking the run on an unrenderable card", async () => {
    // A question with no options cannot be shown as a choice. Parking it would block the turn on a
    // card the panel cannot draw and nobody can resolve, so the model is told to ask in prose.
    const { canUseTool, events } = await startRun();

    const response = (await canUseTool("AskUserQuestion", {
      questions: [{ question: "Anything?", header: "X", multiSelect: false, options: [] }],
    })) as { behavior: string; message?: string };

    expect(response.behavior).toBe("deny");
    expect(response.message).toContain("plain text");
    expect(events.some((event) => event.type === "question_request")).toBe(false);
  });

  it("still pauses non-question writes on an approval", async () => {
    // Guards the branch order: AskUserQuestion is handled first, but everything else must keep
    // reaching the approval gate rather than falling into the question path.
    const { canUseTool, events } = await startRun();

    void canUseTool("Write", { file_path: "/tmp/x", content: "y" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(events.some((event) => event.type === "approval_request")).toBe(true);
    expect(events.some((event) => event.type === "question_request")).toBe(false);
  });
});
