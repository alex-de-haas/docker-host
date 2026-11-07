import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppStoragePanel, StorageBreakdown, StoragePage } from "../src/app/shell/storage/storage-view";
import { appStorage } from "../src/app/shell/storage/storage-data";
import type { StorageResource, StorageSnapshot, StorageState } from "../src/app/shell/storage/storage-data";

const api = vi.hoisted(() => ({ read: vi.fn(), send: vi.fn(), origin: "https://core.test" }));
vi.mock("../src/app/shell/core-transport.js", () => ({ fetchCore: api.read }));
vi.mock("../src/app/shell/shell-context", () => ({ useShellActions: () => ({ coreOrigin: api.origin, sendCsrfJson: api.send }) }));

function resource(id: string, category: string, bytes: number, extra: Partial<StorageResource> = {}): StorageResource {
  return { id, category, kind: "other", label: id, relativePath: `${category}/${id}`, allocatedBytes: bytes, logicalBytes: bytes,
    partial: false, appId: null, relatedAppIds: [], workspaceId: null, worktreeId: null, parts: [], ...extra };
}
function snapshot(extra: Partial<StorageSnapshot> = {}): StorageSnapshot {
  return { id: "snapshot-one", startedAt: "2026-11-06T12:00:00Z", measuredAt: "2026-11-06T12:00:01Z", durationMs: 1000,
    allocatedBytes: 1000, logicalBytes: 900, partial: false, disk: { totalBytes: 10000, availableBytes: 5000 },
    categories: [{ id: "apps", allocatedBytes: 600, logicalBytes: 500, partial: false }, { id: "sources", allocatedBytes: 400, logicalBytes: 400, partial: false }],
    resources: [resource("application", "apps", 600, { appId: "third.party", parts: [{ id: "data", allocatedBytes: 599, logicalBytes: 499 }, { id: "cache", allocatedBytes: 1, logicalBytes: 1 }] }),
      resource("shared-repository", "sources", 400, { relatedAppIds: ["third.party", "other.party"] })],
    issues: [], issueCount: 0, excludedMountCount: 0, excludedSymlinkCount: 0, ...extra };
}
function status(value: StorageSnapshot | null = snapshot(), isScanning = false): StorageState { return { snapshot: value, isScanning, lastError: null }; }

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.origin = "https://core.test";
  api.read.mockReset().mockImplementation(async () => Response.json(status()));
  api.send.mockReset().mockImplementation(async () => Response.json(status(null, true), { status: 202 }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const render = (node = <StoragePage dataRoot="/isolated/hosty" />) => act(async () => { root.render(node); });
const button = (text: string, scope: ParentNode = container) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.includes(text))!;
const click = async (item: HTMLElement) => act(async () => { item.click(); });

it("uses Hosty usage as the bar denominator, with capacity separate, and lets the legend open sorted categories", async () => {
  await render();
  expect(container.textContent).toContain("1,000 B");
  expect(container.textContent).toContain("4.9 KiB available on the volume");
  expect(container.textContent).toContain("/isolated/hosty");
  const categories = container.querySelector('[aria-label="Storage categories"]')!;
  expect([...categories.querySelectorAll("button")].map(item => item.textContent)).toEqual(["Applications600 B · 60%", "Sources & workspaces400 B · 40%"]);
  const bars = container.querySelectorAll<HTMLElement>('[aria-hidden="true"] button[tabindex="-1"]');
  expect(bars[0].style.width).toBe("60%");
  expect(bars[1].style.width).toBe("40%");
  const sources = button("Sources & workspaces", categories);
  sources.focus(); expect(document.activeElement).toBe(sources);
  await click(sources);
  expect(sources.getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector("#storage-category-title")?.textContent).toBe("Sources & workspaces");
  const row = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!;
  await click(row);
  expect(row.getAttribute("aria-expanded")).toBe("true");
  expect(container.textContent).toContain("Linked applications: third.party, other.party");
});

it("keeps tiny bar segments accessible by the full-size legend and shows their details", async () => {
  await render(<AppStoragePanel appId="third.party" />);
  const contents = container.querySelector('[aria-label="Application contents"]')!;
  const cache = button("Cache", contents);
  expect(cache.textContent).toContain("1 B");
  cache.focus(); expect(document.activeElement).toBe(cache);
  await click(cache);
  expect(cache.getAttribute("aria-pressed")).toBe("true");
  expect(container.textContent).toContain("Logical file size: 1 B");
});

it("counts owned app files once and keeps shared related resources outside its amount", async () => {
  const data = snapshot();
  expect(appStorage(data, "third.party")).toEqual({ own: [data.resources[0]], related: [data.resources[1]], allocatedBytes: 600 });
  await render(<AppStoragePanel appId="third.party" />);
  expect(container.querySelector(".text-2xl")?.textContent).toBe("600 B");
  expect(container.textContent).toContain("Related resources");
  expect(container.textContent).toContain("shared-repository");
  expect(container.textContent).toContain("excluded from the application files total");
  expect([...container.querySelectorAll("a")].find(link => link.textContent?.includes("Hosty storage overview"))?.getAttribute("href"))
    .toBe("/settings?tab=host&section=storage");
});

it("shows a missing app as unavailable instead of inventing a zero measurement", async () => {
  await render(<AppStoragePanel appId="new.application" />);
  expect(container.querySelector(".text-2xl")?.textContent).toBe("Unavailable");
  expect(container.textContent).toContain("not present in the measurement");
});

it("does not substitute logical sizes for unknown allocation or hide partial scan issues", async () => {
  api.read.mockResolvedValue(Response.json(status(snapshot({ allocatedBytes: null, partial: true, issueCount: 3,
    issues: [{ relativePath: "apps/restricted", code: "access_denied" }], excludedMountCount: 2, excludedSymlinkCount: 1,
    categories: [{ id: "apps", allocatedBytes: null, logicalBytes: 900, partial: true }] }))));
  await render();
  expect(container.querySelector(".text-3xl")?.textContent).toBe("Unavailable");
  expect(container.textContent).toContain("Allocated space is unavailable");
  expect(container.textContent).toContain("Measured partially");
  expect(container.textContent).toContain("Showing 1 of 3 issues");
  expect(container.textContent).toContain("2 mounted folders · 1 symbolic links");
});

it("only loads the cached snapshot on entry and observes an explicitly started recount until completion", async () => {
  vi.useFakeTimers();
  const previous = snapshot();
  api.send.mockResolvedValue(Response.json(status(previous, true), { status: 202 }));
  await render();
  expect(api.send).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(api.read).toHaveBeenCalledTimes(1);
  await click(button("Recount"));
  expect(api.send).toHaveBeenCalledWith("https://core.test/api/storage/refresh", { requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) }, "POST", expect.any(AbortSignal));
  expect(container.textContent).toContain("previous measurement remains visible");
  expect(button("Recounting").disabled).toBe(true);
  api.read.mockResolvedValue(Response.json(status(snapshot({ id: "snapshot-two", allocatedBytes: 2000 }))));
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(container.querySelector(".text-3xl")?.textContent).toBe("2 KiB");
  expect(button("Recount").disabled).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(api.read).toHaveBeenCalledTimes(2);
});

it("stops automatically observing a long scan, keeps the last snapshot, and offers a status check", async () => {
  vi.useFakeTimers();
  api.read.mockImplementation(async () => Response.json(status(snapshot(), true)));
  await render();
  for (let index = 0; index < 61; index++) await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(api.read).toHaveBeenCalledTimes(61);
  expect(container.textContent).toContain("Check its status to see the result");
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(api.read).toHaveBeenCalledTimes(61);
  await click(button("Check status"));
  expect(api.read).toHaveBeenCalledTimes(62);
});

it("keeps the same request UUID when retrying an uncertain refresh response", async () => {
  await render();
  api.send.mockRejectedValueOnce(new Error("Network response was lost."));
  await click(button("Recount"));
  expect(container.textContent).toContain("Network response was lost");
  const originalRequest = api.send.mock.calls[0][1];
  await click(button("Retry recount"));
  expect(api.send.mock.calls[1][1]).toEqual(originalRequest);
});

it("shows older-Core and permission refusals without a scan or recurring retries", async () => {
  vi.useFakeTimers();
  api.read.mockResolvedValue(Response.json({ code: "permission_denied", message: "Review Shell's storage permission in Core." }, { status: 403 }));
  await render();
  expect(container.textContent).toContain("Review Shell's storage permission in Core.");
  expect(button("Check status")).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(api.read).toHaveBeenCalledTimes(1);
  expect(api.send).not.toHaveBeenCalled();
});

it("does not draw a capacity bar or percentage for unavailable allocation", async () => {
  await render(<StorageBreakdown label="Unknown" total={null} segments={[{ id: "unknown", label: "Unknown", allocatedBytes: null, logicalBytes: 100 }]} />);
  expect(container.querySelector('[aria-hidden="true"] button')).toBeNull();
  expect(container.textContent).not.toContain("100%");
  expect(container.textContent).toContain("Unavailable");
});

it("orders resources with unavailable allocation by their known logical size", async () => {
  api.read.mockResolvedValue(Response.json(status(snapshot({ allocatedBytes: null,
    categories: [{ id: "sources", allocatedBytes: null, logicalBytes: 900, partial: false }],
    resources: [resource("a-small", "sources", 100, { allocatedBytes: null }), resource("z-large", "sources", 800, { allocatedBytes: null })],
  }))));
  await render();
  const legend = container.querySelector('[aria-label="Sources & workspaces resources"]')!;
  expect([...legend.querySelectorAll("button")].map(item => item.textContent)).toEqual(["z-largeUnavailable", "a-smallUnavailable"]);
  expect([...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]')].map(item => item.textContent)).toEqual([
    "z-largesources/z-largeUnavailable", "a-smallsources/a-smallUnavailable",
  ]);
  expect(container.querySelector(".text-3xl")?.textContent).toBe("Unavailable");
});

it("discards a late recount response from a previous Core without overwriting the current measurement", async () => {
  let finishOld!: (response: Response) => void;
  let finishCurrent!: (response: Response) => void;
  api.send.mockImplementationOnce(() => new Promise<Response>(resolve => { finishOld = resolve; }));
  await render();
  await click(button("Recount"));
  const oldSignal = api.send.mock.calls[0][3] as AbortSignal;
  api.origin = "https://other-core.test";
  api.read.mockImplementation(async () => Response.json(status(snapshot({ id: "other-core", allocatedBytes: 4000 }))));
  await render();
  expect(oldSignal.aborted).toBe(true);
  expect(container.querySelector(".text-3xl")?.textContent).toBe("3.9 KiB");
  expect(button("Recount").disabled).toBe(false);
  api.send.mockImplementationOnce(() => new Promise<Response>(resolve => { finishCurrent = resolve; }));
  await click(button("Recount"));
  await act(async () => { finishOld(Response.json(status(snapshot({ id: "old-recount", allocatedBytes: 8000 })))); });
  expect(container.querySelector(".text-3xl")?.textContent).toBe("3.9 KiB");
  expect(button("Starting recount").disabled).toBe(true);
  await act(async () => { finishCurrent(Response.json(status(snapshot({ id: "current-recount", allocatedBytes: 5000 })))); });
  expect(container.querySelector(".text-3xl")?.textContent).toBe("4.9 KiB");
  expect(button("Recount").disabled).toBe(false);
});
