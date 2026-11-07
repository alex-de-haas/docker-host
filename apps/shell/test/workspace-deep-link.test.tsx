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
  it("resolves an unlisted route beside the declared entry route for an unrelated app", () => {
    const reports = { id: "org.northwind.reports", embeddedUrl: "https://reports.example/overview", entryPath: "/overview", navigation: [
      { label: "Reports", path: "/overview", embeddedUrl: "https://reports.example/overview", service: "ui" },
    ] } as CoreApp;
    expect(findAppPageLink(reports, "/archive?report=one#table")).toMatchObject({
      path: "/archive?report=one#table", redirectUri: "https://reports.example/archive?report=one#table",
    });
  });
  it("keeps deployment prefixes while removing the declared entry suffix and its trailing slash", () => {
    const reports = { embeddedUrl: "https://apps.example/tenants/acme/reports/overview/?old=entry#home", entryPath: "/overview/" } as CoreApp;
    expect(buildRedirectUriFromAppPath(reports, "/detail?file=a%2Fb#changes"))
      .toBe("https://apps.example/tenants/acme/reports/detail?file=a%2Fb#changes");
  });
  it("normalizes an absolute entry declaration without adopting its origin or query", () => {
    const reports = { embeddedUrl: "https://apps.example/reports/overview", entryPath: "https://public.example/overview?tab=home#top" } as CoreApp;
    expect(buildRedirectUriFromAppPath(reports, "/archive?report=one#table"))
      .toBe("https://apps.example/reports/archive?report=one#table");
    const url = new URL(buildRedirectUriFromAppPath(reports, "//other.example/archive?report=one#table")!);
    expect(url.origin).toBe("https://apps.example");
    expect(url.search).toBe("?report=one"); expect(url.hash).toBe("#table");
  });
  it.each(["/view", "/missing", "/", "http://["])("keeps the existing base when entryPath %s is not a matching non-root suffix", entryPath => {
    const reports = { embeddedUrl: "https://apps.example/preview/", entryPath } as CoreApp;
    expect(buildRedirectUriFromAppPath(reports, "/detail?report=one#table"))
      .toBe("https://apps.example/preview/detail?report=one#table");
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

it("retains the exact navigation endpoint and service when its origin differs from the entry surface", () => {
  const reports = { embeddedUrl: "https://apps.example/reports/overview", entryPath: "/overview", navigation: [
    { label: "Export", path: "/export", embeddedUrl: "https://exports.example/files/export", service: "exports" },
  ] } as CoreApp;
  expect(findAppPageLink(reports, "/export?report=one#download")).toMatchObject({
    label: "Export", path: "/export?report=one#download", service: "exports", redirectUri: "https://exports.example/files/export?report=one#download",
  });
});

it("prefers the full declared query and fragment before query-only and pathname fallbacks", () => {
  const reports = { id: "org.northwind.reports", embeddedUrl: "https://reports.example/view", navigation: [
    { label: "First view", path: "/view?tab=detail#one", embeddedUrl: "https://first.example/view?tab=detail#one", service: "first" },
    { label: "Second view", path: "/view?tab=detail#two", embeddedUrl: "https://second.example/view?tab=detail#two", service: "second" },
  ] } as CoreApp;
  expect(findAppPageLink(reports, "/view/?tab=detail#two")).toMatchObject({
    label: "Second view", service: "second", redirectUri: "https://second.example/view?tab=detail#two",
  });
  expect(findAppPageLink(reports, "/view?tab=detail#unlisted")).toMatchObject({ label: "First view", service: "first" });
  expect(findAppPageLink(reports, "/view?session=selected#two")).toMatchObject({ label: "First view", service: "first" });
});
