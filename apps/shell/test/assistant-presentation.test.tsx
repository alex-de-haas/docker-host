import React, { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UiHost } from "@hosty-sdk/app/ui/host";
import type { PresentationResult } from "@hosty-sdk/app/ui";
import type { PresentedHandoff } from "../src/app/shell/assistant/assistant-client";
import { useAssistantPresentation } from "../src/app/shell/assistant/use-assistant-presentation";

let root: Root, element: HTMLDivElement;
let presentation: ReturnType<typeof useAssistantPresentation>;
const session = { id: "completed", result: {}, target: { panel: { appId: "assistant", installationId: "install-1", panelId: "chat" }, route: "/panel?session=completed" },
  url: "https://core.test/open/pinned-completed-session" } as PresentedHandoff;
const openSurface = vi.fn();
const host = { openSurface } as unknown as UiHost;
function Harness({ user = "alice", activeHost = host }: { user?: string; activeHost?: UiHost | null }) {
  const value = useAssistantPresentation(activeHost, user);
  useEffect(() => { presentation = value; });
  return value.notice;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); openSurface.mockReset();
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function link() { return element.querySelector<HTMLAnchorElement>("a"); }
function retry() { return [...element.querySelectorAll("button")].find(button => button.textContent === "Retry opening"); }

it.each(["navigation", "missing-host", "blocked", "unsupported", "uncertain"])("keeps completed results actionable after %s presentation", async reason => {
  const popup = vi.spyOn(window, "open");
  openSurface.mockResolvedValue({ status: reason });
  await act(async () => root.render(<Harness activeHost={reason === "missing-host" ? null : host} />));
  await act(async () => presentation.reveal(reason === "navigation" ? { ...session, target: null } : session));
  expect(link()?.href).toBe(session.url);
  expect(link()?.rel).toBe("noopener noreferrer");
  expect(link()?.target).toBe("_blank");
  expect(!!retry()).toBe(!["navigation", "missing-host"].includes(reason));
  expect(popup).not.toHaveBeenCalled();
});
it("retries the same presentation and removes recovery after successful placement", async () => {
  openSurface.mockResolvedValueOnce({ status: "blocked" }).mockResolvedValueOnce({ status: "opened" });
  await act(async () => root.render(<Harness />));
  await act(async () => presentation.reveal(session));
  await act(async () => retry()!.click());
  expect(openSurface).toHaveBeenCalledTimes(2);
  expect(openSurface.mock.calls[1]).toEqual(openSurface.mock.calls[0]);
  expect(openSurface.mock.calls[0]![0]).toEqual(session.target);
  expect(link()).toBeNull();
});
it("retains recovery even if a host unexpectedly throws", async () => {
  openSurface.mockRejectedValue(new Error("Host disconnected"));
  await act(async () => root.render(<Harness />));
  await act(async () => { await expect(presentation.reveal(session)).rejects.toThrow("Host disconnected"); });
  expect(link()?.href).toBe(session.url);
  await act(async () => retry()!.click());
  expect(link()?.href).toBe(session.url);
  expect(retry()?.disabled).toBe(false);
});
it("hides recovery on actor change and ignores a late completion for the previous actor", async () => {
  openSurface.mockResolvedValueOnce({ status: "blocked" });
  await act(async () => root.render(<Harness />));
  await act(async () => presentation.reveal(session));
  let finish!: (result: PresentationResult) => void;
  openSurface.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let pending!: Promise<void>;
  await act(async () => { pending = presentation.reveal(session); });
  await act(async () => root.render(<Harness user="bob" />));
  expect(link()).toBeNull();
  await act(async () => { finish({ status: "blocked" } as PresentationResult); await pending; });
  expect(link()).toBeNull();
  await act(async () => root.render(<Harness user="alice" />));
  expect(link()).toBeNull();
});
