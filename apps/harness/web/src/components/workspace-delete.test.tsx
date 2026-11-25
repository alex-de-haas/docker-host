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
const refresh = vi.fn(), close = vi.fn(), submit = vi.fn();
async function render(extra: Partial<Parameters<typeof WorkspaceDelete>[0]> = {}) {
  await act(async () => root.render(<WorkspaceDelete workspaceId="workspace" name="Disposable experiment" onClose={close} onSubmit={submit} refresh={refresh} {...extra} />));
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
it.each([true, false])("closes on confirmation and includes all attached sessions only when checked (%s)", async checked => {
  await render({ sessionIds: ["first", "second"] });
  const checkbox = document.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
  expect(checkbox.getAttribute("aria-checked")).toBe("false");
  if (checked) await act(async () => checkbox.click());
  await act(async () => button("Delete").click());
  expect(submit).toHaveBeenCalledExactlyOnceWith(checked
    ? { requestId: expect.any(String), captureSessions: true }
    : { requestId: expect.any(String) });
  expect(close).toHaveBeenCalledOnce();
  expect(developmentRequest).toHaveBeenCalledTimes(1);
});
it("recovers an old accepted discard using its request ID without another review", async () => {
  localStorage.setItem("hosty.workspace.discard.workspace", JSON.stringify({ requestId, digest: "old-review", confirmationName: "old-name" }));
  vi.mocked(developmentRequest).mockResolvedValueOnce(progress()); await render();
  expect(developmentRequest).toHaveBeenCalledWith(`/workspace/delete/status?requestId=${requestId}`, undefined, expect.any(AbortSignal));
  await act(async () => button("Retry deletion").click());
  expect(submit).toHaveBeenCalledExactlyOnceWith({ requestId });
  expect(close).toHaveBeenCalledOnce();
});
it("retains only the original selection when retrying after a status read fails", async () => {
  const original = { requestId, captureSessions: true };
  localStorage.setItem("hosty.workspace.delete.workspace", JSON.stringify(original));
  vi.mocked(developmentRequest).mockRejectedValueOnce(new Error("Connection lost"));
  await render({ pendingRequestId: requestId, sessionIds: ["new-session"] });
  expect(document.body.textContent).toContain("Connection lost");
  expect(document.querySelector('[role="checkbox"]')).toBeNull();
  await act(async () => button("Retry deletion").click());
  expect(submit).toHaveBeenCalledExactlyOnceWith(original);
});
it("leaves confirmed attached chat cleanup with its backend after source removal", async () => {
  localStorage.setItem("hosty.workspace.delete.workspace", JSON.stringify({ requestId, captureSessions: true }));
  vi.mocked(developmentRequest).mockResolvedValueOnce(progress("removed")).mockRejectedValueOnce(new Error("Workspace not found"));
  await render();
  expect(document.body.textContent).toContain("Workspace deleted");
  expect(localStorage.getItem("hosty.workspace.delete.workspace")).toBeNull();
  expect(submit).not.toHaveBeenCalled();
});

it("includes only the inspected runtime replacements in the original confirmation", async () => {
  const key = "ab".repeat(32);
  vi.mocked(developmentRequest).mockResolvedValueOnce({ ...details(), returnTargets: [{ key, name: "Core", replacement: "installed release" }] });
  await render();
  expect(document.body.textContent).toContain("Core will return to installed release");
  await act(async () => button("Delete").click());
  expect(submit).toHaveBeenCalledExactlyOnceWith({ requestId: expect.any(String), returnTargets: [key] });
});

it.each(["delete", "discard"])("retires a completed %s receipt and offers a fresh Delete for a replacement allocation", async prefix => {
  localStorage.setItem(`hosty.workspace.${prefix}.workspace`, JSON.stringify({ requestId }));
  vi.mocked(developmentRequest).mockResolvedValueOnce(progress("removed")).mockResolvedValueOnce(details());
  await render();
  expect(localStorage.getItem(`hosty.workspace.${prefix}.workspace`)).toBeNull();
  expect(button("Delete").disabled).toBe(false);
  expect(document.body.textContent).toContain("1 changed · 1 untracked · 1 ignored · 2 unmerged commits");
  await act(async () => button("Delete").click());
  expect(submit).toHaveBeenCalledOnce();
  expect(submit.mock.calls[0]?.[0].requestId).not.toBe(requestId);
});
it("retires a completed receipt when the deleted workspace is still absent", async () => {
  localStorage.setItem("hosty.workspace.delete.workspace", JSON.stringify({ requestId }));
  vi.mocked(developmentRequest).mockResolvedValueOnce(progress("removed")).mockRejectedValueOnce(new Error("Workspace not found"));
  await render();
  expect(localStorage.getItem("hosty.workspace.delete.workspace")).toBeNull();
  expect(document.body.textContent).toContain("Workspace deleted");
  expect(button("Delete")).toBeUndefined();
  expect(refresh).toHaveBeenCalledOnce();
});
it("ignores a late status response after the user retries the accepted request", async () => {
  localStorage.setItem("hosty.workspace.delete.workspace", JSON.stringify({ requestId }));
  let finishStatus!: (value: DeleteProgress) => void;
  vi.mocked(developmentRequest).mockImplementationOnce(() => new Promise(resolve => { finishStatus = resolve as typeof finishStatus; }));
  await render();
  await act(async () => button("Retry deletion").click());
  await act(async () => finishStatus(progress("removed")));
  expect(submit).toHaveBeenCalledExactlyOnceWith({ requestId });
  expect(close).toHaveBeenCalledOnce();
  expect(refresh).not.toHaveBeenCalled();
  expect(localStorage.getItem("hosty.workspace.delete.workspace")).not.toBeNull();
});

it("shows runtime blockers and explains Return before sending a deletion request", async () => {
  vi.mocked(developmentRequest).mockResolvedValueOnce({ ...details(), blockers: ["The running Core uses this worktree.", "An application uses this workspace."] });
  await render();
  const alert = document.querySelector('[role="alert"][aria-label="Workspace is in use"]');
  expect(alert?.textContent).toContain("The running Core uses this worktree.");
  expect(alert?.textContent).toContain("An application uses this workspace.");
  expect(alert?.textContent).toContain("No automatic replacement was verified for these consumers.");
  expect(button("Delete").disabled).toBe(false);
  expect(developmentRequest).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem("hosty.workspace.delete.workspace")).toBeNull();
  await act(async () => button("Cancel").click());
  expect(close).toHaveBeenCalledOnce();
  expect(developmentRequest).toHaveBeenCalledTimes(1);
});
