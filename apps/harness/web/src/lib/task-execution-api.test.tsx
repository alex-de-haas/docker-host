// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { call } from "./api";
import { useTaskExecutionSummary, type TaskExecutionSummary } from "./task-execution-api";
const stream = vi.hoisted(() => ({ changed: null as null | (() => Promise<void>), stop: vi.fn() }));
vi.mock("./api", () => ({ call: vi.fn() }));
vi.mock("./workspace-events", () => ({ subscribeWorkspaceEvents: (_url: string, callback: () => Promise<void>) => { stream.changed = callback; return stream.stop; } }));
let root: Root, container: HTMLDivElement;
const page = (count: number, start = 0, nextCursor: string | null = null, revision = "one"): TaskExecutionSummary => ({ revision, roots: [], nextCursor,
  sessions: Array.from({ length: count }, (_, i) => ({ appId: "executor", installationId: "installed", ownerId: "owner", sessionId: String(start + i), executionId: String(start + i), executor: { kind: "option", name: "Developer" }, title: "Attempt", status: "completed", associationState: "attached", historyPath: null })) });
function Probe({ id }: { id: string }) { const { summary, error } = useTaskExecutionSummary(id); return <div>{summary?.sessions.map(s => s.sessionId).join(",") ?? "unavailable"}<p>{error}</p></div>; }
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.resetAllMocks(); stream.changed = null; container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it("loads every page of retained attempts and refreshes the full snapshot on task events", async () => {
  vi.mocked(call).mockResolvedValueOnce(Response.json(page(100, 0, "100"))).mockResolvedValueOnce(Response.json(page(21, 100)));
  await act(async () => root.render(<Probe id="workspace" />));
  expect(container.textContent).toBe(Array.from({ length: 121 }, (_, i) => i).join(","));
  expect(vi.mocked(call).mock.calls[1][0]).toContain("cursor=100");
  vi.mocked(call).mockResolvedValueOnce(Response.json(page(1, 5, null, "two")));
  await act(async () => { await stream.changed!(); });
  expect(container.textContent).toBe("5");
});
it("clears formerly visible task history after an authorization failure", async () => {
  vi.mocked(call).mockResolvedValueOnce(Response.json(page(1)));
  await act(async () => root.render(<Probe id="workspace" />));
  expect(container.textContent).toBe("0");
  vi.mocked(call).mockRejectedValueOnce(new Error("Workspace access revoked"));
  await act(async () => { await stream.changed!(); });
  expect(container.textContent).toBe("unavailableWorkspace access revoked");
});
it("does not combine pages from different revisions or retain a partial history", async () => {
  vi.mocked(call).mockResolvedValueOnce(Response.json(page(100, 0, "100"))).mockResolvedValueOnce(Response.json(page(1, 100, null, "two")));
  await act(async () => root.render(<Probe id="workspace" />));
  expect(container.textContent).toContain("unavailableTask history changed while loading");
});
it("ignores a late response after changing workspaces without requesting its next page", async () => {
  let resolve!: (response: Response) => void;
  vi.mocked(call).mockReturnValueOnce(new Promise(r => { resolve = r; })).mockResolvedValueOnce(Response.json(page(1, 9)));
  await act(async () => root.render(<Probe id="old" />));
  await act(async () => root.render(<Probe id="new" />));
  await act(async () => resolve(Response.json(page(100, 0, "100"))));
  expect(container.textContent).toBe("9"); expect(call).toHaveBeenCalledTimes(2); expect(stream.stop).toHaveBeenCalledOnce();
});
