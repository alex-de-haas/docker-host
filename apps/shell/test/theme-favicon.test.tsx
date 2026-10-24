import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { useTheme } from "next-themes";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThemeProvider } from "../src/components/theme-provider";

let root: Root;
let container: HTMLDivElement;
let darkSystem: boolean;
let listeners: Set<(event: { matches: boolean }) => void>;

function ThemeControls() {
  const { setTheme } = useTheme();
  return <>{["light", "dark", "system"].map(theme =>
    <button key={theme} onClick={() => setTheme(theme)}>{theme}</button>)}</>;
}
function favicon() {
  const icons = document.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"]');
  expect(icons).toHaveLength(1);
  return icons[0].getAttribute("href");
}
async function choose(theme: string) {
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === theme)!.click());
}
async function systemTheme(dark: boolean) {
  darkSystem = dark;
  await act(async () => listeners.forEach(listener => listener({ matches: dark })));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  darkSystem = true;
  listeners = new Set();
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    get matches() { return darkSystem; },
    addListener: (listener: (event: { matches: boolean }) => void) => listeners.add(listener),
    removeListener: (listener: (event: { matches: boolean }) => void) => listeners.delete(listener),
  })));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  document.documentElement.removeAttribute("class");
  document.documentElement.style.removeProperty("color-scheme");
  vi.unstubAllGlobals();
});

it("serves an adaptive favicon before hydration even when a saved dark theme is available", () => {
  localStorage.setItem("theme", "dark");
  const html = renderToString(<ThemeProvider><span>Shell</span></ThemeProvider>);
  expect(html).toContain('href="/favicon.svg"');
  expect(html).not.toContain('href="/favicon-dark.svg"');
  expect(html).not.toContain('href="/favicon.ico"');
});

it("follows system changes while preserving a manually selected theme with a single head icon", async () => {
  await act(async () => root.render(<ThemeProvider><ThemeControls /></ThemeProvider>));
  expect(favicon()).toBe("/favicon-dark.svg");
  await choose("light");
  expect(favicon()).toBe("/favicon-light.svg");
  await systemTheme(false);
  await systemTheme(true);
  expect(favicon()).toBe("/favicon-light.svg");
  await choose("system");
  expect(favicon()).toBe("/favicon-dark.svg");
  await systemTheme(false);
  expect(favicon()).toBe("/favicon-light.svg");
  await choose("dark");
  expect(favicon()).toBe("/favicon-dark.svg");
});

it("restores the saved theme and keeps one icon when page content changes", async () => {
  darkSystem = false;
  localStorage.setItem("theme", "dark");
  await act(async () => root.render(<ThemeProvider><span>Dashboard</span></ThemeProvider>));
  expect(favicon()).toBe("/favicon-dark.svg");
  await act(async () => root.render(<ThemeProvider><span>Settings</span></ThemeProvider>));
  expect(favicon()).toBe("/favicon-dark.svg");
});
