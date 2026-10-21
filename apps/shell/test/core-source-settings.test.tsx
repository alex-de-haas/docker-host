import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CoreSourceDialog, type CoreDevelopment } from "../src/app/shell/core-development";

const source = { overridePath: null, revision: "r1", repositoryUrl: "https://example.test/original.git", ref: "main", projectPath: "Core.csproj", connectionId: null };
const state: CoreDevelopment = {
  launch: { mode: "release", projectPath: null, generationPath: null, processId: 42, startedAt: "2026-10-21T06:00:00Z" },
  instance: "42:start", manageable: true, source, managedPath: "/managed/source", sourcePath: "/managed/source",
  selectedProjectPath: "/managed/source/Core.csproj", restartRequired: false, branch: "main", commit: null,
  changedFiles: 0, additions: 0, deletions: 0, gitError: null,
};
type SaveSource = Parameters<typeof CoreSourceDialog>[0]["onSave"];
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const repositoryInput = () => container.querySelector<HTMLInputElement>('input[placeholder="https://github.com/owner/repository.git"]')!;
const saveButton = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
async function editRepository(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(repositoryInput(), value);
    repositoryInput().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const render = async (current: CoreDevelopment, onSave: Parameters<typeof CoreSourceDialog>[0]["onSave"]) => {
  await act(async () => root.render(<CoreSourceDialog inline open state={current} disabled={false} onOpenChange={vi.fn()} onSave={onSave} />));
};

it("refreshes an unedited inline source form and uses the refreshed revision", async () => {
  const save = vi.fn<SaveSource>(async () => source);
  await render(state, save);
  const refreshed = { ...source, revision: "r2", repositoryUrl: "https://example.test/refreshed.git" };
  await render({ ...state, source: refreshed }, save);
  expect(repositoryInput().value).toBe(refreshed.repositoryUrl);
  expect(saveButton().disabled).toBe(true);
  await editRepository("https://example.test/edited.git");
  await act(async () => saveButton().click());
  expect(save.mock.calls[0]?.[2]).toBe("r2");
});

it("preserves unsaved source fields and their revision across a concurrent refresh", async () => {
  const save = vi.fn<SaveSource>(async () => { throw new Error("Source changed; reload before saving."); });
  await render(state, save);
  await editRepository("https://example.test/draft.git");
  await render({ ...state, source: { ...source, revision: "r2", repositoryUrl: "https://example.test/concurrent.git" } }, save);
  expect(repositoryInput().value).toBe("https://example.test/draft.git");
  await act(async () => saveButton().click());
  expect(save.mock.calls[0]?.[2]).toBe("r1");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Source changed");
  expect(repositoryInput().value).toBe("https://example.test/draft.git");
});

it("keeps the saved revision for later edits instead of authorizing stale fields with a poll revision", async () => {
  const saved = { ...source, revision: "r2", repositoryUrl: "https://example.test/saved.git" };
  const save = vi.fn<SaveSource>(async () => saved);
  await render(state, save);
  await editRepository(saved.repositoryUrl);
  await act(async () => {
    saveButton().click();
    root.render(<CoreSourceDialog inline open state={{ ...state, source: saved }} disabled={false} onOpenChange={vi.fn()} onSave={save} />);
  });
  expect(saveButton().disabled).toBe(true);
  await editRepository("https://example.test/next-draft.git");
  await render({ ...state, source: { ...saved, revision: "r3", repositoryUrl: "https://example.test/concurrent.git" } }, save);
  save.mockRejectedValueOnce(new Error("Source changed; reload before saving."));
  await act(async () => saveButton().click());
  expect(save.mock.calls[1]?.[2]).toBe("r2");
  expect(repositoryInput().value).toBe("https://example.test/next-draft.git");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Source changed");
});
