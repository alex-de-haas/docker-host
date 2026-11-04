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

it("opens server/tool detail, separates inclusion, preserves replay and clears detail on reset", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const mcp = { version: 1, method: "provider-estimate", omittedTools: 2, tools: [
    { server: "Small", name: "same_name", tokens: 0, inclusion: "loaded" },
    { server: "Large", name: "same_name", tokens: 500, inclusion: "deferred" },
    { server: "Large", name: "read", tokens: 40, inclusion: "loaded" },
    { server: "Large", name: "unknown", tokens: 30, inclusion: "unknown" },
  ] };
  const state = applyContextUsage(emptyContextUsage("one"), "one", frame(4, { ...usage, mcp }));
  expect(state.usage?.mcp).toEqual(mcp);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ContextUsageIndicator usage={state.usage} connected={false} />));
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="context-usage"]')!;
    expect(trigger.type).toBe("button");
    await act(async () => trigger.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("Disconnected · last measured");
    expect(dialog.textContent).toContain("Partial detail: 2");
    expect(dialog.textContent).toContain("billed usage are not included");
    expect([...dialog.querySelectorAll("summary")].map(item => item.textContent)).toEqual(["Large · 3 tools", "Small · 1 tool"]);
    const server = dialog.querySelector("details")!;
    expect(server.querySelector("dl")?.textContent).toBe("Loaded≈ 40 tokensDeferred≈ 500 tokensUnknown inclusion≈ 30 tokens");
    expect([...server.querySelectorAll("li")].map(item => item.textContent)).toEqual([
      "same_nameDeferred≈ 500 tokens", "readLoaded≈ 40 tokens", "unknownUnknown inclusion≈ 30 tokens",
    ]);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(document.activeElement).toBe(trigger);
    await act(async () => trigger.click());
    await act(async () => root.render(<ContextUsageIndicator usage={null} />));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => root.render(<ContextUsageIndicator usage={state.usage} />));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("drops malformed detail without losing a valid meter, and distinguishes empty from unavailable", () => {
  const valid = { ...usage, mcp: { version: 1, method: "provider-estimate", omittedTools: 0, tools: [] } };
  expect(applyContextUsage(emptyContextUsage("one"), "one", frame(1, valid)).usage?.mcp?.tools).toEqual([]);
  const state = applyContextUsage(emptyContextUsage("one"), "one", frame(1, { ...usage, mcp: { version: 99 } }));
  expect(state.usage).toEqual(usage);
  expect(applyContextUsage(state, "one", frame(2, usage)).usage?.mcp).toBeUndefined();
});


it("labels replayed Ollama estimates separately from native totals and available definitions", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const mcp = { version: 1, method: "local-estimate", estimator: "utf8-json-div4-v1", omittedTools: 0,
    tools: [{ server: "Fixture", name: "sent", tokens: 30, inclusion: "loaded" },
      { server: "Fixture", name: "catalog_only", tokens: 500, inclusion: "available" }] };
  const state = applyContextUsage(emptyContextUsage("one"), "one", frame(1, { ...usage, estimated: false, mcp }));
  expect(state.usage?.mcp).toEqual(mcp);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ContextUsageIndicator usage={state.usage} />));
    const button = container.querySelector<HTMLButtonElement>("button")!;
    expect(button.getAttribute("aria-label")).not.toContain("≈");
    await act(async () => button.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Local estimate · UTF-8 JSON bytes ÷ 4, rounded up");
    expect(dialog.textContent).toContain("does not use the model tokenizer or prompt template");
    expect(dialog.querySelector("dl")?.textContent).toBe("Sent in request≈ 30 tokensAvailable, not sent≈ 500 tokens");
    expect(dialog.textContent).not.toContain("Deferred");
    expect(dialog.textContent).not.toContain("Claude");
    expect([...dialog.querySelectorAll("li")].map(t => t.textContent)).toEqual([
      "catalog_onlyAvailable, not sent≈ 500 tokens", "sentSent in request≈ 30 tokens",
    ]);
    await act(async () => root.render(<ContextUsageIndicator usage={null} />));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); }
});


it("shows instruction-only Codex estimates when the catalog is unavailable, preserving the native meter", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const sources = { version: 1, method: "local-estimate", estimator: "o200k-base-chunks-1024-v1", instructions: [{ source: "operator", tokens: 999 }], omittedInstructions: 1, catalog: { state: "unavailable", observedAt: usage.observedAt } };
  const state = applyContextUsage(emptyContextUsage("one"), "one", frame(1, { ...usage, sources }));
  expect(state.usage?.sources).toEqual(sources);
  expect(applyContextUsage(state, "one", frame(2, { ...usage, sources: { ...sources, version: 2 } })).usage).toEqual(usage);
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<ContextUsageIndicator usage={state.usage} />));
    expect(container.textContent).toBe("5.8%");
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    for (const text of ["o200k_base BPE", "provided by Hosty", "retention after compaction is unknown", "Operator instructions", "≈ 999 tokens", "Catalog unavailable", "Partial instructions: 1"]) expect(dialog.textContent).toContain(text);
    expect(dialog.textContent).not.toContain("Loaded");
    await act(async () => root.render(<ContextUsageIndicator usage={null} />)); expect(document.querySelector('[role="dialog"]')).toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); }
});
