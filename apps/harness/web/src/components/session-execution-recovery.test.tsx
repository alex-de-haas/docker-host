// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionExecutionRecovery } from "./session-execution-recovery";
import * as api from "@/lib/assistant-api";
vi.mock("@/lib/assistant-api", () => ({ getExecutionRecovery: vi.fn(), recoverExecution: vi.fn(), AssistantApiError: class extends Error {} }));
let root: Root, container: HTMLDivElement;
const changed = vi.fn(async () => {});
const review = { runId: "run", generation: "generation", expectedRevision: 5, recoverable: true };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.mocked(api.getExecutionRecovery).mockResolvedValue(review); vi.mocked(api.recoverExecution).mockResolvedValue();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<SessionExecutionRecovery sessionId="chat" refreshKey="one" onRecovered={changed} />));
it("requires explicit confirmation and retains the identical request after an uncertain response", async () => {
  await render();
  expect(container.querySelector('button')!.disabled).toBe(true);
  await act(async () => container.querySelector('input')!.click());
  vi.mocked(api.recoverExecution).mockRejectedValueOnce(new Error("Connection lost"));
  await act(async () => container.querySelector('button')!.click());
  const input = vi.mocked(api.recoverExecution).mock.calls[0]![1];
  expect(input).toMatchObject({ runId: "run", expectedRevision: 5, consumerExitConfirmed: true });
  expect(container.textContent).toContain("Retry recovery"); expect(changed).not.toHaveBeenCalled();
  await act(async () => container.querySelector('button')!.click());
  expect(api.recoverExecution).toHaveBeenLastCalledWith("chat", input);
  expect(changed).toHaveBeenCalledOnce(); expect(localStorage.getItem("hosty.execution-recovery.chat")).toBeNull();
});
it("restores a server-retained confirmed request without inventing a new acknowledgement", async () => {
  const pending = { ...review, requestId: "retained", consumerExitConfirmed: true as const };
  vi.mocked(api.getExecutionRecovery).mockResolvedValue({ ...review, pending });
  await render(); expect(container.querySelector('input')).toBeNull();
  await act(async () => container.querySelector('button')!.click());
  expect(api.recoverExecution).toHaveBeenCalledWith("chat", pending);
});
it("shows no recovery action for an active or already stopped run", async () => {
  vi.mocked(api.getExecutionRecovery).mockResolvedValue(null); await render(); expect(container.textContent).toBe("");
  expect(api.recoverExecution).not.toHaveBeenCalled();
});
