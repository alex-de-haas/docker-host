// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PullRequest } from "@/lib/development-api";
import { PullRequestChecks } from "./pull-request-checks";

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const request = (states: string[]): PullRequest => ({ url: "https://example.test/repo/pull/42", observation: {
  at: new Date().toISOString(), state: "open", draft: false, unresolvedThreads: 0,
  checks: states.map((state, index) => ({ name: `Check ${index + 1}`, state })),
} });
const render = async (pr: PullRequest, stale = false) => act(async () => root.render(<PullRequestChecks pr={pr} stale={stale} label="repo #42" />));
const trigger = () => container.querySelector("button")!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="repo #42: CI checks"]');

it("opens all results on demand and returns focus after Escape", async () => {
  await render(request(["SUCCESS", "FAILURE", "SKIPPED", "IN_PROGRESS"]));
  expect(trigger().textContent).toBe("CI 3/4");
  expect(dialog()).toBeNull();
  trigger().focus();
  await act(async () => trigger().click());
  expect(dialog()?.querySelectorAll("li")).toHaveLength(4);
  expect(dialog()?.textContent).toContain("3/4 completed");
  expect(dialog()?.textContent).toContain("Failure");
  expect(dialog()?.textContent).toContain("Skipped");
  expect(dialog()?.textContent).toContain("In progress");
  await act(async () => dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await vi.waitFor(() => { expect(dialog()).toBeNull(); expect(document.activeElement).toBe(trigger()); });
});

it("updates an open popover and drops prior results when the provider becomes unavailable", async () => {
  await render(request(["SUCCESS", "PENDING", "UNRECOGNIZED"]));
  await act(async () => trigger().click());
  expect(trigger().textContent).toBe("CI 1/3");
  await render(request(["SUCCESS", "CANCELLED", "TIMED_OUT"]));
  expect(trigger().textContent).toBe("CI 3/3");
  expect(dialog()?.textContent).toContain("Cancelled");
  expect(dialog()?.textContent).not.toContain("Pending");
  await render({ ...request(["SUCCESS"]), unavailable: "Provider connection unavailable" });
  expect(trigger().textContent).toBe("CI unknown");
  expect(dialog()?.querySelectorAll("li")).toHaveLength(0);
  expect(dialog()?.textContent).toContain("Provider connection unavailable");
});

it("distinguishes empty and unknown checks and labels outdated evidence", async () => {
  await render(request([]));
  expect(trigger().textContent).toBe("CI 0/0");
  await act(async () => trigger().click());
  expect(dialog()?.textContent).toContain("No CI checks reported");
  await render({ url: "https://example.test/repo/pull/42" });
  expect(trigger().textContent).toBe("CI unknown");
  expect(dialog()?.textContent).toContain("Check results are unavailable");
  await render(request(["SUCCESS"]), true);
  expect(dialog()?.textContent).toContain("outdated");
});
