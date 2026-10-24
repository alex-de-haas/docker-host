// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SdkChromeStyles } from "./sdk-chrome";

let root: Root | undefined;
let container: HTMLElement | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; container?.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
function Fixture({ extra = true }: { extra?: boolean }) {
  return <StrictMode><input aria-label="App draft" defaultValue="Saved text" /><SdkChromeStyles />{extra && <SdkChromeStyles />}</StrictMode>;
}
it("keeps server chrome deterministic without serializing module-relative font URLs", () => {
  const html = renderToString(<Fixture />);
  expect(html).not.toContain("file:");
  expect(html).not.toContain("@font-face");
  expect(html).not.toContain("assets/");
  expect(document.head.querySelector("[data-hosty-sdk-fonts]")).toBeNull();
});
it("hydrates without replacing an app draft and shares one font sheet through StrictMode and owner replay", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const recoverable = vi.fn();
  container = document.createElement("div"); container.innerHTML = renderToString(<Fixture />); document.body.append(container);
  const input = container.querySelector("input")!; input.value = "Typed before hydration";
  await act(async () => { root = hydrateRoot(container!, <Fixture />, { onRecoverableError: recoverable }); });
  expect(recoverable).not.toHaveBeenCalled(); expect(errors).not.toHaveBeenCalled();
  expect(container.querySelector("input")).toBe(input); expect(input.value).toBe("Typed before hydration");
  const fonts = document.head.querySelector("[data-hosty-sdk-fonts]")!;
  expect(fonts).not.toBeNull(); expect(document.head.querySelectorAll("[data-hosty-sdk-fonts]")).toHaveLength(1);
  await act(async () => root!.render(<Fixture extra={false} />));
  expect(document.head.querySelector("[data-hosty-sdk-fonts]")).toBe(fonts);
  await act(async () => root!.render(<Fixture />));
  expect(document.head.querySelector("[data-hosty-sdk-fonts]")).toBe(fonts);
  expect(document.head.querySelectorAll("[data-hosty-sdk-fonts]")).toHaveLength(1);
  await act(async () => { root!.unmount(); root = undefined; });
  expect(document.head.querySelector("[data-hosty-sdk-fonts]")).toBeNull();
});
