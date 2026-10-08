// @vitest-environment jsdom
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { webcrypto } from "node:crypto";
import { TextEncoder } from "node:util";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DiscussPlan } from "./discuss-plan";
import { discussionVersion } from "@/lib/discussion";
import { parseSourceDocument } from "@/lib/parser";
import type { PlanDetail, WorkspacePlan } from "@/lib/types";

const fetch = vi.hoisted(() => vi.fn());
vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch: fetch }));
const document = parseSourceDocument("docs/features/example/plan.md", "# Plan\nFull document");
const detail: PlanDetail = { path: document.path, document, error: null, workspaces: [], repository: {
  id: "repo", repository: "https://git.example/repo", branch: "main", workspaceDerived: false, apps: [], state: "available", error: null, commit: "commit", fetchedAt: null,
} };
const options = { userId: "admin", providers: [{ appId: "assistant", key: "default", displayName: "Assistant", problem: null }] };
let root: Root, container: HTMLDivElement;
async function render(current = detail, workspaceId: string | null = null) {
  await act(async () => root.render(createElement(DiscussPlan, { detail: current, workspaceId })));
}
const button = () => container.querySelector<HTMLButtonElement>('button[aria-label="Discuss with Assistant"]')!;
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("TextEncoder", TextEncoder);
  sessionStorage.clear(); fetch.mockReset();
  fetch.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST"
    ? response({ url: "https://core.example/open-discussion" }) : response(options));
  vi.spyOn(window, "open").mockReturnValue(null);
  container = window.document.createElement("div"); window.document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("discussion version selection", () => {
  const workspaceVersion = { workspace: { id: "workspace", branch: "work" }, document: { ...document, content: "workspace content" }, error: null } as WorkspacePlan;
  it("uses tracked content by default and the explicit workspace when selected", () => {
    const both = { ...detail, workspaces: [workspaceVersion] };
    expect(discussionVersion(both, null)?.document).toBe(document);
    expect(discussionVersion(both, "workspace")?.document.content).toBe("workspace content");
    expect(discussionVersion({ ...both, document: null }, null)?.workspaceId).toBe("workspace");
  });
  it("never substitutes a different version for a removed or failed selection", () => {
    expect(discussionVersion(detail, "missing")).toBeNull();
    expect(discussionVersion({ ...detail, workspaces: [{ ...workspaceVersion, document: null }] }, "workspace")).toBeNull();
    expect(discussionVersion({ ...detail, document: null, error: "unavailable", workspaces: [workspaceVersion] }, null)).toBeNull();
  });
});

describe("discuss document action", () => {
  it("disables duplicate activation while attaching and exposes a link if the new tab is blocked", async () => {
    let finish!: (value: unknown) => void;
    fetch.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST" ? new Promise(resolve => { finish = resolve; }) : response(options));
    await render();
    await act(async () => { button().click(); button()?.click(); });
    await vi.waitFor(() => expect(fetch.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1));
    expect(container.querySelector<HTMLButtonElement>('button[aria-busy="true"]')?.disabled).toBe(true);
    expect(window.open).toHaveBeenCalledTimes(1);
    await act(async () => finish(response({ url: "https://core.example/open-discussion" })));
    expect(container.querySelector("a")?.href).toBe("https://core.example/open-discussion");
    expect(button().disabled).toBe(false);
  });
  it("retains the same request identity after a lost response and a component remount", async () => {
    fetch.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST" ? Promise.reject(new TypeError("Network unavailable")) : response(options));
    await render(); await act(async () => button().click());
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("Network unavailable"));
    const first = JSON.parse(fetch.mock.calls.find(call => call[1]?.method === "POST")![1].body);
    await act(async () => root.unmount()); root = createRoot(container); await render();
    await act(async () => button().click());
    await vi.waitFor(() => expect(fetch.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(2));
    const second = JSON.parse(fetch.mock.calls.filter(call => call[1]?.method === "POST")[1][1].body);
    expect(second).toEqual(first); expect(second.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("requires a choice when multiple assistants are installed", async () => {
    fetch.mockResolvedValue(response({ ...options, providers: [...options.providers, { ...options.providers[0], appId: "second" }] }));
    await render(); expect(button().disabled).toBe(true);
    const select = container.querySelector("select")!;
    await act(async () => { select.value = "second:default"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(button().disabled).toBe(false); expect(window.open).not.toHaveBeenCalled();
  });
  it("opens the finalized destination in the reserved tab without a model send", async () => {
    const tab = { opener: window, document: { title: "", body: { textContent: "" } }, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
    vi.mocked(window.open).mockReturnValue(tab as unknown as Window);
    await render(); await act(async () => button().click());
    expect(tab.opener).toBeNull(); expect(tab.location.replace).toHaveBeenCalledWith("https://core.example/open-discussion");
    expect(fetch.mock.calls.filter(call => call[1]?.method === "POST").map(call => call[0])).toEqual(["/api/assistant"]);
    expect(tab.close).not.toHaveBeenCalled();
  });
  it("starts a new request only after an explicit action when a handoff is closed", async () => {
    fetch.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST"
      ? response({ message: "This handoff expired.", code: "handoff_closed" }, false) : response(options));
    await render(); await act(async () => button().click());
    const first = JSON.parse(fetch.mock.calls.find(call => call[1]?.method === "POST")![1].body).requestId;
    const start = Array.from(container.querySelectorAll("button")).find(item => item.textContent === "Start a new discussion")!;
    await act(async () => start.click());
    const second = JSON.parse(fetch.mock.calls.filter(call => call[1]?.method === "POST")[1][1].body).requestId;
    expect(first).not.toBe(second);
  });
  it("shows optional permission review and refreshes discovery on return", async () => {
    fetch.mockResolvedValueOnce(response({ message: "Plans needs assistant access.", reviewUrl: "https://core.example/install/permissions/hosty.plans" }, false));
    await render(); expect(button().disabled).toBe(true);
    expect(container.querySelector("a")?.textContent).toBe("Review Plans permissions");
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(button().disabled).toBe(false); expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
