// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostThemeBridge, type HostThemeBridgeProps } from "./react";
import { createShellThemeMessage, THEME_ATTRIBUTE, THEME_PREFERENCE_ATTRIBUTE, THEME_STORAGE_KEY, THEME_PREFERENCE_STORAGE_KEY } from "./theme";

let root: Root, element: HTMLDivElement, dark: boolean, media: EventTarget;
const current = () => document.documentElement.getAttribute(THEME_ATTRIBUTE);
const render = async (props: HostThemeBridgeProps = {}) => { await act(async () => root.render(<HostThemeBridge {...props} />)); };
const changeSystem = async (next: boolean) => {
  dark = next;
  await act(async () => media.dispatchEvent(new Event("change")));
};
const store = (theme: string, preference: string) => {
  sessionStorage.setItem(THEME_STORAGE_KEY, theme);
  sessionStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, preference);
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  dark = false;
  media = new EventTarget();
  Object.defineProperty(media, "matches", { get: () => dark });
  vi.stubGlobal("matchMedia", vi.fn(() => media));
  sessionStorage.clear();
  history.replaceState({}, "", "/");
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute(THEME_ATTRIBUTE);
  document.documentElement.removeAttribute(THEME_PREFERENCE_ATTRIBUTE);
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});

afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

it("follows system changes by default without creating a stored override", async () => {
  await render();
  expect(current()).toBe("light");
  await changeSystem(true);
  expect(current()).toBe("dark");
  await changeSystem(false);
  expect(current()).toBe("light");
  expect(sessionStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
});

it.each([true, false])("restores stale system mode and follows changes after reload (followSystem=%s)", async (followSystem) => {
  store("dark", "system");
  const onTheme = vi.fn();
  await render({ followSystem, onTheme });
  expect(current()).toBe("light");
  expect(onTheme).toHaveBeenLastCalledWith("light", "system");
  await changeSystem(true);
  expect(current()).toBe("dark");
  expect(sessionStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  expect(sessionStorage.getItem(THEME_PREFERENCE_STORAGE_KEY)).toBe("system");
  await act(async () => root.unmount());
  dark = false;
  root = createRoot(element);
  await render({ followSystem, onTheme });
  expect(current()).toBe("light");
  expect(document.documentElement.style.colorScheme).toBe("light");
});

it("resolves a standalone system launch and consumes only theme URL parameters", async () => {
  history.replaceState({}, "", "/?hosty_theme=dark&hosty_theme_preference=system&session=keep#turn");
  await render();
  expect(current()).toBe("light");
  expect(location.search + location.hash).toBe("?session=keep#turn");
  await changeSystem(true);
  expect(current()).toBe("dark");
});

it.each(["light", "dark"])("preserves an explicit %s choice across OS changes", async (choice) => {
  store(choice, choice);
  await render();
  await changeSystem(true);
  expect(current()).toBe(choice);
  await changeSystem(false);
  expect(current()).toBe(choice);
});

it("leaves an undeclared standalone theme to the app's own provider", async () => {
  const onTheme = vi.fn();
  await render({ followSystem: false, onTheme });
  await changeSystem(true);
  expect(current()).toBeNull();
  expect(onTheme).not.toHaveBeenCalled();
});

it("keeps the embedded host authoritative and accepts its later system and manual changes", async () => {
  const parent = {};
  vi.stubGlobal("parent", parent);
  history.replaceState({}, "", "/?hosty_theme=dark&hosty_theme_preference=system");
  await render();
  expect(current()).toBe("dark");
  await changeSystem(false);
  expect(current()).toBe("dark");
  const post = async (theme: "light" | "dark", preference: "light" | "dark" | "system") => {
    await act(async () => window.dispatchEvent(new MessageEvent("message", {
      source: parent as Window, data: createShellThemeMessage(theme, preference),
    })));
  };
  await post("light", "system");
  expect(current()).toBe("light");
  await changeSystem(true);
  expect(current()).toBe("light");
  await post("dark", "dark");
  expect(current()).toBe("dark");
});

it("removes listeners on unmount", async () => {
  const onTheme = vi.fn();
  await render({ onTheme });
  await act(async () => root.unmount());
  root = createRoot(element);
  await changeSystem(true);
  expect(onTheme).toHaveBeenCalledTimes(1);
});
