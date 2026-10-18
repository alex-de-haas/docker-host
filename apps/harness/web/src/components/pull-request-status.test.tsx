// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { PullRequest } from "@/lib/development-api";
import { PullRequestStatus } from "./pull-request-status";

function request(states: string[] | undefined, override: Partial<NonNullable<PullRequest["observation"]>> = {}): PullRequest {
  return { url: "https://example.test/repo/pull/1", observation: {
    at: new Date().toISOString(), state: "open", draft: false, unresolvedThreads: 3,
    reviewDecision: "CHANGES_REQUESTED", checks: states?.map(state => ({ name: state, state })), ...override,
  } };
}
function render(pr: PullRequest, stale = false) {
  const element = document.createElement("div");
  element.innerHTML = renderToStaticMarkup(<PullRequestStatus pr={pr} stale={stale} />);
  return element;
}

it.each([
  [["SUCCESS", "SKIPPED", "NEUTRAL"], "CI passed", "bg-emerald-500"],
  [["SUCCESS", "IN_PROGRESS"], "CI in progress", "bg-amber-500"],
  [["PENDING"], "CI in progress", "bg-amber-500"],
  [["QUEUED"], "CI in progress", "bg-amber-500"],
  [["WAITING"], "CI in progress", "bg-amber-500"],
  [["SUCCESS", "FAILURE", "IN_PROGRESS"], "CI failed", "bg-red-500"],
  [["ERROR"], "CI failed", "bg-red-500"],
  [["CANCELLED"], "CI failed", "bg-red-500"],
  [["TIMED_OUT"], "CI failed", "bg-red-500"],
  [["ACTION_REQUIRED"], "CI failed", "bg-red-500"],
  [["SUCCESS", "UNRECOGNIZED"], "CI unknown", "bg-muted-foreground"],
  [[], "No CI checks reported", "bg-muted-foreground"],
  [undefined, "CI unknown", "bg-muted-foreground"],
] as const)("classifies observed CI %j without treating review comments as check failures", (states, label, color) => {
  const element = render(request(states ? [...states] : undefined));
  const icon = element.querySelector('[role="img"]')!;
  expect(icon.getAttribute("aria-label")).toBe(`Open pull request · ${label}`);
  expect(icon.getAttribute("title")).toBe(icon.getAttribute("aria-label"));
  expect(icon.querySelector("span")?.classList.contains(color)).toBe(true);
});

it("does not show old or unavailable successful checks as current green CI", () => {
  expect(render(request(["SUCCESS"]), true).querySelector('[role="img"]')?.getAttribute("aria-label")).toContain("CI status outdated");
  for (const pr of [request(["SUCCESS"], { error: "Observation failed" }), { ...request(["SUCCESS"]), unavailable: "PR mismatch" }, { url: "https://example.test/repo/pull/1" }]) {
    expect(render(pr).querySelector(".bg-emerald-500")).toBeNull();
    expect(render(pr).querySelector('[role="img"]')?.getAttribute("aria-label")).toContain("unknown");
  }
});

it.each([
  [{ state: "merged" }, "Merged pull request", "lucide-git-merge"],
  [{ state: "closed" }, "Closed without merging", "lucide-git-pull-request-closed"],
  [{ draft: true }, "Draft pull request", "lucide-git-pull-request-draft"],
  [{ state: "unavailable" }, "Pull request status unknown", "lucide-circle-help"],
])("distinguishes PR lifecycle %j from a successful check", (override, label, glyph) => {
  const element = render(request(["SUCCESS"], override), true);
  expect(element.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(label);
  expect(element.querySelector(`.${glyph}`)).not.toBeNull();
  expect(element.querySelector(".bg-emerald-500")).toBeNull();
});
