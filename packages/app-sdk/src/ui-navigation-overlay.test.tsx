// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostyOverlay } from "./overlay-react";
import { HostyNavigationBoundary, useHostyUiHost } from "./ui-react";
import { cancelActivityRenewal, forgetAppGrant } from "./browser-auth";
import type { UiHost } from "./ui-host";

let root: Root, element: HTMLDivElement, host: UiHost | null;
function Document() { host = useHostyUiHost(); return <textarea aria-label="Document" />; }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.clear();
  document.documentElement.removeAttribute("data-hosty-chrome-hints");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input), coreOrigin = "http://core.localhost:7070";
    if (path.includes("/session")) return Response.json({ status: "active", userId: "alice", hostRole: "host.user",
      recovery: { appId: "sample", corePublicOrigin: coreOrigin, appAuthProtocol: 2 },
      activeUntil: new Date(Date.now() + 3600_000).toISOString(), activityRequired: false, hosty: { version: 1, setup: "ready" } });
    if (path.endsWith("bootstrap")) return Response.json({ version: 1, coreOrigin, userId: "alice", canHost: true, pinnedOpen: true,
      app: { appId: "sample", installationId: "sample-1", origins: [window.location.origin] } });
    if (path.endsWith("navigation")) return Response.json({ appId: "sample", installationId: "sample-1", revision: "1", entries: [
      { key: "home", label: "Home", icon: null, endpoint: "web", origin: window.location.origin, route: "/", available: true, state: "running", standaloneHref: "/" },
    ] });
    return Response.json({ panels: [] });
  }));
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
  host = null; element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount()); element.remove(); cancelActivityRenewal(); forgetAppGrant();
  vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear();
});

it.each(["custom", "standard", "drawer"])("returns focus to app content when hiding %s navigation inside the real overlay", async mode => {
  vi.stubGlobal("innerWidth", mode === "drawer" ? 600 : 1200);
  await act(async () => root.render(<HostyOverlay panelLayout="none" navigation={{ renderer: mode === "custom" ? "custom" : "standard" }}>
    {mode === "custom" && <HostyNavigationBoundary><input aria-label="Custom navigation" defaultValue="Keep state" /></HostyNavigationBoundary>}
    <Document />
  </HostyOverlay>));
  expect(host).not.toBeNull();
  const outer = element.querySelector<HTMLElement>("[data-hosty-content]")!;
  const content = element.querySelector<HTMLElement>('.hosty-app-content[tabindex="-1"]')!;
  expect(outer).not.toBe(content); expect(outer.contains(content)).toBe(true);
  if (mode === "drawer") await act(async () => element.querySelector<HTMLButtonElement>('button[aria-label="Page navigation"]')!.click());
  const focusTarget = mode === "custom" ? element.querySelector<HTMLInputElement>('input[aria-label="Custom navigation"]')!
    : element.querySelector<HTMLAnchorElement>('nav[aria-label="App pages"] a')!;
  await act(async () => focusTarget.focus());
  expect(document.activeElement).toBe(focusTarget);
  if (mode === "drawer") expect(element.querySelector<HTMLDialogElement>("dialog")!.open).toBe(true);
  await act(async () => host!.setViewChrome("root", { navigation: "hide" }));
  expect(document.activeElement).toBe(content);
  if (mode === "drawer") expect(element.querySelector<HTMLDialogElement>("dialog")!.open).toBe(false);
  await act(async () => host!.setViewChrome("root", {}));
  expect(element.contains(focusTarget)).toBe(true);
  if (mode === "custom") expect((focusTarget as HTMLInputElement).value).toBe("Keep state");
});
