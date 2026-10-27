// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { Tasks } from "./tasks";
import { call } from "@/lib/api";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import type { TaskRecord } from "@hosty-sdk/app/tasks";
vi.mock("@/lib/api", () => ({ call: vi.fn(), ApiError: class extends Error { status = 400; } }));
vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch: vi.fn() }));
vi.mock("@/components/markdown", () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));
let root: Root, container: HTMLDivElement, stream: ReadableStreamDefaultController<Uint8Array>, task: TaskRecord;
const provider = { appId: "example.tasks", installationId: "one", key: "default" };
const click = async (name: string) => act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent === name)!.click(); });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  task = { ref: { ...provider, id: "d3384b62-3740-4604-8c0f-b527751c9643" }, number: "HRN-1", revision: 1, inputRevision: 1, title: "Original title", markdown: "Original description", requiresReview: false, resources: [], assignee: null, status: "Draft", createdAt: "now", updatedAt: "now", createdBy: { userId: "owner", appId: null }, owner: { userId: "owner", appId: null }, cancelRequested: false, attempts: [] };
  vi.mocked(appFetch).mockImplementation(async (_url, init) => {
    const body = new ReadableStream<Uint8Array>({ start(c) { stream = c; init?.signal?.addEventListener("abort", () => c.close()); } });
    return new Response(body);
  });
  vi.mocked(call).mockImplementation(async url => Response.json(url === "/tasks/v1/directory"
    ? { provider, users: [{ id: "owner", displayName: "Owner" }], executors: [{ ...provider, displayName: "Harness", available: true, options: [{ id: "writer", name: "Writer" }] }], workspaces: { workspaces: [] } } : { tasks: [task], nextCursor: null }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
const mount = async () => { await act(async () => root.render(<Tasks />)); await act(async () => { container.querySelector<HTMLButtonElement>('nav[aria-label="Tasks"] button')!.click(); }); };
it("renders lifecycle and live changes without replacing unsaved input", async () => {
  await mount();
  const title = container.querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Unsaved title");
    title.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(title.value).toBe("Unsaved title");
  task = { ...task, revision: 2, title: "Concurrent change" };
  await act(async () => { stream.enqueue(new TextEncoder().encode("event: changed\ndata: {}\n\n")); });
  expect(title.value).toBe("Unsaved title");
  expect(container.textContent).toContain("changed while you were editing");
  await click("Discard edits");
  expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("Concurrent change");
});
it("keeps the exact mutation after a lost reply and offers explicit replay", async () => {
  await mount();
  const original = vi.mocked(call).getMockImplementation()!;
  let lost = true;
  vi.mocked(call).mockImplementation(async (url, init) => {
    if (init?.method === "POST") { if (lost) { lost = false; throw new Error("Reply lost"); } return Response.json({ ...task, status: "Ready", revision: 2 }); }
    return original(url, init);
  });
  await click("Ready");
  expect(container.textContent).toContain("Retry original request");
  const first = vi.mocked(call).mock.calls.find(([, options]) => options?.method === "POST")!;
  await click("Retry original request");
  const mutations = vi.mocked(call).mock.calls.filter(([, options]) => options?.method === "POST");
  expect(mutations).toHaveLength(2); expect(mutations[1]).toEqual(first);
});

it("offers people and executors in the assignee selector", async () => {
  await mount();
  expect(container.querySelector('option[value="human:owner"]')?.textContent).toBe("Owner");
  expect(container.querySelector('option[value="app:example.tasks:one:default"]')?.textContent).toBe("Harness");
});

it("keeps a confirmed mutation usable when the following list refresh fails", async () => {
  await mount();
  vi.mocked(call).mockImplementation(async (_url, init) => {
    if (init?.method === "POST") return Response.json({ ...task, status: "Ready", revision: 2 });
    throw new Error("Refresh unavailable");
  });
  await click("Ready");
  expect(container.textContent).toContain("Refresh unavailable");
  expect(container.textContent).not.toContain("Retry original request");
  expect([...container.querySelectorAll("button")].find(b => b.textContent === "New task")!.disabled).toBe(false);
  expect(container.textContent).toContain("HRN-1 · Ready");
});

it.each(["Ready", "Cancelled"] as const)("preserves and recovers dirty input after a background transition to %s", async status => {
  await mount();
  const title = container.querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Preserved local title");
    title.dispatchEvent(new Event("input", { bubbles: true }));
  });
  task = { ...task, status, revision: 2, title: "Saved title" };
  await act(async () => { stream.enqueue(new TextEncoder().encode("event: changed\ndata: {}\n\n")); });
  const preserved = container.querySelector<HTMLInputElement>("input");
  expect(preserved?.value).toBe("Preserved local title");
  expect(preserved?.matches(":disabled")).toBe(true);
  expect([...container.querySelectorAll("button")].find(b => b.textContent === "Save draft")?.disabled).toBe(true);
  await click("Discard edits");
  expect(container.textContent).toContain("Saved title");
  await click("New task");
  expect(container.querySelector<HTMLInputElement>("input")?.value).toBe("");
  expect(container.querySelector<HTMLInputElement>("input")?.disabled).toBe(false);
});

async function delayedExecutor() {
  const original = vi.mocked(call).getMockImplementation()!;
  let resolve!: (response: Response) => void;
  vi.mocked(call).mockImplementation(async (url, init) => {
    if (url === "/tasks/v1/executor-options") return new Promise<Response>(r => { resolve = r; });
    const response = await original(url, init);
    if (url !== "/tasks/v1/directory") return response;
    const directory = await response.json(); directory.executors[0].options = null;
    return Response.json(directory);
  });
  await mount();
  await act(async () => {
    const select = container.querySelector<HTMLOptionElement>('option[value="app:example.tasks:one:default"]')!.closest("select")!;
    select.value = "app:example.tasks:one:default"; select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return () => act(async () => { resolve(Response.json({ options: [{ id: "writer", name: "Writer" }], defaultId: "writer" })); });
}
it("preserves title and description edits while executor options load", async () => {
  const complete = await delayedExecutor();
  await act(async () => {
    const title = container.querySelector<HTMLInputElement>("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Latest title");
    title.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    const description = container.querySelector<HTMLTextAreaElement>("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(description, "Latest description");
    description.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await complete();
  expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("Latest title");
  expect(container.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("Latest description");
  expect(container.querySelector<HTMLOptionElement>('option[value="writer"]')!.selected).toBe(true);
});
it("ignores an old executor response after choosing a person", async () => {
  const complete = await delayedExecutor();
  await act(async () => {
    const select = container.querySelector<HTMLOptionElement>('option[value="human:owner"]')!.closest("select")!;
    select.value = "human:owner"; select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await complete();
  expect(container.querySelector<HTMLOptionElement>('option[value="human:owner"]')!.selected).toBe(true);
});
it("marks executor selection dirty immediately and ignores responses after discarding and navigating", async () => {
  const complete = await delayedExecutor();
  expect([...container.querySelectorAll("button")].some(b => b.textContent === "Discard edits")).toBe(true);
  await click("Discard edits"); await click("New task");
  await complete();
  expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("");
  expect(container.querySelector<HTMLOptionElement>('option[value="human:owner"]')!.closest("select")!.value).toBe("");
});
