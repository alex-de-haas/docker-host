// @vitest-environment jsdom
import { expect, it } from "vitest";
import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { commentLocation, markUnpublishedRows } from "./review-selection";
import type { PublishedEvidence } from "./workspace-review-api";
const file = { name: "src/new-name.ts", prevName: "src/old-name.ts", hunks: [{ additionStart: 10, additionCount: 4, deletionStart: 8, deletionCount: 3 }, { additionStart: 30, additionCount: 2, deletionStart: 20, deletionCount: 1 }] } as FileDiffMetadata;
it("uses published line coordinates and preserves same-side reversed selections", () => {
  expect(commentLocation(file, { start: 13, end: 10, side: "additions" })).toEqual({ path: file.name, diffSide: "RIGHT", startLine: 10, line: 13 });
  expect(commentLocation(file, { start: 8, end: 10, side: "deletions" })).toEqual({ path: file.name, diffSide: "LEFT", startLine: 8, line: 10 });
  expect(commentLocation(file, { start: 10, end: 10 })).toMatchObject({ diffSide: "RIGHT", line: 10 });
});
it.each([{ start: 10, end: 12, side: "additions", endSide: "deletions" }, { start: 0, end: 1 }, { start: 10.5, end: 11 }, { start: 10, end: Number.POSITIVE_INFINITY }, { start: 13, end: 30 }, { start: 14, end: 14 }, { start: 7, end: 8, side: "deletions" }])("rejects a selection outside one exact rendered side/hunk: %j", range => {
  expect(commentLocation(file, range as SelectedLineRange)).toBeNull();
});
function markup() {
  const root = document.createElement("div"); root.innerHTML = '<code data-additions><div id="a10" data-line="10"></div><div id="a11" data-column-number="11"></div><div id="a12" data-line="12"></div></code><code data-deletions><div id="old10" data-line="10"></div></code><code data-unified><div id="u10" data-line="10" data-line-type="change-addition"></div><div id="u11" data-column-number="11" data-line-type="context"></div><div id="deleted10" data-line="10" data-line-type="change-deletion"></div><div id="deleted11" data-column-number="11" data-line-type="change-deletion"></div></code>';
  return root;
}
const evidence: PublishedEvidence = { pullRequestUrl: "https://github.com/example/repo/pull/7", head: "published-head", complete: true, unpublishedRanges: [{ startLine: 10, endLine: 11 }] };
it("stripes only evidenced working-side code and gutters in split and unified layouts", () => {
  const root = markup(); markUnpublishedRows(root, evidence);
  expect([...root.querySelectorAll("[data-hosty-unpublished]")].map(node => node.id)).toEqual(["a10", "a11", "u10", "u11"]);
  expect(root.querySelector("#a10")?.getAttribute("title")).toContain("Push before commenting");
});
it("clears old stripes on refresh, absent evidence, incomplete evidence or an empty complete comparison", () => {
  for (const next of [undefined, { ...evidence, complete: false }, { ...evidence, unpublishedRanges: [] }]) {
    const root = markup(); markUnpublishedRows(root, evidence); markUnpublishedRows(root, next);
    expect(root.querySelectorAll("[data-hosty-unpublished]")).toHaveLength(0); expect(root.querySelector("#a10")?.hasAttribute("title")).toBe(false);
  }
});
it("marks the renderer-owned shadow tree without touching unrelated light DOM", () => {
  const host = document.createElement("div"); host.innerHTML = '<code data-additions><div data-line="10"></div></code>';
  const shadow = host.attachShadow({ mode: "open" }); shadow.append(...markup().children);
  markUnpublishedRows(host, evidence); expect(shadow.querySelectorAll("[data-hosty-unpublished]")).toHaveLength(4); expect(host.querySelectorAll("[data-hosty-unpublished]")).toHaveLength(0);
});
