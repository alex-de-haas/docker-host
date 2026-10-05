// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { SessionAutonomy } from "./session-autonomy";
import type { AssistantSession } from "../lib/assistant-api";
const api = vi.hoisted(() => ({ setSessionAutonomy: vi.fn() }));
vi.mock("@/lib/assistant-api", () => api);
let container: HTMLDivElement, root: Root;
const change = vi.fn(), saving = vi.fn();
const chat = (extra = {}) => ({ id: "chat", status: "idle", ...extra }) as AssistantSession;
const render = async (session = chat(), busy = false) => act(async () => root.render(
  <SessionAutonomy session={session} busy={busy} onChange={change} onSavingChange={saving} />,
));
const trigger = () => container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
const select = async () => {
  await act(async () => trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(item => item.textContent?.startsWith("Autonomous"))!;
  expect(item.textContent).toContain("Harness process permissions");
  await act(async () => item.click());
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.clearAllMocks();
  api.setSessionAutonomy.mockResolvedValue(chat({ autonomy: "autonomous" }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it("defaults to Normal and changes only after an explicit choice", async () => {
  await render(); expect(trigger().textContent).toContain("Normal"); expect(api.setSessionAutonomy).not.toHaveBeenCalled();
  await select(); expect(api.setSessionAutonomy).toHaveBeenCalledWith("chat", "autonomous");
  expect(change).toHaveBeenCalledWith(expect.objectContaining({ autonomy: "autonomous" }));
  await render(chat({ autonomy: "autonomous" })); expect(trigger().textContent).toContain("Autonomous");
});
it.each(["running", "awaiting_approval", "awaiting_question"])("disables changes while %s", async status => {
  await render(chat({ status, autonomy: "autonomous" })); expect(trigger().disabled).toBe(true);
  expect(trigger().title).toContain("Stop");
});
it("preserves the confirmed mode on failure and blocks the composer during saving", async () => {
  let reject!: (reason: Error) => void;
  api.setSessionAutonomy.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
  await render(); await select(); expect(trigger().disabled).toBe(true); expect(saving).toHaveBeenLastCalledWith(true);
  await act(async () => reject(new Error("Session busy")));
  expect(trigger().textContent).toContain("Normal"); expect(change).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Session busy");
  expect(saving).toHaveBeenLastCalledWith(false);
});
