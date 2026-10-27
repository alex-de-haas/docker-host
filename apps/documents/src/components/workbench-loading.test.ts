// @vitest-environment jsdom
import { act, createElement, Fragment, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DocumentsWorkbench } from "./workbench";
import type { RepositoryDocuments, SourceRepository } from "@/lib/types";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), observe: vi.fn(), query: new URLSearchParams() }));
vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch: mocks.fetch }));
vi.mock("@/lib/source-events", () => ({ observeSources: mocks.observe }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useSearchParams: () => mocks.query }));
vi.mock("./catalog-view", () => ({ CatalogView: ({ loading, loaded, refresh, error }: {
  loading: string | null; loaded: Record<string, RepositoryDocuments>; refresh: () => void; error: string | null;
}) => createElement(Fragment, null,
  createElement("p", { "data-testid": "loading" }, loading),
  createElement("p", { "data-testid": "loaded" }, Object.keys(loaded).join(",")),
  createElement("p", { "data-testid": "error" }, error),
  createElement("button", { onClick: refresh }, "Refresh sources")) }));
vi.mock("./discuss-plan", () => ({ DiscussPlan: ({ refresh }: { refresh: ReactNode }) => refresh }));
vi.mock("./translate-document", () => ({ TranslateDocument: () => null }));

type Pending = { url: string; signal: AbortSignal; resolve: (response: Response) => void; settled: boolean };
let requests: Pending[], root: Root, container: HTMLDivElement, changed: () => void;
const repositories: SourceRepository[] = Array.from({ length: 6 }, (_, index) => ({
  id: `repo-${index}`, repository: `https://example.test/repo-${index}.git`, branch: "main",
  workspaceDerived: false, apps: [], state: "available", error: null, commit: "head", fetchedAt: null,
}));
const progress = () => container.querySelector('[data-testid="loading"]')?.textContent;
const listingRequests = () => requests.filter(request => request.url === "/api/repositories");
const pending = (url: string) => requests.find(request => request.url === url && !request.settled)!;
async function answer(request: Pending, body: unknown, status = 200) {
  await act(async () => { request.settled = true; request.resolve(Response.json(body, { status })); });
}
async function render(query = mocks.query) {
  mocks.query = query;
  await act(async () => root.render(createElement(DocumentsWorkbench)));
}
async function event() {
  await act(async () => { changed(); await vi.advanceTimersByTimeAsync(201); });
}
async function repository(index: number, refresh = false, status = 200) {
  await answer(pending(`/api/repositories/repo-${index}${refresh ? "?refresh=true" : ""}`),
    status === 200 ? { repository: repositories[index], plans: [], workspaces: [], state: "available", error: null } : { message: "Temporarily unavailable" }, status);
}

beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  window.history.replaceState(null, "", "/?repository=&app="); sessionStorage.clear();
  mocks.query = new URLSearchParams("repository=&app="); requests = [];
  mocks.observe.mockImplementation((_repository, onChange) => { changed = onChange; return vi.fn(); });
  mocks.fetch.mockImplementation((url: string, { signal }: { signal: AbortSignal }) => new Promise<Response>((resolve, reject) => {
    const request = { url, signal, resolve, settled: false }; requests.push(request);
    signal.addEventListener("abort", () => { request.settled = true; reject(new DOMException("Aborted", "AbortError")); }, { once: true });
  }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetAllMocks();
});

it("finishes all six repositories without resetting progress when live events arrive during every read", async () => {
  await render(); await answer(pending("/api/repositories"), { repositories });
  expect(requests.filter(request => request.url.startsWith("/api/repositories/")).length).toBe(3);
  expect(progress()).toBe("Loading repositories… 0/6");
  for (let index = 0; index < 6; index++) {
    await event();
    expect(listingRequests()).toHaveLength(1);
    expect(requests.every(request => !request.signal.aborted)).toBe(true);
    await repository(index);
    if (index < 5) expect(progress()).toBe(`Loading repositories… ${index + 1}/6`);
  }
  expect(progress()).toBe("");
  expect(container.querySelector('[data-testid="loaded"]')?.textContent).toBe(repositories.map(item => item.id).join(","));
  expect(listingRequests()).toHaveLength(2);
  await answer(pending("/api/repositories"), { repositories });
  for (let index = 0; index < 6; index++) await repository(index);
  expect(listingRequests()).toHaveLength(2);
  expect(progress()).toBe("");
});

it("retains a manual forced refresh queued with live and visibility updates, even after a repository fails", async () => {
  await render(); await answer(pending("/api/repositories"), { repositories: repositories.slice(0, 2) });
  await act(async () => container.querySelector("button")!.click());
  await event();
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(listingRequests()).toHaveLength(1);
  await repository(0); await repository(1, false, 503);
  await answer(pending("/api/repositories"), { repositories: repositories.slice(0, 2) });
  expect(progress()).toBe("Loading repositories… 0/2");
  expect(pending("/api/repositories/repo-0?refresh=true")).toBeDefined();
  await repository(0, true); await repository(1, true);
  expect(progress()).toBe("");
  expect(listingRequests()).toHaveLength(2);
  await event(); await answer(pending("/api/repositories"), { repositories: [] });
  expect(progress()).toBe("");
});

it("retries a failed repository listing when an event arrived while it was pending", async () => {
  await render(); await event();
  await answer(pending("/api/repositories"), { message: "Source unavailable" }, 503);
  expect(listingRequests()).toHaveLength(2);
  await answer(pending("/api/repositories"), { repositories: [] });
  expect(container.querySelector('[data-testid="error"]')?.textContent).toBe("");
  expect(progress()).toBe("");
});

it("finishes a document read before revalidating and cancels it when the selected workspace changes", async () => {
  const path = "docs/features/example/feature.md";
  await render(new URLSearchParams({ repository: "repo-0", document: path }));
  const initial = requests[0];
  await event(); await event();
  expect(requests).toHaveLength(1); expect(initial.signal.aborted).toBe(false);
  await answer(initial, { repository: repositories[0], path, document: null, workspaces: [], error: null });
  expect(requests).toHaveLength(2);
  const revalidation = requests[1];
  await render(new URLSearchParams({ repository: "repo-0", document: path, workspace: "other" }));
  expect(revalidation.signal.aborted).toBe(true);
  expect(requests).toHaveLength(3);
  expect(requests[2].url).toContain("workspace=other");
});

it("aborts outstanding reads and discards queued reloads when leaving the catalog", async () => {
  await render(); await answer(pending("/api/repositories"), { repositories: repositories.slice(0, 3) });
  await event();
  const active = requests.filter(request => !request.settled);
  await render(new URLSearchParams({ repository: "repo-0", document: "docs/root.md" }));
  expect(active.every(request => request.signal.aborted)).toBe(true);
  expect(listingRequests()).toHaveLength(1);
  expect(requests.filter(request => request.url.startsWith("/api/document?"))).toHaveLength(1);
});
