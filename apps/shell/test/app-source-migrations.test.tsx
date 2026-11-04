import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppSourceMigrations } from "../src/app/shell/pages/app-source-migrations";
import type { CoreApp } from "../src/app/shell/types";

const origin = "https://core.test", key = `hosty-source-migration:${origin}`;
const batch = { requestId: "a".repeat(32), items: [{ appId: "example.app", planDigest: "b".repeat(64) }] };
let root: Root, container: HTMLDivElement;
const send = vi.fn(), changed = vi.fn(async () => {});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ suggestions: [] }))));
  sessionStorage.clear(); send.mockReset(); changed.mockClear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const button = (text: string) => [...container.querySelectorAll("button")].find(item => item.textContent?.includes(text))!;
async function render() { await act(async () => root.render(<AppSourceMigrations coreOrigin={origin} apps={[{ id: "example.app", displayName: "Example" } as CoreApp]} sendCsrfJson={send} onChanged={changed} />)); }

it("replays an uncertain operation with its original exact batch and permits reviewed return", async () => {
  sessionStorage.setItem(key, JSON.stringify(batch));
  send.mockRejectedValueOnce(new TypeError("Network connection lost"));
  await render(); await act(async () => button("Recover").click());
  expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(batch);
  send.mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ appId: "example.app", operation: { status: "completed", previous: { manifestUrl: "https://old.test/main.json", feedsUrl: null, feedId: null } } }] })));
  await act(async () => button("Recover").click());
  expect(send.mock.calls.slice(0,2).map(call => call[1])).toEqual([batch,batch]);
  expect(sessionStorage.getItem(key)).toBeNull(); expect(changed).toHaveBeenCalledOnce();
  send.mockResolvedValueOnce(new Response(JSON.stringify({ appId: "example.app", from: {}, to: { manifestUrl: "https://old.test/main.json" }, ordering: "installed-ahead", targetVersion: "0.1.0", planDigest: "c".repeat(64) })));
  await act(async () => button("previous source").click());
  expect(send.mock.lastCall).toEqual([`${origin}/api/apps/example.app/update-source/plan`, { manifestUrl: "https://old.test/main.json" }]);
  expect(container.textContent).toContain("installed version is ahead and will be kept");
});

it("clears a definitively rejected review so the operator can create a new plan", async () => {
  sessionStorage.setItem(key, JSON.stringify(batch));
  send.mockRejectedValueOnce(Object.assign(new Error("Not approved"), { code: "settings_review_not_applied" }));
  await render(); await act(async () => button("Recover").click());
  expect(sessionStorage.getItem(key)).toBeNull(); expect(button("Recover")).toBeUndefined();
});

it.each(["{invalid", "null", JSON.stringify({ ...batch, items: [null] }), JSON.stringify({ ...batch, items: [...batch.items, ...batch.items] })])("discards malformed retained operations: %s", async value => {
  sessionStorage.setItem(key, value); await render();
  expect(sessionStorage.getItem(key)).toBeNull(); expect(send).not.toHaveBeenCalled();
});

it("keeps publisher sources fixed and directs channel selection to the app Updates tab", async () => {
  await render();
  expect(container.textContent).toContain("Updates tab");
  expect(container.querySelector("input:not([type=checkbox]),select")).toBeNull();
  expect(button("Review source switch")).toBeUndefined();
});
