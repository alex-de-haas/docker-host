// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StorageRecoveryNotice } from "./storage-recovery-notice";
import { getStorageRecovery, type StorageRecoveryReport } from "@/lib/assistant-api";

vi.mock("@/lib/assistant-api", () => ({ getStorageRecovery: vi.fn() }));
let root: Root, container: HTMLDivElement;
const issue = { sessionId: "damaged-session", code: "session_storage_unavailable", message: "This conversation needs storage recovery." };
const render = () => act(async () => root.render(<StorageRecoveryNotice />));
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(getStorageRecovery).mockResolvedValue({ issues: [issue] });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("reports bounded recovery diagnostics without any restore, delete or send action", async () => {
  vi.mocked(getStorageRecovery).mockResolvedValue({ issues: [issue], projectionIssues: [{ ...issue, code: "history_projection_unavailable", message: "The history view is unavailable." }] });
  await render();
  expect(container.textContent).toContain("1 reported session storage issue");
  expect(container.textContent).toContain("1 history view needs attention");
  expect(container.querySelector("details")?.textContent).toContain(issue.sessionId);
  expect([...container.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Refresh"]);
});

it("refreshes only on focus or explicit action and preserves known issues during a failed read", async () => {
  vi.useFakeTimers(); await render();
  await act(async () => vi.advanceTimersByTimeAsync(60_000)); expect(getStorageRecovery).toHaveBeenCalledOnce();
  vi.mocked(getStorageRecovery).mockRejectedValueOnce(new Error("Read unavailable ".repeat(100)));
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(getStorageRecovery).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain(issue.message);
  expect(container.querySelector('[role="alert"]')?.textContent?.length).toBe(240);
  vi.mocked(getStorageRecovery).mockResolvedValueOnce({ issues: [] });
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(getStorageRecovery).toHaveBeenCalledTimes(3); expect(container.textContent).toBe("");
});

it.each([null, { issues: [] }])("keeps an older endpoint or a healthy empty inventory unobtrusive: %j", async value => {
  vi.mocked(getStorageRecovery).mockResolvedValue(value); await render(); expect(container.textContent).toBe("");
});

it("does not overlap focus reads and aborts its request when the page closes", async () => {
  let settle!: (value: StorageRecoveryReport | null) => void;
  vi.mocked(getStorageRecovery).mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
  await render();
  const signal = vi.mocked(getStorageRecovery).mock.calls[0][0]!;
  await act(async () => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("focus")); });
  expect(getStorageRecovery).toHaveBeenCalledOnce();
  await act(async () => root.render(<></>)); expect(signal.aborted).toBe(true);
  await act(async () => settle({ issues: [issue] })); expect(container.textContent).toBe("");
});

it("does not mistake an empty network error for a healthy inventory", async () => {
  vi.mocked(getStorageRecovery).mockRejectedValueOnce(new Error()); await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Storage recovery status is unavailable.");
});
