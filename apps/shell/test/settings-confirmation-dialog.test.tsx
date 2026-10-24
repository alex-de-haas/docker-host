import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { SettingsConfirmationDialog } from "../src/app/shell/dialogs/settings-confirmation-dialog";

vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch: vi.fn() }));
let root: Root, container: HTMLDivElement;
const response = (status: string) => new Response(JSON.stringify({ status }), { headers: { "Content-Type": "application/json" } });
const review = (id: string) => ({ url: `https://core.example/settings/confirm/${id}`, statusUrl: `/api/settings-changes/${id}`, headers: new Headers(), complete: vi.fn(), fail: vi.fn() });
const receive = (entry: ReturnType<typeof review>) => act(async () => { window.dispatchEvent(new CustomEvent("hosty:settings-review", { detail: entry })); });
const cancel = () => act(async () => { [...document.querySelectorAll("button")].find(button => button.textContent?.startsWith("Cancel"))!.click(); });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers(); vi.spyOn(window, "open").mockReturnValue(null);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each(["success", "failure"])("a late cancel %s cannot settle or replace a newer review", async outcome => {
  const a = review("a"), b = review("b"); let resolveCancel!: (value: Response) => void; let reads = 0;
  vi.mocked(appFetch).mockImplementation(async (input, init) => {
    if (init?.method === "DELETE") return new Promise(resolve => { resolveCancel = resolve; });
    return response(String(input).endsWith("/a") && ++reads > 1 ? "denied" : "pending");
  });
  await act(async () => root.render(<SettingsConfirmationDialog />)); await receive(a); await cancel();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(a.fail).toHaveBeenCalledTimes(1); await receive(b);
  await act(async () => resolveCancel(new Response(null, { status: outcome === "success" ? 204 : 500 })));
  expect(document.querySelector(`a[href="${b.url}"]`)).not.toBeNull();
  expect(b.fail).not.toHaveBeenCalled(); expect(b.complete).not.toHaveBeenCalled(); expect(a.fail).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).not.toContain("could not cancel");
});

it("cancels a repeated click once and lets an already completed poll settle exactly once", async () => {
  const a = review("a"); let finish!: (value: Response) => void; let reads = 0;
  vi.mocked(appFetch).mockImplementation(async (_input, init) => {
    if (init?.method === "DELETE") return new Promise(resolve => { finish = resolve; });
    return response(++reads === 1 ? "pending" : "succeeded");
  });
  await act(async () => root.render(<SettingsConfirmationDialog />)); await receive(a); await cancel(); await cancel();
  expect(vi.mocked(appFetch).mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(a.complete).toHaveBeenCalledTimes(1);
  await act(async () => finish(new Response(null, { status: 204 })));
  expect(a.complete).toHaveBeenCalledTimes(1); expect(a.fail).not.toHaveBeenCalled();
});

it("aborts disposed reads and cancellation without completing an interrupted review", async () => {
  const a = review("a"); let finishRead!: (value: Response) => void; let finishCancel!: (value: Response) => void;
  const signals: AbortSignal[] = [];
  vi.mocked(appFetch).mockImplementation(async (_input, init) => {
    if (init?.signal) signals.push(init.signal);
    return new Promise(resolve => { if (init?.method === "DELETE") finishCancel = resolve; else finishRead = resolve; });
  });
  await act(async () => root.render(<SettingsConfirmationDialog />)); await receive(a); await cancel();
  await act(async () => root.unmount()); root = createRoot(container);
  expect(signals).toHaveLength(2); expect(signals.every(signal => signal.aborted)).toBe(true);
  await act(async () => { finishRead(response("approved")); finishCancel(new Response(null, { status: 204 })); });
  expect(a.complete).not.toHaveBeenCalled(); expect(a.fail).toHaveBeenCalledTimes(1);
});

it("does not apply an approved change after Cancel while cancellation is still unresolved", async () => {
  const a = review("a"); let finish!: (value: Response) => void; let reads = 0;
  vi.mocked(appFetch).mockImplementation(async (_input, init) => {
    if (init?.method === "DELETE") return new Promise(resolve => { finish = resolve; });
    return response(++reads === 1 ? "pending" : "approved");
  });
  await act(async () => root.render(<SettingsConfirmationDialog />)); await receive(a); await cancel();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(a.complete).not.toHaveBeenCalled(); expect(a.fail).not.toHaveBeenCalled();
  await act(async () => finish(new Response(null, { status: 500 })));
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(a.complete).not.toHaveBeenCalled(); expect(document.body.textContent).toContain("could not cancel");
  await cancel(); await act(async () => finish(new Response(null, { status: 204 })));
  expect(a.complete).not.toHaveBeenCalled(); expect(a.fail).toHaveBeenCalledTimes(1);
});
