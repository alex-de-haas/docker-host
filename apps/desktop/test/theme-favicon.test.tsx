import { act } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThemeFavicon } from "../../../shared/web/theme-favicon";

let root: Root | undefined;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  document.documentElement.removeAttribute("class");
  document.documentElement.removeAttribute("data-hosty-theme");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function icon() {
  const links = document.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"]');
  expect(links).toHaveLength(1);
  return links[0].getAttribute("href");
}
async function theme(value: "light" | "dark") {
  await act(async () => {
    document.documentElement.classList.toggle("dark", value === "dark");
    document.documentElement.dataset.hostyTheme = value;
  });
}
it("hydrates the adaptive server icon into the saved document theme without a mismatch", async () => {
  const html = renderToString(<ThemeFavicon />);
  expect(html).toContain('href="/favicon.svg"');
  document.head.innerHTML = html;
  await theme("dark");
  const error = vi.fn();
  await act(async () => { root = hydrateRoot(container, <ThemeFavicon />, { onRecoverableError: error }); });
  expect(icon()).toBe("/favicon-dark.svg");
  expect(error).not.toHaveBeenCalled();
});
it("keeps one icon through app and host theme changes and disconnects when unmounted", async () => {
  const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
  root = createRoot(container);
  await act(async () => root!.render(<ThemeFavicon />));
  expect(icon()).toBe("/favicon.svg");
  await theme("light");
  expect(icon()).toBe("/favicon-light.svg");
  await theme("dark");
  expect(icon()).toBe("/favicon-dark.svg");
  await theme("light");
  expect(icon()).toBe("/favicon-light.svg");
  await act(async () => root!.unmount());
  root = undefined;
  expect(disconnect).toHaveBeenCalledTimes(1);
});
