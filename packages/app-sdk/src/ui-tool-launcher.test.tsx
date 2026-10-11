// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { EmbeddedUiClient } from "./ui-embedded";
import { HostyToolLauncher } from "./ui-navigation-react";
import { bindUiClient, createPresentationRequestId } from "./ui";

vi.mock("./browser-auth", () => ({ appFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
it("hides the legacy-host launcher, delegates after negotiation and disables it on disconnect", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.documentElement.removeAttribute("data-hosty-chrome-hints");
  const originalParent = window.parent, originalTop = window.top, parent = { postMessage: vi.fn() };
  Object.defineProperty(window, "parent", { configurable: true, value: parent });
  Object.defineProperty(window, "top", { configurable: true, value: parent });
  const own = { version: 1, coreOrigin: "https://core.test", userId: "alice", canHost: false, pinnedOpen: true,
    app: { appId: "plans", installationId: "plans-1", origins: [window.location.origin] },
    peer: { appId: "shell", installationId: "shell-1", origins: ["https://shell.test"] } };
  vi.stubGlobal("fetch", vi.fn(async (path: string) => Response.json(path.includes("bootstrap") ? own
    : { appId: "plans", installationId: "plans-1", revision: "one", entries: [] })));
  const client = new EmbeddedUiClient("/ui"), release = bindUiClient(client);
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  const probe = parent.postMessage.mock.calls[0]![0];
  const envelope = { version: 1, childNonce: probe.childNonce, hostWindowId: createPresentationRequestId(), generation: createPresentationRequestId() };
  const send = (message: object) => window.dispatchEvent(new MessageEvent("message", { source: parent as unknown as Window,
    origin: "https://shell.test", data: { ...envelope, ...message } }));
  const connected = { type: "hosty:ui:connected", coreOrigin: own.coreOrigin, userId: own.userId, appId: "shell", installationId: "shell-1" };
  try {
    await act(async () => root.render(<HostyToolLauncher />));
    expect(element.querySelector("button")).toBeNull();
    await act(async () => send({ type: "hosty:ui:offer" }));
    await act(async () => send(connected));
    expect(client.getChrome().tools.owner).toBe("host");
    expect(element.querySelector("button")).toBeNull();
    await act(async () => send({ ...connected, capabilities: ["ui.composition.v1"], revision: 1, chrome: {}, endpoint: "web" }));
    const button = element.querySelector("button")!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    const picker = parent.postMessage.mock.calls.map(([message]) => message).find(message => message.type === "hosty:ui:picker");
    expect(picker).toBeDefined();
    await act(async () => send({ type: "hosty:ui:action-result", requestId: picker.requestId, result: { status: "accepted", requestId: picker.requestId } }));
    expect(element.querySelector('[role="status"]')).toBeNull();
    await act(async () => client.setActive(false));
    expect(element.querySelector("button")?.disabled).toBe(true);
  } finally {
    await act(async () => root.unmount()); release(); client.dispose(); element.remove();
    Object.defineProperty(window, "parent", { configurable: true, value: originalParent });
    Object.defineProperty(window, "top", { configurable: true, value: originalTop });
    vi.unstubAllGlobals(); vi.restoreAllMocks();
  }
});
