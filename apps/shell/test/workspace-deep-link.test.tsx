import { describe, expect, it } from "vitest";
import { buildRedirectUriFromAppPath } from "../src/app/shell/app-helpers";
import type { CoreApp } from "../src/app/shell/types";

const app = (embeddedUrl: string) => ({ embeddedUrl }) as CoreApp;

describe("workspace app deep links", () => {
  it("preserves workspace and worktree selection as query parameters", () => {
    const url = buildRedirectUriFromAppPath(app("http://workspaces.local:3700/"), "/?workspace=one&worktree=two");
    expect(url).toBe("http://workspaces.local:3700/?workspace=one&worktree=two");
  });
  it("keeps an application's base path and encoded query values", () => {
    expect(buildRedirectUriFromAppPath(app("https://apps.example/viewer/"), "/detail?file=a%2Fb#changes"))
      .toBe("https://apps.example/viewer/detail?file=a%2Fb#changes");
  });
  it("cannot replace the installed origin with a protocol-relative path", () => {
    const url = new URL(buildRedirectUriFromAppPath(app("https://apps.example/"), "//other.example/?workspace=one")!);
    expect(url.origin).toBe("https://apps.example");
    expect(url.searchParams.get("workspace")).toBe("one");
  });
});
