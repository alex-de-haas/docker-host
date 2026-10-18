import { describe, expect, it } from "vitest";
import { buildRedirectUriFromAppPath, findAppPageLink } from "../src/app/shell/app-helpers";
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

it("keeps declared navigation identity and service for a selected Harness session", () => {
  const harness = { embeddedUrl: "https://harness.example/development", navigation: [
    { label: "Harness", path: "/development", embeddedUrl: "https://harness.example/development", service: "api" },
  ] } as CoreApp;
  expect(findAppPageLink(harness, "/development?session=selected#draft")).toMatchObject({
    label: "Harness", path: "/development?session=selected#draft", service: "api",
    redirectUri: "https://harness.example/development?session=selected#draft",
  });
});

it("prefers the exact declared query before a same-path fallback", () => {
  const pages = { embeddedUrl: "https://app.example/view", navigation: [
    { label: "First", path: "/view?tab=first", embeddedUrl: "https://app.example/view?tab=first", service: "first" },
    { label: "Second", path: "/view?tab=second", embeddedUrl: "https://app.example/view?tab=second", service: "second" },
  ] } as CoreApp;
  expect(findAppPageLink(pages, "/view?tab=second")).toMatchObject({ label: "Second", service: "second", redirectUri: "https://app.example/view?tab=second" });
});
