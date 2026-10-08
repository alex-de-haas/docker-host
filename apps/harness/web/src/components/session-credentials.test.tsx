// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appFetch, APP_ACTIVITY_RENEWED } from "@hosty-sdk/app/browser-auth";
import { SessionCredentials } from "./session-credentials";

vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch: vi.fn(), APP_ACTIVITY_RENEWED: "hosty:app-activity-renewed" }));
let node: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(appFetch).mockImplementation(async () => Response.json({ updated: true }));
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount()); node.remove(); vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("refreshes on ordinary app recovery without a chat approval or replacing the draft", async () => {
  const popup = vi.spyOn(window, "open");
  await act(async () => root.render(<><textarea defaultValue="Unsaved message"/><SessionCredentials sessionId="chat"/></>));
  const draft = node.querySelector("textarea");
  expect(appFetch).toHaveBeenCalledExactlyOnceWith("/api/sessions/chat/credentials", expect.objectContaining({ method: "POST" }));
  await act(async () => window.dispatchEvent(new Event(APP_ACTIVITY_RENEWED)));
  expect(appFetch).toHaveBeenCalledTimes(2);
  expect(popup).not.toHaveBeenCalled();
  expect(node.querySelector("aside")).toBeNull();
  expect(node.querySelector("textarea")).toBe(draft);
  expect(draft?.value).toBe("Unsaved message");
});

it("does not lose recovery while an earlier credential update is in flight", async () => {
  let finish!: (response: Response) => void;
  vi.mocked(appFetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(<SessionCredentials sessionId="chat"/>));
  await act(async () => window.dispatchEvent(new Event(APP_ACTIVITY_RENEWED)));
  expect(appFetch).toHaveBeenCalledTimes(1);
  await act(async () => finish(Response.json({ updated: true })));
  expect(appFetch).toHaveBeenCalledTimes(2);
});

it("shows a retry only after failure and clears it when refresh succeeds", async () => {
  vi.mocked(appFetch).mockResolvedValueOnce(Response.json({}, { status: 503 }));
  await act(async () => root.render(<SessionCredentials sessionId="chat"/>));
  expect(node.querySelector('[role="alert"]')?.textContent).toContain("Could not refresh");
  await act(async () => node.querySelector("button")!.click());
  expect(node.querySelector("aside")).toBeNull();
  expect(appFetch).toHaveBeenCalledTimes(2);
});

it("refreshes only the newly selected conversation after switching chats", async () => {
  await act(async () => root.render(<SessionCredentials sessionId="first"/>));
  const firstSignal = vi.mocked(appFetch).mock.calls[0]![1]!.signal!;
  await act(async () => root.render(<SessionCredentials sessionId="second"/>));
  expect(firstSignal.aborted).toBe(true);
  await act(async () => window.dispatchEvent(new Event(APP_ACTIVITY_RENEWED)));
  expect(appFetch).toHaveBeenCalledTimes(3);
  expect(appFetch).toHaveBeenLastCalledWith("/api/sessions/second/credentials", expect.anything());
});
