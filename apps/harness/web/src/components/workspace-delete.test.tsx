// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceDelete, type DeleteDetails, type DeleteProgress } from "./workspace-delete";
import { developmentRequest } from "@/lib/development-api";
vi.mock("@/lib/development-api", async original => ({ ...await original<object>(), developmentRequest: vi.fn() }));
let root: Root, container: HTMLDivElement;
const requestId = "94fcd992-875a-46dd-a729-a4ae6b0f0b69";
const details = (): DeleteDetails => ({ name: "Disposable experiment", trees: [{ id: "one", repository: "https://example.test/one.git",
  path: "/owned/trees/one", branch: "work/one", head: "head", fingerprint: "observed", changedFiles: ["changed.txt"],
  untrackedFiles: ["new.txt"], ignoredFiles: ["build/output"], unmergedCommits: 2 }],
  resources: [{ id: "sandbox", kind: "sandbox", name: "Test app", state: "running", dataPath: "/owned/sandbox/data" }],
  warnings: ["Agent lease is active; external process exit is unknown."] });
const progress = (state: DeleteProgress["state"] = "pending"): DeleteProgress => ({ workspaceId: "workspace", requestId, state,
  trees: [{ id: "one", state: state === "removed" ? "removed" : "pending" }], resources: [] });
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === name)!;
const refresh = vi.fn(), close = vi.fn(), removeConversation = vi.fn();
async function render(extra: Partial<Parameters<typeof WorkspaceDelete>[0]> = {}) {
  await act(async () => root.render(<WorkspaceDelete workspaceId="workspace" name="Disposable experiment" onClose={close} refresh={refresh} {...extra} />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.mocked(developmentRequest).mockResolvedValue(details());
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
it("shows factual source, data and activity warnings with one enabled Delete and no mutating preview", async () => {
  await render();
  expect(document.body.textContent).toContain("1 changed · 1 untracked · 1 ignored · 2 unmerged commits");
  expect(document.body.textContent).toContain("/owned/sandbox/data");
  expect(document.body.textContent).toContain("Agent lease is active");
  expect(document.querySelector("input, textarea, [role=textbox]")).toBeNull();
  expect(button("Delete").disabled).toBe(false);
  expect(developmentRequest).toHaveBeenCalledTimes(1);
  await act(async () => button("Cancel").click()); expect(close).toHaveBeenCalledOnce();
  expect(developmentRequest).toHaveBeenCalledTimes(1);
});
it.each(["loading", "failed"])("keeps deletion available when inspection is %s", async state => {
  if (state === "loading") vi.mocked(developmentRequest).mockImplementationOnce(() => new Promise(() => {}));
  else vi.mocked(developmentRequest).mockRejectedValueOnce(new Error("Git unavailable"));
  await render(); expect(button("Delete").disabled).toBe(false);
  expect(document.body.textContent).toContain("An agent may still be using this directory");
});
it("sends only the persisted request ID and deletes a selected conversation only after success", async () => {
  await render({ deleteConversation: removeConversation });
  await act(async () => document.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
  vi.mocked(developmentRequest).mockImplementationOnce(async (path, body) => {
    expect(path).toBe("/workspace/delete"); expect(Object.keys(body!)).toEqual(["requestId"]);
    expect(JSON.parse(localStorage.getItem("hosty.workspace.delete.workspace")!)).toEqual(body);
    expect(removeConversation).not.toHaveBeenCalled(); return { ...progress("removed"), requestId: body!.requestId } as never;
  });
  await act(async () => button("Delete").click());
  expect(removeConversation).toHaveBeenCalledOnce(); expect(localStorage.getItem("hosty.workspace.delete.workspace")).toBeNull();
  expect(document.body.textContent).toContain("Workspace deleted");
});
it("recovers an old accepted discard using its request ID without another review", async () => {
  localStorage.setItem("hosty.workspace.discard.workspace", JSON.stringify({ requestId, digest: "old-review", confirmationName: "old-name" }));
  vi.mocked(developmentRequest).mockResolvedValueOnce(progress()); await render();
  expect(developmentRequest).toHaveBeenCalledWith(`/workspace/delete/status?requestId=${requestId}`, undefined, expect.any(AbortSignal));
  vi.mocked(developmentRequest).mockResolvedValueOnce(progress("removed"));
  await act(async () => button("Retry deletion").click());
  expect(developmentRequest).toHaveBeenLastCalledWith("/workspace/delete", { requestId });
  expect(localStorage.getItem("hosty.workspace.discard.workspace")).toBeNull();
});
it("reuses an uncertain request after connection loss and does not delete a conversation early", async () => {
  await render({ deleteConversation: removeConversation });
  vi.mocked(developmentRequest).mockRejectedValueOnce(new Error("Connection lost"));
  await act(async () => button("Delete").click());
  const saved = JSON.parse(localStorage.getItem("hosty.workspace.delete.workspace")!);
  expect(removeConversation).not.toHaveBeenCalled(); expect(document.body.textContent).toContain("same deletion request");
  vi.mocked(developmentRequest).mockResolvedValueOnce({ ...progress("removed"), requestId: saved.requestId });
  await act(async () => button("Retry deletion").click());
  expect(developmentRequest).toHaveBeenLastCalledWith("/workspace/delete", saved);
});
