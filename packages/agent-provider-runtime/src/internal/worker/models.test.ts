import { expect,it,vi } from "vitest";
const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query }));
it("applies Claude selection before any prompt, resets native defaults on resume and reports downgraded effort", async () => {
  const { ClaudeHarnessAdapter } = await import("../harness/claude.js");
  for (const selected of [{ model: "claude-fixture", reasoningEffort: "xhigh" }, { model: null, reasoningEffort: null }]) {
    const order: unknown[] = [], events: unknown[] = [];
    sdk.query.mockImplementation(({ prompt, options }: { prompt: AsyncIterable<unknown>; options: { resume: string } }) => Object.assign((async function* () {
      for await (const message of prompt) {
        order.push(message);
        yield { type: "system", subtype: "init", session_id: options.resume, model: "claude-fixture", effort: "high" };
        yield { type: "result", subtype: "success", session_id: options.resume }; break;
      }
    })(), { applyFlagSettings: async (value: unknown) => { order.push(value); }, interrupt: async () => {}, close() {} }));
    const run = new ClaudeHarnessAdapter().start({ sessionId: "chat", cwd: "/tmp", resumeHarnessSessionId: "same-native-context", ...selected, onEvent: event => events.push(event) });
    run.send("next prompt");
    await expect.poll(() => events.some((e: any) => e.type === "result")).toBe(true);
    expect(order[0]).toEqual({ model: selected.model, effortLevel: selected.reasoningEffort });
    expect(order[1]).toMatchObject({ type: "user" });
    expect(events).toContainEqual({ type: "harness_session", harnessSessionId: "same-native-context" });
    if (selected.reasoningEffort) expect(events).toContainEqual({ type: "notice", message: "Claude applied high instead of requested xhigh." });
    await run.stopAndWait!();
  }
});
