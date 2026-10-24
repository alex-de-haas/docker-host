// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StatusBadge } from "./status";
import { AssistantActivity } from "./assistant-activity";

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it.each([
  ["awaiting_approval", "lucide-diamond"], ["awaiting_question", "lucide-diamond"],
  ["failed", "lucide-circle-alert"], ["unhealthy", "lucide-circle-alert"],
  ["offline", "lucide-circle"], ["running", "lucide-loader-circle"],
])("keeps the exact %s label with its distinct decorative state shape", async (value, icon) => {
  await act(async () => root.render(<StatusBadge value={value} />));
  expect(container.textContent).toBe(value);
  const glyph = container.querySelector(`.${icon}`)!;
  expect(glyph).not.toBeNull();
  expect(glyph.closest('[aria-hidden="true"]')).not.toBeNull();
});

it.each(["idle", "completed", "provider-specific state"])("does not infer a working or decision state for %s", async value => {
  await act(async () => root.render(<StatusBadge value={value} />));
  expect(container.textContent).toBe(value);
  expect(container.querySelector("svg")).toBeNull();
});

it("keeps approval/question activity distinct from work without changing connection precedence", async () => {
  const render = (status: string, connection: "connected" | "reconnecting" | "disconnected" = "connected") => act(async () => root.render(
    <AssistantActivity status={status} connection={connection} activity={null} stopping={false} appNames={{}} />));
  await render("running");
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Working…");
  expect(container.querySelector(".lucide-loader-circle")).not.toBeNull();
  await render("awaiting_approval");
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Waiting for approval…");
  expect(container.querySelector(".lucide-diamond")).not.toBeNull();
  expect(container.querySelector(".lucide-loader-circle")).toBeNull();
  await render("awaiting_question");
  expect(container.textContent).toBe("Waiting for your answer…");
  await render("awaiting_approval", "reconnecting");
  expect(container.textContent).toBe("Reconnecting…");
  expect(container.querySelector(".lucide-diamond")).toBeNull();
  expect(container.querySelector(".lucide-wifi-off")).not.toBeNull();
  await render("awaiting_approval", "disconnected");
  expect(container.querySelector('[role="status"]')).toBeNull();
});
