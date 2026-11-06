// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { TaskLimits } from "./task-limits";
import { call } from "@/lib/api";
const stream = vi.hoisted(() => ({ changed: null as null | (() => Promise<void>), stop: vi.fn() }));
vi.mock("@/lib/api", () => ({ call: vi.fn(), ApiError: class extends Error { status = 409; } }));
vi.mock("@/lib/workspace-events", () => ({ subscribeWorkspaceEvents: (_url: string, callback: () => Promise<void>) => { stream.changed = callback; return stream.stop; } }));
let root: Root, container: HTMLDivElement;
let policy: { revision: number; limitsRevision: number; limits: { maxConcurrentExecutions: number; maxDelegationDepth: number; maxDescendants: number; maxRetriesPerTask: number; maxActiveSeconds: number | null; maxCost: null }; paused: boolean; stopRequested: boolean; descendantCount: number; reservations: Record<string, { held: boolean; activeMs: number }> };
const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent === text)!;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); stream.changed = null;
  policy = { revision: 1, limitsRevision: 1, limits: { maxConcurrentExecutions: 4, maxDelegationDepth: 3, maxDescendants: 50, maxRetriesPerTask: 2, maxActiveSeconds: 1, maxCost: null },
    paused: false, stopRequested: false, descendantCount: 0, reservations: {} };
  vi.mocked(call).mockImplementation(async () => Response.json(policy));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
async function edit(value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("refreshes running usage while preserving unsaved limits and their reviewed revision", async () => {
  await act(async () => root.render(<TaskLimits rootId="root" />)); await edit("7");
  policy = { ...policy, revision: 5, limitsRevision: 2, limits: { ...policy.limits, maxConcurrentExecutions: 2 }, reservations: { run: { held: false, activeMs: 1250 } } };
  await act(async () => { await stream.changed!(); });
  expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("7");
  expect(container.textContent).toContain("Time budget reached");
  await act(async () => button("Save limits").click());
  const sent = vi.mocked(call).mock.calls.find(([, options]) => options?.method === "PUT")!;
  expect(sent[0]).toBe("/task-orchestration/v1/roots/root/limits");
  expect(JSON.parse(sent[1]!.body as string)).toMatchObject({ expectedRevision: 1, values: { maxConcurrentExecutions: 7 } });
});
it("replays the exact root limit mutation after an uncertain response", async () => {
  let first = true;
  vi.mocked(call).mockImplementation(async (_url, options) => {
    if (options?.method === "PUT" && first) { first = false; throw new Error("Reply lost"); }
    return Response.json(policy);
  });
  await act(async () => root.render(<TaskLimits rootId="root" />)); await edit("0");
  await act(async () => button("Save limits").click());
  expect(button("Check original update")).toBeDefined();
  await act(async () => button("Check original update").click());
  const calls = vi.mocked(call).mock.calls.filter(([, options]) => options?.method === "PUT");
  expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]);
});
