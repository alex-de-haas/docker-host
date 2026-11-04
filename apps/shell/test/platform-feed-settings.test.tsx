import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlatformFeedSettings } from "../src/app/shell/pages/platform-feed-settings";

const source = { indexRef: "https://publisher.test/platform/feeds.json", feedId: "Preview-2", revision: "binding-1" };
const feeds = [{ id: "Release", default: true }, { id: "Preview-2" }, { id: "Research" }];
let root: Root, container: HTMLDivElement;
const save = vi.fn(async () => new Response(JSON.stringify({ ...source, feedId: "Research", revision: "binding-2" })));
const read = vi.fn(async () => new Response(JSON.stringify({ source, indexRef: source.indexRef, index: { feeds } })));
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", read);
  save.mockClear(); read.mockClear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(<PlatformFeedSettings coreOrigin="https://core.test" sendCsrfJson={save} />)); }
const choose = () => container.querySelector<HTMLSelectElement>("#platform-feed")!;
const saveButton = () => [...container.querySelectorAll("button")].find(button => button.textContent === "Save feed")!;

it("renders arbitrary publisher feeds and preserves the saved choice over a different default", async () => {
  await render();
  expect([...choose().options].map(option => option.value)).toEqual(["", "Release", "Preview-2", "Research"]);
  expect(choose().value).toBe("Preview-2");
  expect(save).not.toHaveBeenCalled();
});

it("changes only the source with its reviewed revision, without invoking update", async () => {
  await render();
  await act(async () => { choose().value = "Research"; choose().dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => saveButton().click());
  expect(save).toHaveBeenCalledExactlyOnceWith("https://core.test/api/core/update-feed", { indexRef: source.indexRef, feedId: "Research", expectedRevision: "binding-1" }, "PUT");
  expect(container.querySelector('[role="status"]')?.textContent).toContain("saved");
});

it("requires reading the edited index before its feeds can be saved", async () => {
  await render();
  const input = container.querySelector<HTMLInputElement>("#platform-feed-index")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "https://another.test/feeds.json");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(choose().disabled).toBe(true); expect(saveButton().disabled).toBe(true);
  expect(save).not.toHaveBeenCalled();
});

it("reports rejected or stale source selection without claiming it was saved", async () => {
  save.mockResolvedValueOnce(new Response(JSON.stringify({ message: "The source changed; review it again.", code: "platform_source_changed" }), { status: 409 }));
  await render(); await act(async () => saveButton().click());
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("review it again");
  expect(choose().value).toBe("Preview-2");
});
