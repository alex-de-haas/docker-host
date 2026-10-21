import { expect, it } from "vitest";
import { managedWorkspacePaths } from "./resources.js";

it.each(["/srv/Hosty, data=primary/Юникод", String.raw`C:\Hosty, data=primary\Юникод`])("preserves managed host paths under %s", root => {
  const paths = { trees: root + "/trees", repositories: root + "/repositories" };
  expect(managedWorkspacePaths(JSON.stringify(paths))).toEqual(paths);
});
it("allows an absent optional collection", () => { expect(managedWorkspacePaths(undefined)).toEqual({}); });
it.each(["[]", "null", '{"trees":42}', '{"trees":""}', "trees=/truncated,path"])("rejects malformed collection binding %s", value => {
  expect(() => managedWorkspacePaths(value)).toThrow();
});
