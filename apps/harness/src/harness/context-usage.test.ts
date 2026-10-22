import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeContextUsage, codexContextUsage, ContextUsageReader } from "./context-usage.js";

afterEach(() => vi.useRealTimers());
describe("context measurements", () => {
  it("uses the latest Codex total without adding cached or reasoning tokens a second time", () => {
    expect(codexContextUsage({ total: { totalTokens: 900000 }, last: {
      totalTokens: 58000, inputTokens: 50000, cachedInputTokens: 40000, outputTokens: 8000, reasoningOutputTokens: 7000,
    }, modelContextWindow: 1000000 })).toMatchObject({ usedTokens: 58000, maxTokens: 1000000, estimated: true });
  });
  it("uses Claude's current compaction window and treats zero usage as a real measurement", () => {
    expect(claudeContextUsage({ totalTokens: 0, maxTokens: 180000, rawMaxTokens: 1000000, percentage: 70 }))
      .toMatchObject({ usedTokens: 0, maxTokens: 180000 });
  });
  it.each([undefined, null, -1, Infinity, NaN, "200", 1.5])("does not invent a missing/invalid window (%s)", limit => {
    expect(claudeContextUsage({ totalTokens: 20, maxTokens: limit })?.maxTokens).toBeNull();
  });
  it.each([undefined, null, -1, Infinity, NaN, "20", 1.5])("rejects invalid usage (%s)", used => {
    expect(claudeContextUsage({ totalTokens: used, maxTokens: 200 })).toBeNull();
  });
  it("keeps over-limit and smaller post-compaction values", () => {
    expect(claudeContextUsage({ totalTokens: 220, maxTokens: 200 })?.usedTokens).toBe(220);
    expect(codexContextUsage({ last: { totalTokens: 10 }, modelContextWindow: null })?.usedTokens).toBe(10);
  });
});
describe("bounded context diagnostics", () => {
  it("coalesces requests and discards an obsolete response before reporting the fresh one", async () => {
    let resolve!: (value: ReturnType<typeof claudeContextUsage>) => void;
    const fresh = claudeContextUsage({ totalTokens: 20, maxTokens: 100 });
    const read = vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValue(fresh);
    const report = vi.fn(), reader = new ContextUsageReader(read, report);
    const first = reader.refresh(); await Promise.resolve();
    const second = reader.refresh(); void reader.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    resolve(claudeContextUsage({ totalTokens: 90, maxTokens: 100 }));
    await Promise.all([first, second]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(report.mock.calls).toEqual([[fresh]]);
    reader.close();
  });
  it("does not lose a refresh queued immediately after publishing a completed read", async () => {
    const read = vi.fn().mockResolvedValue(claudeContextUsage({ totalTokens: 20, maxTokens: 100 }));
    let next: Promise<void> | undefined;
    const report = vi.fn().mockImplementationOnce(() => queueMicrotask(() => { next = reader.refresh(); }));
    const reader = new ContextUsageReader(read, report);
    await reader.refresh(); await next;
    expect(read).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledTimes(2);
    reader.close();
  });
  it("reports unavailable after failure and can recover on the next event", async () => {
    const fresh = claudeContextUsage({ totalTokens: 20, maxTokens: 100 });
    const read = vi.fn().mockRejectedValueOnce(new Error("unsupported")).mockResolvedValue(fresh);
    const report = vi.fn(), reader = new ContextUsageReader(read, report);
    await reader.refresh(); await reader.refresh();
    expect(report.mock.calls).toEqual([[null], [fresh]]);
    reader.close();
  });
  it("bounds a stuck request and suppresses late results and further requests", async () => {
    vi.useFakeTimers();
    let resolve!: (value: ReturnType<typeof claudeContextUsage>) => void;
    const read = vi.fn(() => new Promise<ReturnType<typeof claudeContextUsage>>(r => { resolve = r; }));
    const report = vi.fn(), reader = new ContextUsageReader(read, report, 50);
    const pending = reader.refresh();
    await vi.advanceTimersByTimeAsync(50); await pending;
    resolve(claudeContextUsage({ totalTokens: 40, maxTokens: 100 })); await Promise.resolve();
    await reader.refresh();
    expect(report.mock.calls).toEqual([[null]]); expect(read).toHaveBeenCalledTimes(1);
    reader.close();
  });
  it("unblocks finalization on close without publishing an in-flight result", async () => {
    let resolve!: (value: ReturnType<typeof claudeContextUsage>) => void;
    const report = vi.fn(), reader = new ContextUsageReader(() => new Promise(r => { resolve = r; }), report);
    const pending = reader.refresh(); await Promise.resolve(); reader.close(); await pending;
    resolve(claudeContextUsage({ totalTokens: 40, maxTokens: 100 })); await Promise.resolve();
    expect(report).not.toHaveBeenCalled();
  });
});
