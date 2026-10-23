// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { SessionExecutionIndicator } from "./session-execution-indicator";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it("shows native host access without claiming elevated OS privileges", async () => {
  await act(async () => root.render(<SessionExecutionIndicator executionMode="native" />));
  const badge = container.querySelector<HTMLElement>('[data-slot="session-execution"]')!;
  expect(badge.textContent).toBe("Local · Host access");
  expect(badge.className).toContain("text-destructive-foreground");
  expect(badge.hasAttribute("title")).toBe(false);
  expect(container.querySelector("button")).toBeNull();
  await act(async () => badge.focus());
  const tooltip = document.querySelector('[role="tooltip"]')?.textContent ?? "";
  expect(tooltip).toContain("native Harness process permissions");
  expect(tooltip).toContain("MCP tools retain their own granted access and approval rules");
  expect(tooltip).not.toMatch(/elevated|administrator|root user/i);
});

it("describes Docker limits without promising isolation between sessions", async () => {
  await act(async () => root.render(<SessionExecutionIndicator executionMode="docker" />));
  const badge = container.querySelector<HTMLElement>('[data-slot="session-execution"]')!;
  expect(badge.textContent).toBe("Docker · Limited access");
  expect(badge.className).not.toContain("text-destructive-foreground");
  await act(async () => badge.focus());
  const tooltip = document.querySelector('[role="tooltip"]')?.textContent;
  expect(tooltip).toContain("unprivileged user in the shared Docker worker");
  expect(tooltip).toContain("not isolation between sessions");
  expect(tooltip).toContain("Core and app MCP tools retain their own granted access");
});

it("does not guess native execution when the mode has not been reported", async () => {
  await act(async () => root.render(<SessionExecutionIndicator />));
  expect(container.querySelector('[data-slot="session-execution"]')).toBeNull();
  expect(container.textContent).toBe("");
});
