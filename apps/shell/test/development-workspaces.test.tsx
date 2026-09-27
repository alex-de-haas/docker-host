import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DevelopmentWorkspaces } from "../src/app/shell/pages/development-workspaces";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../src/app/shell/shell-context", () => ({ useShellActions: () => ({ coreOrigin: "https://core.test", sendCsrfJson: send }) }));
vi.mock("next/dynamic", () => ({ default: () => () => <div>Diff preview</div> }));
let root: Root; let container: HTMLDivElement;
const workspace = { id: "a".repeat(64), path: "/owned/tree", state: "active", targetBranch: "main", owner: { appId: "assistant", sessionId: "session-one" },
  apps: [{ appId: "notes" }], leases: [] as string[], operations: [], observation: { state: "ok", at: new Date().toISOString(), head: "head", sessionFiles: ["README.md"], local: { files: [] } } };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ workspaces: [workspace] })));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  send.mockResolvedValue(Response.json(workspace));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<DevelopmentWorkspaces />));
const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent === text)!;
it("calls Core's origin, retains the mutation ID on transport loss and shows both diff views", async () => {
  await render();
  expect(container.textContent).toContain("README.md");
  send.mockRejectedValueOnce(new Error("Connection lost"));
  await act(async () => button("Fetch target").click());
  const first = send.mock.calls[0]!;
  expect(first[0]).toBe(`https://core.test/api/development/workspaces/${workspace.id}/operations/refresh`);
  await act(async () => button("Retry same request").click());
  expect(send.mock.calls[1]).toEqual(first);
  await act(async () => { const select = container.querySelector<HTMLSelectElement>('[aria-label="Change view"]')!; select.value = "local"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(container.textContent).toContain("No changes in this view");
  expect(container.textContent).not.toContain("README.md");
});
it("keeps leased workspaces visible and disables cleanup", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ workspaces: [{ ...workspace, leases: ["lease"] }] }));
  await render();
  expect(button("Remove merged worktree").disabled).toBe(true);
  expect(container.textContent).toContain("In use: 1");
});
it("recovers an interrupted operation using the durable command after reopening Shell", async () => {
  const command = { requestId: "original-request", expectedHead: "head" };
  vi.mocked(fetch).mockResolvedValue(Response.json({ workspaces: [{ ...workspace, state: "releasing", operations: [{ id: "original-request", kind: "cleanup", state: "pending", command }] }] }));
  await render();
  await act(async () => button("Recover interrupted cleanup").click());
  expect(send).toHaveBeenCalledWith(`https://core.test/api/development/workspaces/${workspace.id}/operations/cleanup`, command);
});
