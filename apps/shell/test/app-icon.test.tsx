import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Boxes } from "lucide-react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppIcon } from "../src/app/shell/app-icon";

vi.mock("lucide-react/dynamic", () => ({
  iconNames: ["rocket"],
  DynamicIcon: ({ name }: { name: string }) => <svg data-named-icon={name} />,
}));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it.each(["hosty.shell", "hosty.harness", "hosty.marketplace"])("renders the supplied Core icon for %s instead of an app-ID override", async appId => {
  // Older callers may still pass an app identity; it cannot override current manifest metadata.
  const props = { appId, src: `https://core.test/api/apps/${appId}/assets/icon.svg?version=current`, name: "Rocket", fallback: Boxes, alt: "Application" };
  await act(async () => root.render(<AppIcon {...props} />));
  expect(container.querySelector("img")?.getAttribute("src")).toBe(props.src);
  expect(container.querySelector("img")?.getAttribute("alt")).toBe("Application");
  expect(container.querySelector("svg")).toBeNull();
});

it("uses the named tool fallback after a failed image and retries a replacement URL", async () => {
  const oldSrc = "https://core.test/assets/old.svg", newSrc = "https://core.test/assets/current.svg";
  await act(async () => root.render(<AppIcon src={oldSrc} name="Rocket" fallback={Boxes} />));
  await act(async () => container.querySelector("img")!.dispatchEvent(new Event("error")));
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector('[data-named-icon="rocket"]')).not.toBeNull();
  await act(async () => root.render(<AppIcon src={newSrc} name="Rocket" fallback={Boxes} />));
  expect(container.querySelector("img")?.getAttribute("src")).toBe(newSrc);
  expect(container.querySelector("svg")).toBeNull();
});

it("preserves the generic fallback for missing or failed assets and unrecognized tool names", async () => {
  await act(async () => root.render(<AppIcon src={null} name="not-an-icon" fallback={Boxes} alt="Unavailable icon" />));
  expect(container.querySelector('svg[aria-label="Unavailable icon"]')).not.toBeNull();
  await act(async () => root.render(<AppIcon src="https://core.test/assets/broken.svg" fallback={Boxes} />));
  await act(async () => container.querySelector("img")!.dispatchEvent(new Event("error")));
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("svg.lucide-boxes")).not.toBeNull();
});
