// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { preload, renderDiff } = vi.hoisted(() => ({ preload: vi.fn(), renderDiff: vi.fn() }));
vi.mock("@pierre/diffs", async importOriginal => ({ ...await importOriginal<object>(), preloadHighlighter: preload }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: renderDiff }));
import WorkspaceDiffView from "./workspace-diff-view";
let root: Root, container: HTMLDivElement;
const diff = { contentKind: "text" as const, path: "new.ts", combined: "const value = 1;\n", truncated: false, binary: false };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  preload.mockReset().mockResolvedValue(undefined); renderDiff.mockReset().mockReturnValue(<div>Highlighted diff</div>);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.documentElement.classList.remove("dark"); vi.unstubAllGlobals(); });
it("follows Hosty's live theme and changes layout without altering source", async () => {
  await act(async () => root.render(<WorkspaceDiffView diff={diff} layout="unified" wrap />));
  expect(container.querySelector('[role="region"]')?.getAttribute("aria-label")).toBe("Changes in new.ts");
  expect(renderDiff.mock.lastCall?.[0].options).toMatchObject({ themeType: "light", diffStyle: "unified", overflow: "wrap" });
  await act(async () => { document.documentElement.classList.add("dark"); });
  expect(renderDiff.mock.lastCall?.[0].options.themeType).toBe("dark");
  await act(async () => root.render(<WorkspaceDiffView diff={diff} layout="split" wrap={false} />));
  expect(renderDiff.mock.lastCall?.[0].options).toMatchObject({ diffStyle: "split", overflow: "scroll", themeType: "dark" });
  expect(renderDiff.mock.lastCall?.[0].fileDiff.additionLines.join("")).toBe(diff.combined);
});
it("retains the original text if highlighting cannot load", async () => {
  preload.mockRejectedValue(new Error("offline"));
  await act(async () => root.render(<WorkspaceDiffView diff={diff} layout="unified" wrap />));
  expect(container.textContent).toContain("could not load"); expect(container.querySelector("pre")?.textContent).toBe(diff.combined);
  expect(renderDiff).not.toHaveBeenCalled();
});
