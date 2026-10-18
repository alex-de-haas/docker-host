
// @vitest-environment jsdom
import { expect, it } from "vitest";
import { orderWorkspaces, type DevelopmentWorkspace } from "./development-api";
it("orders external workspace activity independently of observation polling and leaves input unchanged", () => {
  const workspace = (id: string, updatedAt: string | null, observed: string) => ({ id, updatedAt, workflow: { state: "in-progress", revision: 1 },
    owner: { kind: "external", label: id, reference: id }, state: "active", worktrees: [{ observation: { at: observed } }] }) as DevelopmentWorkspace;
  const input = [workspace("z-old", "2026-10-12", "2026-10-20"), workspace("new", "2026-10-18", "2026-10-18"), workspace("a-unknown", null, "2026-10-30")];
  expect(orderWorkspaces(input).map(w => w.id)).toEqual(["new", "z-old", "a-unknown"]);
  expect(input.map(w => w.id)).toEqual(["z-old", "new", "a-unknown"]);
  expect(orderWorkspaces([workspace("z", "bad", ""), workspace("a", null, "")]).map(w => w.id)).toEqual(["a", "z"]);
});
