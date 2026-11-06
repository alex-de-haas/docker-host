// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/pull-requests-api", async original => ({ ...await original<object>(), prRequest: mock.request }));
import { PullRequestActions } from "./pull-request-actions";
import type { PrSummary, PrCommand } from "@/lib/pull-requests-api";
let root: Root, container: HTMLDivElement;
const pr = { repositoryId: "a".repeat(64), number: 12, head: "a".repeat(40), base: "b".repeat(40), baseBranch: "main", state: "open" } as PrSummary;
const available = { head: pr.head, base: pr.base, merge: { enabled: true }, updateBranch: { enabled: false, reason: "Up to date" }, autoMerge: "disabled" };
const changed = vi.fn();
const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent === text)!;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); mock.request.mockReset(); changed.mockReset(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it("requires confirmation, retains the head and UUID after a lost response, and recovers without creating a new command", async () => {
  let writes = 0;
  mock.request.mockImplementation(async (_path: string, command?: PrCommand) => {
    if (!command) return available;
    if (++writes === 1) throw new Error("Response lost");
    return { requestId: command.requestId, action: command.action, state: "merged", message: "Pull request merged." };
  });
  await act(async () => root.render(<PullRequestActions pr={pr} onChanged={changed} />));
  await act(async () => button("Merge").click()); expect(writes).toBe(0);
  await act(async () => button("Confirm merge").click()); expect(writes).toBe(1);
  expect(button("Merge").disabled).toBe(true); expect(container.textContent).toContain("Response lost");
  await act(async () => button("Check result").click());
  const commands = mock.request.mock.calls.filter(([, input]) => input).map(([, input]) => input);
  expect(mock.request.mock.calls.filter(([, input]) => input)[1][0]).toMatch(/actions\/recover$/);
  expect(commands).toHaveLength(2); expect(commands[0]).toEqual(commands[1]); expect(commands[0]).toMatchObject({ action: "merge", head: pr.head, base: pr.base });
  expect(container.textContent).toContain("Pull request merged."); expect(changed).toHaveBeenCalledOnce();
});
it("does not enable actions against a head that differs from the displayed PR", async () => {
  mock.request.mockResolvedValue({ ...available, head: "c".repeat(40) });
  await act(async () => root.render(<PullRequestActions pr={pr} onChanged={changed} />));
  expect(button("Merge").disabled).toBe(true); expect(container.textContent).toContain("The PR changed");
});
it("restores a pending command after remount and offers only result recovery", async () => {
  const pendingCommand = { requestId: crypto.randomUUID(), action: "update-branch", head: pr.head, base: pr.base };
  mock.request.mockResolvedValue({ ...available, pendingCommand, pendingResult: { state: "pending", message: "Update accepted." } });
  await act(async () => root.render(<PullRequestActions pr={pr} onChanged={changed} />));
  expect(button("Merge").disabled).toBe(true); expect(button("Check result")).toBeTruthy(); await act(async () => button("Check result").click());
  expect(mock.request).toHaveBeenCalledWith(expect.stringMatching(/actions\/recover$/), pendingCommand);
});
it("does not submit a confirmation after the displayed head changes", async () => {
  mock.request.mockResolvedValue(available);
  await act(async () => root.render(<PullRequestActions pr={pr} onChanged={changed} />));
  await act(async () => button("Merge").click());
  await act(async () => root.render(<PullRequestActions pr={{ ...pr, head: "c".repeat(40) }} onChanged={changed} />));
  expect(button("Confirm merge")).toBeUndefined(); expect(mock.request.mock.calls.every(([, body]) => !body)).toBe(true);
});

it("discards an old failure when the next command loses its response and recovers the new UUID", async () => {
  let writes = 0;
  mock.request.mockImplementation(async (path: string, command?: PrCommand) => {
    if (!command) return available;
    if (path.endsWith("/recover")) return { requestId: command.requestId, action: command.action, state: "merged", message: "New merge confirmed." };
    if (++writes === 1) return { requestId: command.requestId, action: command.action, state: "failed", message: "Previous attempt failed." };
    throw new Error("New response lost");
  });
  await act(async () => root.render(<PullRequestActions pr={pr} onChanged={changed} />));
  await act(async () => button("Merge").click());
  await act(async () => button("Confirm merge").click());
  expect(container.textContent).toContain("Previous attempt failed.");
  await act(async () => button("Merge").click());
  await act(async () => button("Confirm merge").click());
  expect(container.textContent).not.toContain("Previous attempt failed.");
  expect(button("Merge").disabled).toBe(true); expect(button("Check result")).toBeTruthy();
  await act(async () => button("Check result").click());
  const calls = mock.request.mock.calls.filter(([, input]) => input);
  expect(calls).toHaveLength(3); expect(calls[1][1].requestId).not.toBe(calls[0][1].requestId);
  expect(calls[2][0]).toMatch(/actions\/recover$/); expect(calls[2][1]).toEqual(calls[1][1]);
  expect(container.textContent).toContain("New merge confirmed.");
});
it("does not treat a result for another UUID as completion of the pending command", async () => {
  const pendingCommand = { requestId: crypto.randomUUID(), action: "merge", head: pr.head, base: pr.base };
  mock.request.mockResolvedValue({ ...available, pendingCommand, pendingResult: { requestId: crypto.randomUUID(), state: "failed", message: "Unrelated failure." } });
  await act(async () => root.render(<PullRequestActions pr={pr} onChanged={changed} />));
  expect(container.textContent).not.toContain("Unrelated failure.");
  expect(button("Merge").disabled).toBe(true); expect(button("Check result")).toBeTruthy();
});
it("ignores a late pending-command snapshot that predates the new command", async () => {
  let reads = 0, writes = 0;
  let oldCommand: PrCommand;
  let resolveOld!: (value: unknown) => void;
  mock.request.mockImplementation(async (path: string, command?: PrCommand) => {
    if (!command) return ++reads === 2 ? new Promise(resolve => { resolveOld = resolve; }) : available;
    if (path.endsWith("/recover")) return { requestId: command.requestId, action: command.action, state: "merged", message: "Current merge confirmed." };
    if (++writes === 1) {
      oldCommand = command;
      return { requestId: command.requestId, action: command.action, state: "failed", message: "Old failure." };
    }
    throw new Error("Response lost");
  });
  await act(async () => root.render(<PullRequestActions pr={pr} onChanged={changed} />));
  await act(async () => button("Merge").click());
  await act(async () => button("Confirm merge").click());
  await act(async () => button("Merge").click());
  await act(async () => button("Confirm merge").click());
  const current = mock.request.mock.calls.filter(([, input]) => input)[1][1];
  await act(async () => resolveOld({ ...available, pendingCommand: oldCommand,
    pendingResult: { requestId: oldCommand.requestId, state: "unknown", message: "Old pending snapshot." } }));
  expect(container.textContent).not.toContain("Old pending snapshot.");
  await act(async () => button("Check result").click());
  expect(mock.request.mock.calls.filter(([, input]) => input)[2][1]).toEqual(current);
  expect(container.textContent).toContain("Current merge confirmed.");
});
it("keeps recovery when a command response identifies a different request", async () => {
  mock.request.mockImplementation(async (_path: string, command?: PrCommand) => command
    ? { requestId: crypto.randomUUID(), action: command.action, state: "merged", message: "Another merge." } : available);
  await act(async () => root.render(<PullRequestActions pr={pr} onChanged={changed} />));
  await act(async () => button("Merge").click());
  await act(async () => button("Confirm merge").click());
  expect(container.textContent).not.toContain("Another merge.");
  expect(button("Check result")).toBeTruthy(); expect(button("Merge").disabled).toBe(true);
  expect(changed).not.toHaveBeenCalled();
});
