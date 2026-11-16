import { afterEach, expect, it, vi } from "vitest";
import { ClaudeHarnessAdapter } from "./harness/claude.js";
import type { HarnessEvent, HarnessRun } from "./harness/adapter.js";
const queryMock = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: (input: unknown) => queryMock(input) }));
let run: HarnessRun | undefined;
afterEach(async () => { await run?.stop(); run = undefined; vi.clearAllMocks(); });
it("reads a bounded idle control without submitting prompts, MCP or transcript scans", async () => {
  const getter = vi.fn(async () => ({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 10 } } })), close = vi.fn();
  queryMock.mockReturnValue({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: getter, close });
  expect(await new ClaudeHarnessAdapter({ CLAUDE_CODE_OAUTH_TOKEN: "fixture" }).readUsage()).toMatchObject({ state: "available", rows: [expect.objectContaining({ used: 10 })] });
  expect(getter).toHaveBeenCalledWith({ skipBehaviors: true });
  const args = queryMock.mock.calls[0]![0];
  expect(args.options).toMatchObject({ tools: [], mcpServers: {}, persistSession: false, settingSources: [] });
  expect(typeof args.prompt).not.toBe("string"); expect(args.options.abortController.signal.aborted).toBe(true); expect(close).toHaveBeenCalledOnce();
});
it("reports removed getter, missing profile scope and API-key auth without failing a chat", async () => {
  for (const getter of [undefined, vi.fn(async () => ({ rate_limits_available: false })), vi.fn(async () => { throw new Error("No profile scope"); })]) {
    queryMock.mockReturnValue({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: getter, close() {} });
    const result = await new ClaudeHarnessAdapter({ CLAUDE_CODE_OAUTH_TOKEN: "fixture" }).readUsage();
    expect(["unsupported", "unavailable"]).toContain(result.state);
  }
  queryMock.mockClear();
  expect((await new ClaudeHarnessAdapter({ ANTHROPIC_API_KEY: "fixture" }).readUsage()).state).toBe("unsupported");
  expect(queryMock).not.toHaveBeenCalled();
});
it("observes active status events and flushes a diagnostic before the successful result", async () => {
  queryMock.mockReturnValue(Object.assign((async function* () {
    yield { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour" } };
    yield { type: "result", subtype: "success" };
  })(), { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 80 } } }),
    interrupt: async () => {}, close() {} }));
  const events: HarnessEvent[] = [];
  run = new ClaudeHarnessAdapter({ CLAUDE_CODE_OAUTH_TOKEN: "fixture" }).start({ sessionId: "test", cwd: "/tmp", onEvent: event => events.push(event) });
  await vi.waitFor(() => expect(events.at(-1)?.type).toBe("result"));
  expect(events.some(event => event.type === "provider_usage" && event.usage.rows.some(row => row.status === "allowed_warning"))).toBe(true);
  expect(events.some(event => event.type === "error")).toBe(false);
});
