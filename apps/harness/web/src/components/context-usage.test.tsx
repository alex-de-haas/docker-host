// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ContextUsageIndicator } from "./context-usage";
import { applyContextUsage, emptyContextUsage } from "../lib/context-usage";
import { transcriptItems } from "../lib/transcript-items";
import type { AssistantEvent } from "../lib/assistant-api";

const usage = { usedTokens: 58100, maxTokens: 1000000, estimated: true, observedAt: "2026-10-22T12:00:00Z" };
const frame = (seq: number, value: unknown = usage): AssistantEvent => ({ seq, type: "context_usage", ts: usage.observedAt, usage: value });
afterEach(() => vi.unstubAllGlobals());
it("restores context by replay, accepts compaction/reset, and isolates sessions and stale frames", () => {
  let state = applyContextUsage(emptyContextUsage("one"), "one", frame(4));
  expect(state.usage).toEqual(usage);
  expect(applyContextUsage(state, "one", frame(3, { ...usage, usedTokens: 1 }))).toBe(state);
  expect(applyContextUsage(state, "other", frame(5))).toBe(state);
  state = applyContextUsage(state, "one", frame(5, { ...usage, usedTokens: 100 }));
  expect(state.usage?.usedTokens).toBe(100);
  expect(applyContextUsage(state, "one", frame(6, null)).usage).toBeNull();
  expect(applyContextUsage(emptyContextUsage("two"), "one", frame(8)).usage).toBeNull();
  expect(applyContextUsage(state, "one", frame(7, { ...usage, usedTokens: -1 })).usage).toBeNull();
  expect(transcriptItems([frame(4)], new Set())).toEqual([]);
});
it("renders unknown, estimated, missing-limit and over-limit usage without misleading values", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ContextUsageIndicator usage={null} />));
    expect(container.querySelector('[data-slot="context-usage"]')?.getAttribute("aria-label")).toContain("Not available");
    expect(container.textContent).toBe("?");
    expect(container.querySelector('[role="meter"]')).toBeNull();
    await act(async () => root.render(<ContextUsageIndicator usage={usage} />));
    expect(container.textContent).toBe("5.8%");
    expect(container.querySelector('[data-slot="context-usage"]')?.getAttribute("aria-label")).toContain("≈ 58.1K / 1M · 5.8%");
    expect(container.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("5.81");
    const trigger = container.querySelector<HTMLElement>('[data-slot="context-usage"]')!;
    await act(async () => trigger.focus());
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Estimated context usage: 58,100 tokens of 1,000,000");
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Last measured");
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("provider\'s compaction limit");
    await act(async () => trigger.blur());
    await act(async () => root.render(<ContextUsageIndicator usage={{ ...usage, maxTokens: null }} />));
    expect(container.textContent).toBe("?");
    expect(container.querySelector('[data-slot="context-usage"]')?.getAttribute("aria-label")).toContain("≈ 58.1K tokens · limit unavailable");
    expect(container.querySelector('[role="meter"]')).toBeNull();
    await act(async () => root.render(<ContextUsageIndicator usage={{ ...usage, usedTokens: 1100000 }} />));
    expect(container.textContent).toContain("110%");
    expect(container.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("100");
    expect(container.querySelector('[role="meter"]')?.getAttribute("aria-valuetext")).toContain("110%");
    expect(container.querySelector('circle[pathLength="100"]')?.getAttribute("stroke-dashoffset")).toBe("0");
    await act(async () => root.render(<ContextUsageIndicator usage={{ ...usage, usedTokens: 0, estimated: false }} connected={false} />));
    expect(container.textContent).toBe("0%");
    expect(container.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("0");
    expect(container.querySelector('circle[pathLength="100"]')?.getAttribute("stroke-dashoffset")).toBe("100");
    await act(async () => trigger.focus());
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Context usage: 0 tokens of 1,000,000");
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Disconnected; showing the last measurement");
  } finally { await act(async () => root.unmount()); container.remove(); }
});
