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

it("renders current-side threads inline and retains file, outdated and missing-coordinate threads", async () => {
  renderDiff.mockImplementation(props => <div>Highlighted diff{props.lineAnnotations.map((annotation: unknown, index: number) => <div key={index}>{props.renderAnnotation(annotation)}</div>)}</div>);
  const base = { path: "new.ts", resolved: false, comments: ["Review comment"], diffSide: "RIGHT" };
  const threads = [{ ...base, id: "inline", line: 1 }, { ...base, id: "same-line", line: 1 }, { ...base, id: "file", subjectType: "FILE" }, { ...base, id: "outdated", line: 1, outdated: true }, { ...base, id: "gap", line: 99 }];
  await act(async () => root.render(<WorkspaceDiffView diff={diff} layout="split" wrap threads={threads} />));
  const annotations = renderDiff.mock.lastCall?.[0].lineAnnotations;
  expect(annotations).toHaveLength(1); expect(annotations[0]).toMatchObject({ side: "additions", lineNumber: 1, metadata: [threads[0], threads[1]] });
  expect(container.querySelectorAll("article")).toHaveLength(threads.length);
  expect(container.querySelector('[aria-label="File comments"]')?.textContent).toContain("Review comment");
  expect(container.querySelector('[aria-label="Outdated threads"]')?.textContent).toContain("earlier revision");
  expect(container.querySelector('[aria-label="Threads outside this preview"]')?.textContent).toContain("new.ts:99");
});
it.each([{ binary: true }, { truncated: true }, { contentKind: undefined }, { combined: "invalid patch", contentKind: "patch" as const }])("retains review actions alongside unreadable diff fallback %j", async flags => {
  const ask = vi.fn();
  const thread = { id: "retained", path: "new.ts", line: 1, resolved: false, comments: ["Do not lose this comment"], diffSide: "RIGHT" };
  await act(async () => root.render(<WorkspaceDiffView diff={{ ...diff, ...flags }} layout="unified" wrap threads={[thread]} onThreadAsk={ask} />));
  expect(renderDiff).not.toHaveBeenCalled(); expect(container.textContent).toContain("Do not lose this comment");
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Ask Harness")!.click());
  expect(ask).toHaveBeenCalledWith(thread);
});

it("keeps retained review actions available during deferred highlighter loading", async () => {
  let completePreload!: () => void;
  preload.mockReturnValueOnce(new Promise<void>(resolve => { completePreload = resolve; }));
  const ask = vi.fn();
  const thread = { id: "file", path: "new.ts", subjectType: "FILE", resolved: false, comments: ["Retained file comment"] };
  await act(async () => root.render(<WorkspaceDiffView diff={diff} layout="unified" wrap threads={[thread]} onThreadAsk={ask} />));
  expect([...container.querySelectorAll('[role="status"]')].some(status => status.textContent === "Loading diff viewer…")).toBe(true);
  expect(renderDiff).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-label="File comments"]')?.textContent).toContain("Retained file comment");
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Ask Harness")!.click());
  expect(ask).toHaveBeenCalledExactlyOnceWith(thread);
  await act(async () => completePreload());
  expect(container.textContent).not.toContain("Loading diff viewer…");
  expect(container.textContent).toContain("Highlighted diff");
  expect(container.querySelector('[aria-label="File comments"]')?.textContent).toContain("Retained file comment");
});
