// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ContextUsageIndicator } from "./context-usage";
import { applyContextUsage, emptyContextUsage } from "../lib/context-usage";
import { transcriptItems } from "../lib/transcript-items";
import type { AssistantEvent } from "../lib/assistant-api";
import type { McpActivity } from "../lib/mcp-activity";

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
    expect(container.querySelector('circle[stroke-dasharray="2 3"]')).not.toBeNull();
    expect(container.querySelector('circle[pathLength="100"]')).toBeNull();
    const center = container.querySelector('[data-slot="usage-ring-icon"]')!;
    expect(center.getAttribute("aria-hidden")).toBe("true");
    expect(center.querySelector("svg.lucide-files")).not.toBeNull();
    expect(center.className).not.toContain("rotate");
    await act(async () => root.render(<ContextUsageIndicator usage={usage} />));
    expect(container.textContent).toBe("5.8% used");
    expect(container.querySelector('[data-slot="context-usage"]')?.getAttribute("aria-label")).toContain("≈ 58.1K / 1M · 5.8%");
    expect(container.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("5.81");
    expect(container.querySelector('[role="meter"]')?.getAttribute("aria-label")).toBe("Context window used");
    expect(container.querySelector('[role="meter"]')?.getAttribute("aria-valuetext")).toContain("5.8% used");
    expect(container.querySelector('[role="meter"]')?.className).toContain("text-muted-foreground");
    const suffix = [...container.querySelectorAll("span")].find(span => span.textContent === " used")!;
    expect(suffix.classList.contains("hidden")).toBe(true);
    expect(suffix.classList.contains("@min-[640px]/composer:inline")).toBe(true);
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
    await act(async () => root.render(<ContextUsageIndicator usage={{ ...usage, usedTokens: 799000 }} />));
    expect(container.textContent).toBe("79.9% used");
    expect(container.querySelector('[role="meter"]')?.className).toContain("text-muted-foreground");
    await act(async () => root.render(<ContextUsageIndicator usage={{ ...usage, usedTokens: 800000 }} />));
    expect(container.textContent).toBe("80% used");
    expect(container.querySelector('[role="meter"]')?.className).toContain("text-warning-foreground");
    await act(async () => root.render(<ContextUsageIndicator usage={{ ...usage, usedTokens: 1000000 }} />));
    expect(container.textContent).toBe("100% used");
    expect(container.querySelector('[role="meter"]')?.className).toContain("text-destructive-foreground");
    await act(async () => root.render(<ContextUsageIndicator usage={{ ...usage, usedTokens: 1100000 }} />));
    expect(container.textContent).toBe("110% used");
    expect(container.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("100");
    expect(container.querySelector('[role="meter"]')?.getAttribute("aria-valuetext")).toContain("110%");
    expect(container.querySelector('[role="meter"]')?.className).toContain("text-destructive-foreground");
    expect(container.querySelector('circle[pathLength="100"]')?.getAttribute("stroke-dashoffset")).toBe("0");
    await act(async () => root.render(<ContextUsageIndicator usage={{ ...usage, usedTokens: 0, estimated: false }} connected={false} />));
    expect(container.textContent).toBe("0% used");
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
    const definitions = dialog.querySelector<HTMLDetailsElement>('[data-slot="mcp-definitions"]')!;
    expect(definitions.open).toBe(false);
    await act(async () => definitions.querySelector("summary")!.click());
    expect(definitions.open).toBe(true);
    expect([...definitions.querySelectorAll(":scope > div > details > summary")].map(item => item.textContent)).toEqual(["Large · 3 tools", "Small · 1 tool"]);
    const server = definitions.querySelector("details")!;
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
    expect(dialog.querySelector<HTMLDetailsElement>('[data-slot="mcp-definitions"]')?.open).toBe(false);
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
    expect(container.textContent).toBe("5.8% used");
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    for (const text of ["o200k_base BPE", "provided by Hosty", "retention after compaction is unknown", "Operator instructions", "≈ 999 tokens", "Catalog unavailable", "Partial instructions: 1"]) expect(dialog.textContent).toContain(text);
    expect(dialog.textContent).not.toContain("Loaded");
    await act(async () => root.render(<ContextUsageIndicator usage={null} />)); expect(document.querySelector('[role="dialog"]')).toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("separates recorded calls and outcomes from collapsed Codex catalog estimates", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const sources = { version: 1, method: "local-estimate", estimator: "o200k-base-chunks-1024-v1", instructions: [], omittedInstructions: 0, catalog: { state: "complete", observedAt: usage.observedAt } };
  const mcp = { version: 1, method: "local-estimate", estimator: "o200k-base-chunks-1024-v1", omittedTools: 0,
    tools: [{ server: "catalog-only", name: "unused_definition", tokens: 79000, inclusion: "unknown" }] };
  const state = applyContextUsage(emptyContextUsage("one"), "one", frame(1, { ...usage, sources, mcp }));
  const mcpActivity: McpActivity = { total: 7, tools: [
    { server: "smaller", name: "read", calls: 1, completed: 1, failed: 0, cancelled: 0, unknown: 0 },
    { server: "larger", name: "inspect", calls: 4, completed: 1, failed: 1, cancelled: 1, unknown: 1 },
    { server: "smaller", name: "search", calls: 2, completed: 0, failed: 0, cancelled: 0, unknown: 2 },
  ] };
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<ContextUsageIndicator usage={state.usage} mcpActivity={mcpActivity} />));
    expect(container.textContent).toBe("5.8% used");
    const trigger = container.querySelector<HTMLButtonElement>("button")!;
    expect(trigger.getAttribute("aria-label")).toContain("View recorded MCP calls and context detail");
    await act(async () => trigger.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    const activity = dialog.querySelector('[data-slot="mcp-activity"]')!;
    expect(activity.textContent).toContain("7 calls");
    expect(activity.textContent).toContain("Counts cover the loaded transcript");
    expect(activity.textContent).toContain("No record does not mean a tool was unused");
    expect(activity.textContent).not.toMatch(/catalog-only|unused_definition|79,000|tokens/);
    expect([...activity.querySelectorAll("summary")].map(row => row.textContent)).toEqual(["larger · 4 calls", "smaller · 3 calls"]);
    expect([...activity.querySelectorAll('[data-slot="mcp-activity-tool"]')].map(row => row.getAttribute("data-tool"))).toEqual(["inspect", "search", "read"]);
    const inspect = activity.querySelector('[data-tool="inspect"]')!;
    for (const text of ["4 calls", "Completed: 1", "Failed/refused: 1", "Cancelled: 1", "Unknown outcome: 1"]) expect(inspect.textContent).toContain(text);
    expect(dialog.textContent).toContain("Schema loading · unknown for Codex");
    expect(dialog.textContent).toContain("Actual MCP token usage · unavailable for Codex");
    const definitions = dialog.querySelector<HTMLDetailsElement>('[data-slot="mcp-definitions"]')!;
    expect(definitions.open).toBe(false);
    expect(definitions.querySelector("summary")?.textContent).toBe("Estimated available MCP definitions");
    expect(definitions.textContent).toContain("available definition sizes, not actual MCP token usage");
    await act(async () => definitions.querySelector("summary")!.click());
    expect(definitions.open).toBe(true);
    expect(definitions.textContent).toContain("≈ 79,000 tokens");
    expect(container.textContent).toBe("5.8% used");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("keeps recorded calls available without a native observation and after compaction", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const mcpActivity: McpActivity = { total: 1, tools: [{ server: "platform", name: "inspect", calls: 1, completed: 0, failed: 0, cancelled: 0, unknown: 1 }] };
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<ContextUsageIndicator usage={null} mcpActivity={mcpActivity} connected={false} />));
    expect(container.textContent).toBe("?");
    expect(container.querySelector('[role="meter"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("1 call");
    expect(dialog.textContent).toContain("Transcript replay is not caught up");
    expect(dialog.textContent).toContain("Context detail is unavailable");
    expect(dialog.textContent).not.toContain("Invalid Date");
    expect(dialog.querySelector('[data-slot="mcp-definitions"]')).toBeNull();
    await act(async () => root.render(<ContextUsageIndicator usage={usage} mcpActivity={mcpActivity} />));
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("Transcript replay is not caught up");
    expect(container.textContent).toBe("5.8% used");
    await act(async () => root.render(<ContextUsageIndicator usage={null} mcpActivity={mcpActivity} />));
    expect(document.querySelector('[data-slot="mcp-activity"]')?.textContent).toContain("1 call");
    expect(container.textContent).toBe("?");
    await act(async () => root.render(<ContextUsageIndicator usage={null} />));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("distinguishes unavailable call counts from no calls recorded in the transcript", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const mcp = { version: 1, method: "provider-estimate", omittedTools: 0, tools: [] };
  const state = applyContextUsage(emptyContextUsage("one"), "one", frame(1, { ...usage, mcp }));
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<ContextUsageIndicator usage={state.usage} />));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(document.querySelector('[data-slot="mcp-activity"]')?.textContent).toContain("Call counts are unavailable");
    expect(document.querySelector('[data-slot="mcp-activity"]')?.textContent).not.toContain("0 calls");
    await act(async () => root.render(<ContextUsageIndicator usage={null} mcpActivity={{ total: 0, tools: [] }} />));
    expect(document.querySelector('[data-slot="mcp-activity"]')?.textContent).toContain("0 calls");
    expect(document.querySelector('[data-slot="mcp-activity"]')?.textContent).toContain("No MCP calls are recorded in the loaded transcript");
    expect(document.querySelector('[data-slot="mcp-activity"]')?.textContent).not.toContain("Call counts are unavailable");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("notifies the parent when details open so lazy call counts appear with the dialog", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const observed: McpActivity = { total: 1, tools: [{ server: "platform", name: "inspect", calls: 1, completed: 1, failed: 0, cancelled: 0, unknown: 0 }] };
  const empty: McpActivity = { total: 0, tools: [] };
  const changes = vi.fn();
  function LazyDetails() {
    const [activity, setActivity] = useState(empty);
    return <ContextUsageIndicator usage={null} mcpActivity={activity} onDetailOpenChange={open => {
      changes(open); setActivity(open ? observed : empty);
    }} />;
  }
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<LazyDetails />));
    expect(changes).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const trigger = container.querySelector<HTMLButtonElement>("button")!;
    await act(async () => trigger.click());
    expect(changes).toHaveBeenLastCalledWith(true);
    expect(document.querySelector('[data-slot="mcp-activity"]')?.textContent).toContain("1 call");
    expect(document.querySelector('[data-slot="mcp-activity"]')?.textContent).not.toContain("0 calls");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(changes).toHaveBeenLastCalledWith(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => trigger.click());
    expect(document.querySelector('[data-slot="mcp-activity"]')?.textContent).toContain("1 call");
  } finally { await act(async () => root.unmount()); container.remove(); }
});
