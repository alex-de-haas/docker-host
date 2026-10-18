import { describe, expect, it } from "vitest";
import { changeCount, repositoryName, fileApps, filterWorkspaces, isStale, safeLink, workspaceLink } from "./model";
import type { Workspace, Worktree } from "./types";
const tree = (id: string, state = "active", observed = true): Worktree => ({ id, state, repository: "https://github.com/example/project.git", branch: "feature",
  apps: [], observation: observed ? { state: "ok", sessionFiles: [], at: "2026-10-09T10:00:00Z", conflict: false } : null } as unknown as Worktree);
const workspace = (id: string, state: string, trees: Worktree[]): Workspace => ({ id, state, owner: { label: "Codex", reference: "task-one" }, worktrees: trees } as Workspace);
describe("workspace inventory", () => {
  it("keeps clean and unobserved workspaces visible and separates released history", () => {
    const items = [workspace("clean", "active", [tree("a")]), workspace("pending", "attention", [tree("b", "preparing", false)]), workspace("old", "released", [tree("c", "released")])];
    expect(filterWorkspaces(items, "", "active").map(w => w.id)).toEqual(["clean", "pending"]);
    expect(filterWorkspaces(items, "", "changed")).toEqual([]);
    expect(filterWorkspaces(items, "", "released").map(w => w.id)).toEqual(["old"]);
    expect(filterWorkspaces(items, "TASK-ONE", "all")).toHaveLength(3);
    expect(changeCount(items[1].worktrees[0])).toBeNull();
    expect(changeCount(items[2].worktrees[0])).toBeNull();
  });
  it("finds changes in any child, without losing the group", () => {
    const child = tree("dirty"); child.observation!.sessionFiles = ["a.txt"];
    const item = workspace("multi", "active", [tree("clean"), child]);
    expect(filterWorkspaces([item], "project", "changed")).toEqual([item]);
  });
  it("maps directory boundaries without claiming dependency analysis", () => {
    const apps = [{ appId: "a", name: "A", subpath: "apps/a", installed: true }];
    expect(fileApps("apps/a/src/index.ts", apps)).toEqual(apps);
    expect(fileApps("apps/another/index.ts", apps)).toEqual([]);
    expect(fileApps("package.json", apps)).toEqual([]);
  });
  it("encodes deep links and refuses unsafe remote references", () => {
    expect(workspaceLink("a&b", "one/two")).toBe("/?workspace=a%26b&worktree=one%2Ftwo");
    expect(safeLink("javascript:alert(1)")).toBeUndefined();
    expect(safeLink("https://token@example.com")).toBeUndefined();
    expect(safeLink("http://assistant.hosty.localhost:123/?session=one")).toContain("assistant.hosty");
    expect(safeLink("http://example.com/pr/1", true)).toBeUndefined();
    expect(isStale(undefined, Date.now())).toBe(true);
    expect(isStale("2026-10-09T10:00:00Z", Date.parse("2026-10-09T10:02:00Z"))).toBe(true);
  });
});

it("labels local Git metadata paths and remote repositories", () => {
  expect(repositoryName("/source/api/.git/")).toBe("api");
  expect(repositoryName("https://github.com/example/repo.git")).toBe("repo");
});
