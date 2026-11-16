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

it("describes provider ownership without inferring an operating-system boundary", async () => {
  await act(async () => root.render(<SessionExecutionIndicator harnessKind="agent" />));
  const badge = container.querySelector<HTMLElement>('[data-slot="session-execution"]')!;
  expect(badge.textContent).toBe("");
  expect(badge.getAttribute("aria-label")).toBe("Session execution: Provider-owned execution");
  expect(badge.hasAttribute("title")).toBe(false);
  expect(container.querySelector("button")).toBeNull();
  await act(async () => badge.focus());
  const tooltip = document.querySelector('[role="tooltip"]')?.textContent ?? "";
  expect(tooltip).toContain("Provider-owned execution");
  expect(tooltip).toContain("selected agent provider application's environment");
  expect(tooltip).toContain("MCP tools retain their own granted access and approval rules");
  expect(tooltip).not.toMatch(/elevated|administrator|root user|Docker worker|unprivileged user|native Harness process/i);
});

it("does not describe legacy native identity as a current execution boundary", async () => {
  await act(async () => root.render(<SessionExecutionIndicator harnessKind="codex" />));
  expect(container.querySelector('[data-slot="session-execution"]')).toBeNull();
});

it("does not guess native execution when the mode has not been reported", async () => {
  await act(async () => root.render(<SessionExecutionIndicator />));
  expect(container.querySelector('[data-slot="session-execution"]')).toBeNull();
  expect(container.textContent).toBe("");
});
