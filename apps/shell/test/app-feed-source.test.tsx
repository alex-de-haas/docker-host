import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppFeedSource } from "../src/app/shell/dialogs/app-feed-source";
import type { CoreApp } from "../src/app/shell/types";

const { send, refresh } = vi.hoisted(() => ({ send: vi.fn(), refresh: vi.fn() }));
vi.mock("../src/app/shell/shell-context", () => ({ useShellActions: () => ({ sendCsrfJson: send, refresh }) }));
const origin = "https://core.test";
const app = { id: "org.independent.notes", installationId: "install-one" } as CoreApp;
const from = { manifestUrl: "https://publisher.test/main/manifest.json", feedsUrl: null, feedId: null };
const to = { manifestUrl: "https://publisher.test/releases/1/manifest.json", feedsUrl: "https://publisher.test/feeds.json", feedId: "candidate" };
const suggestion = { migration: { migrationId: "notes-ready", appId: app.id, from, to }, revision: "source-revision" };
const plan = { appId: app.id, from, to, targetVersion: "1.2.0", ordering: "newer-version", planDigest: "a".repeat(64) };
const storageKey = `hosty-app-update-source:${origin}:${app.id}:${app.installationId}`;
const requestId = "123456781234123412341234567890ab";
let root: Root, container: HTMLDivElement;
let changed = vi.fn<() => void>();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({ suggestions: [suggestion] })));
  vi.stubGlobal("crypto", { randomUUID: () => "12345678-1234-1234-1234-1234567890ab" });
  sessionStorage.clear(); send.mockReset(); refresh.mockReset(); refresh.mockResolvedValue(undefined); changed = vi.fn<() => void>();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = (active = true) => act(async () => root.render(<AppFeedSource app={app} coreOrigin={origin} active={active} unbound onChanged={changed} />));
const click = (text: string) => act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text)!.click());

it("offers only this application's declared migration and never changes the source on entry", async () => {
  vi.mocked(fetch).mockImplementation(async () => Response.json({ suggestions: [suggestion, { ...suggestion, migration: { ...suggestion.migration, appId: "other.app", to: { ...to, feedId: "other" } } }] }));
  await render(false); expect(fetch).not.toHaveBeenCalled();
  await render();
  expect(container.textContent).toContain("Review candidate feed");
  expect(container.textContent).not.toContain("Review other feed");
  expect(send).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
});

it("reviews old and new bindings, then applies only the reviewed digest with a durable UUID", async () => {
  send.mockResolvedValueOnce(Response.json(plan)).mockResolvedValueOnce(Response.json({ status: "completed", previous: from }));
  await render(); await click("Review candidate feed");
  expect(send).toHaveBeenNthCalledWith(1, `${origin}/api/apps/${app.id}/update-source/plan`, {
    feedsUrl: to.feedsUrl, feedId: "candidate", expectedRevision: "source-revision", migrationId: "notes-ready",
  });
  expect(container.textContent).toContain(from.manifestUrl); expect(container.textContent).toContain(to.feedsUrl);
  expect(send).toHaveBeenCalledTimes(1);
  await click("Use this update source");
  expect(send).toHaveBeenNthCalledWith(2, `${origin}/api/apps/${app.id}/update-source/apply`, { planDigest: plan.planDigest, requestId });
  expect(changed).toHaveBeenCalledOnce(); expect(refresh).toHaveBeenCalledOnce();
  expect(sessionStorage.getItem(storageKey)).toBeNull();
  expect(container.textContent).toContain("The installed version is unchanged");
  send.mockResolvedValueOnce(Response.json({ ...plan, from: to, to: from }));
  await click("Review previous source");
  expect(send).toHaveBeenLastCalledWith(`${origin}/api/apps/${app.id}/update-source/plan`, { manifestUrl: from.manifestUrl });
});

it("retains the exact uncertain operation across remount without applying it automatically", async () => {
  send.mockResolvedValueOnce(Response.json(plan)).mockRejectedValueOnce(new Error("Connection lost"));
  await render(); await click("Review candidate feed"); await click("Use this update source");
  expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toEqual({ requestId, plan });
  await act(async () => root.unmount()); root = createRoot(container);
  await render(); expect(send).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("Recover source switch result");
  send.mockResolvedValueOnce(Response.json({ status: "completed", previous: from }));
  await click("Recover source switch result");
  expect(send.mock.calls[2]).toEqual(send.mock.calls[1]);
  expect(sessionStorage.getItem(storageKey)).toBeNull();
});

it("discards a stale reviewed plan and leaves the refusal visible for a fresh source check", async () => {
  send.mockResolvedValueOnce(Response.json(plan)).mockResolvedValueOnce(Response.json({ code: "update_source_plan_stale", message: "The source changed. Review again." }, { status: 409 }));
  await render(); await click("Review candidate feed"); await click("Use this update source");
  expect(container.textContent).toContain("The source changed. Review again.");
  expect(container.textContent).not.toContain("Recover source switch result");
  expect(sessionStorage.getItem(storageKey)).toBeNull(); expect(changed).not.toHaveBeenCalled();
  await click("Retry source check"); expect(container.textContent).toContain("Review candidate feed");
});

it("does not retain or replay an operator-cancelled confirmation", async () => {
  send.mockResolvedValueOnce(Response.json(plan)).mockRejectedValueOnce(Object.assign(new Error("Review cancelled"), { code: "settings_review_not_applied" }));
  await render(); await click("Review candidate feed"); await click("Use this update source");
  expect(sessionStorage.getItem(storageKey)).toBeNull();
  expect(container.textContent).toContain("Review cancelled"); expect(changed).not.toHaveBeenCalled();
});

it("does not suggest a publisher for an unrelated direct installation", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ suggestions: [] }));
  await render();
  expect(container.textContent).toContain("The current installation source remains selected");
  expect(send).not.toHaveBeenCalled(); expect(container.querySelector("button")).toBeNull();
});

it("keeps a completed source switch completed when refreshing app details fails", async () => {
  refresh.mockRejectedValue(new Error("Refresh unavailable"));
  send.mockResolvedValueOnce(Response.json(plan)).mockResolvedValueOnce(Response.json({ status: "completed", previous: from }));
  await render(); await click("Review candidate feed"); await click("Use this update source");
  expect(sessionStorage.getItem(storageKey)).toBeNull();
  expect(container.textContent).toContain("The source was saved");
  expect(container.textContent).not.toContain("Recover source switch result"); expect(changed).toHaveBeenCalledOnce();
});
