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
import { createUiHost } from "@hosty-sdk/app/ui/host";

const fetch = vi.hoisted(() => vi.fn());
const presentation = vi.hoisted(() => ({ openSurface: vi.fn(), subscribe: vi.fn() }));
vi.mock("@hosty-sdk/app/ui/react", () => ({ useHostyUi: () => presentation }));
const target = { panel: { appId: "assistant", installationId: "installed-1", panelId: "assistant" }, route: "/assistant?session=existing" };
const result = { url: "https://core.example/open-discussion", target, conversationId: "existing" };
vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch: fetch }));
const document = parseSourceDocument("docs/features/example/plan.md", "# Plan\nFull document");
const detail: PlanDetail = { path: document.path, document, error: null, workspaces: [], repository: {
  id: "repo", repository: "https://git.example/repo", branch: "main", workspaceDerived: false, apps: [], state: "available", error: null, commit: "commit", fetchedAt: null,
} };
const options = { userId: "admin", providers: [{ appId: "assistant", installationId: "installed-1", key: "default", displayName: "Assistant", problem: null }] };
let root: Root, container: HTMLDivElement;
async function render(current = detail, workspaceId: string | null = null) {
  await act(async () => root.render(createElement(DiscussPlan, { detail: current, workspaceId })));
}
const button = () => container.querySelector<HTMLButtonElement>('button[aria-label="Discuss with Assistant"]')!;
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("TextEncoder", TextEncoder);
  sessionStorage.clear(); fetch.mockReset(); presentation.openSurface.mockReset();
  presentation.subscribe.mockReset().mockImplementation(() => () => {});
  presentation.openSurface.mockImplementation(async (_target, options) => ({ status: "opened", requestId: options.requestId, target, readiness: "ready" }));
  fetch.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST"
    ? response(result) : response(options));
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
    expect(discussionVersion({ ...both, document: null }, null)).toBeNull();
    expect(discussionVersion({ ...both, document: null }, "workspace")?.workspaceId).toBe("workspace");
  });
  it("never substitutes a different version for a removed or failed selection", () => {
    expect(discussionVersion(detail, "missing")).toBeNull();
    expect(discussionVersion({ ...detail, workspaces: [{ ...workspaceVersion, document: null }] }, "workspace")).toBeNull();
    expect(discussionVersion({ ...detail, document: null, error: "unavailable", workspaces: [workspaceVersion] }, null)).toBeNull();
  });
});

describe("discuss document action", () => {
  it("disables duplicate activation while attaching and exposes only an explicit separate link", async () => {
    let finish!: (value: unknown) => void;
    fetch.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST" ? new Promise(resolve => { finish = resolve; }) : response(options));
    await render();
    await act(async () => { button().click(); button()?.click(); });
    await vi.waitFor(() => expect(fetch.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1));
    expect(container.querySelector<HTMLButtonElement>('button[aria-busy="true"]')?.disabled).toBe(true);
    expect(window.open).not.toHaveBeenCalled();
    await act(async () => finish(response(result)));
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
  it.each(["document", "content", "workspace", "actor", "provider", "roundtrip"])("does not present a completed handoff after the %s context changes", async change => {
    let finish!: (value: unknown) => void;
    let discovery = options;
    fetch.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST"
      ? new Promise(resolve => { finish = resolve; }) : response(discovery));
    const initial = { ...detail, workspaces: [{ workspace: { id: "workspace", branch: "work" }, document: { ...document, content: "Workspace content" }, error: null } as WorkspacePlan] };
    await render(initial);
    await act(async () => button().click());
    if (change === "document" || change === "roundtrip") {
      await render({ ...initial, path: "docs/features/other/plan.md" });
      if (change === "roundtrip") await render(initial);
    } else if (change === "content") {
      await render({ ...initial, document: { ...document, content: "Changed document" } });
    } else if (change === "workspace") {
      await render(initial, "workspace");
    } else {
      discovery = change === "actor" ? { ...options, userId: "another-user" }
        : { ...options, providers: [{ ...options.providers[0], installationId: "installed-2" }] };
      await act(async () => window.dispatchEvent(new Event("focus")));
    }
    await act(async () => finish(response(result)));
    expect(presentation.openSurface).not.toHaveBeenCalled();
    expect(container.querySelector("a")).toBeNull();
    expect(window.open).not.toHaveBeenCalled();
    if (change === "roundtrip") {
      // Returning to the source does not auto-open it; an explicit action reuses the finalized result.
      await act(async () => button().click());
      expect(presentation.openSurface).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1);
    }
  });
  it("does not present a pending handoff after its component unmounts", async () => {
    let finish!: (value: unknown) => void;
    fetch.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST"
      ? new Promise(resolve => { finish = resolve; }) : response(options));
    await render(); await act(async () => button().click());
    await act(async () => root.unmount()); root = createRoot(container);
    await act(async () => finish(response(result)));
    expect(presentation.openSurface).not.toHaveBeenCalled();
  });
  it("does not show an old document's handoff error beside a new document", async () => {
    let finish!: (value: unknown) => void;
    fetch.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST"
      ? new Promise(resolve => { finish = resolve; }) : response(options));
    await render(); await act(async () => button().click());
    await render({ ...detail, path: "docs/features/other/plan.md" });
    await act(async () => finish(response({ message: "Old document disappeared" }, false)));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(presentation.openSurface).not.toHaveBeenCalled();
    expect(button().disabled).toBe(false);
  });
  it("requires a choice when multiple assistants are installed", async () => {
    fetch.mockResolvedValue(response({ ...options, providers: [...options.providers, { ...options.providers[0], appId: "second" }] }));
    await render(); expect(button().disabled).toBe(true);
    const select = container.querySelector("select")!;
    await act(async () => { select.value = "second:default"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(button().disabled).toBe(false); expect(window.open).not.toHaveBeenCalled();
  });
  it("opens the finalized target beside the document without a popup or model send", async () => {
    await render(); await act(async () => button().click());
    expect(presentation.openSurface).toHaveBeenCalledWith(target, { placement: "side", requestId: expect.any(String) });
    expect(window.open).not.toHaveBeenCalled();
    expect(fetch.mock.calls.filter(call => call[1]?.method === "POST").map(call => call[0])).toEqual(["/api/assistant"]);
    expect(container.textContent).toContain("Discussion opened beside the document.");
  });
  it("retries only presentation with the same ID after an uncertain open", async () => {
    presentation.openSurface.mockResolvedValueOnce({ status: "uncertain", code: "presentation_unknown" });
    await render(); await act(async () => button().click());
    const retry = Array.from(container.querySelectorAll("button")).find(item => item.textContent === "Retry opening")!;
    await act(async () => retry.click());
    expect(presentation.openSurface.mock.calls[1]).toEqual(presentation.openSurface.mock.calls[0]);
    expect(fetch.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1);
    expect(window.open).not.toHaveBeenCalled();
    expect(container.querySelector("a")?.rel).toBe("noopener noreferrer");
  });
  it.each(["Retry opening", "Discuss with Assistant"])("reopens an explicitly closed panel through %s without another handoff", async action => {
    const metadata = { version: 1, coreOrigin: "https://core.example", userId: "admin", canHost: true, pinnedOpen: true,
      app: { appId: "plans", installationId: "plans-1", origins: [window.location.origin] } };
    const surface = { ...target.panel, endpoint: "web", route: target.route, origin: "https://assistant.example",
      framePolicy: { microphone: false, popupEscape: false } };
    fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("bootstrap")) return Response.json(metadata);
      if (url.endsWith("panels/resolve")) return Response.json({ target, surface, available: true, state: "running", standaloneHref: result.url });
      if (url.includes("/api/hosty/ui/")) return Response.json({ panels: [] });
      return response(init?.method === "POST" ? result : options);
    });
    const host = createUiHost(), frames = new Map<string, HTMLIFrameElement>();
    host.registerWorkspace({ workspaceId: "default", renderer: {
      async present(tool) { if (!frames.has(tool.presentationId)) { const frame = window.document.createElement("iframe");
        window.document.body.append(frame); frames.set(tool.presentationId, frame); } return "accepted"; },
      focus() {}, collapse() {}, showToolPicker: async () => "accepted",
      release(id) { frames.get(id)?.remove(); frames.delete(id); },
    } });
    presentation.openSurface.mockImplementation(host.openSurface);
    try {
      await host.refresh(); await render(); await act(async () => button().click());
      expect(frames.size).toBe(1);
      const first = host.getSnapshot().tools[0]!, firstRequest = presentation.openSurface.mock.calls[0][1].requestId;
      host.closePresentation(first.presentationId); expect(frames.size).toBe(0);
      await act(async () => (action === "Discuss with Assistant" ? button()
        : Array.from(container.querySelectorAll("button")).find(item => item.textContent === action)!).click());
      expect(frames.size).toBe(1);
      expect(presentation.openSurface.mock.calls[1][1].requestId).not.toBe(firstRequest);
      const reopened = host.getSnapshot().tools[0]!;
      expect(reopened.presentationId).not.toBe(first.presentationId); expect(reopened.target).toEqual(target);
      // A later lost acknowledgement must still replay its pending request, even after reopening.
      presentation.openSurface.mockImplementationOnce(async (nextTarget, nextOptions) => {
        await host.openSurface(nextTarget, nextOptions);
        return { status: "uncertain", requestId: nextOptions.requestId, code: "presentation_unknown" };
      });
      await act(async () => button().click());
      await act(async () => Array.from(container.querySelectorAll("button")).find(item => item.textContent === "Retry opening")!.click());
      expect(presentation.openSurface.mock.calls[3][1].requestId).toBe(presentation.openSurface.mock.calls[2][1].requestId);
      expect(host.getSnapshot().tools[0]!.presentationId).toBe(reopened.presentationId); expect(frames.size).toBe(1);
      expect(fetch.mock.calls.filter(([url, init]) => url === "/api/assistant" && init?.method === "POST")).toHaveLength(1);
      expect(window.open).not.toHaveBeenCalled();
    } finally { host.dispose(); for (const frame of frames.values()) frame.remove(); }
  });
  it("uses a fresh request after an uncertain opening is acknowledged by a late event", async () => {
    let notify!: (event: unknown) => void;
    presentation.subscribe.mockImplementation(listener => { notify = listener; return () => {}; });
    presentation.openSurface.mockResolvedValueOnce({ status: "uncertain", code: "presentation_unknown" });
    await render(); await act(async () => button().click());
    const requestId = presentation.openSurface.mock.calls[0][1].requestId;
    await act(async () => notify({ type: "presentation", value: { status: "opened", requestId, target, readiness: "ready" } }));
    await act(async () => Array.from(container.querySelectorAll("button")).find(item => item.textContent === "Retry opening")!.click());
    expect(presentation.openSurface.mock.calls[1][1].requestId).not.toBe(requestId);
    expect(fetch.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1);
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
  it.each(["bare UUID", "JSON UUID", "missing identity", "invalid UUID", "null"])("requires explicit replacement of a legacy or malformed pending record: %s", async format => {
    fetch.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST"
      ? Promise.reject(new TypeError("Response lost")) : response(options));
    await render(); await act(async () => button().click());
    const key = sessionStorage.key(0)!;
    const original = JSON.parse(sessionStorage.getItem(key)!);
    const saved = format === "bare UUID" ? original.requestId : format === "JSON UUID" ? JSON.stringify(original.requestId)
      : format === "missing identity" ? JSON.stringify({ requestId: original.requestId })
        : format === "invalid UUID" ? JSON.stringify({ ...original, requestId: "invalid" }) : "null";
    sessionStorage.setItem(key, saved);
    await act(async () => root.unmount()); root = createRoot(container);
    fetch.mockClear();
    fetch.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST" ? response(result) : response(options));
    await render();
    await act(async () => button().click());
    await act(async () => button().click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("cannot be resumed safely");
    expect(fetch.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(0);
    expect(sessionStorage.getItem(key)).toBe(saved);
    expect(presentation.openSurface).not.toHaveBeenCalled();
    const start = Array.from(container.querySelectorAll("button")).find(item => item.textContent === "Start a new discussion")!;
    await act(async () => start.click());
    const calls = fetch.mock.calls.filter(call => call[1]?.method === "POST");
    expect(calls).toHaveLength(1);
    const input = JSON.parse(calls[0][1].body);
    expect(input.requestId).not.toBe(original.requestId);
    expect(input.installationId).toBe("installed-1");
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual({ requestId: input.requestId, installationId: input.installationId });
  });
  it("shows optional permission review and refreshes discovery on return", async () => {
    fetch.mockResolvedValueOnce(response({ message: "Plans needs assistant access.", reviewUrl: "https://core.example/install/permissions/hosty.plans" }, false));
    await render(); expect(button().disabled).toBe(true);
    expect(container.querySelector("a")?.textContent).toBe("Review Plans permissions");
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(button().disabled).toBe(false); expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  it.each([true, false])("revalidates completed discussions after reinstall before an explicit new handoff (panel: %s)", async hasPanel => {
    fetch.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST"
      ? response({ ...result, target: hasPanel ? target : null }) : response(options));
    await render(); await act(async () => button().click());
    const first = JSON.parse(fetch.mock.calls.find(call => call[1]?.method === "POST")![1].body);
    // Repeated activation still reuses the completed result for the same installation.
    await act(async () => button().click());
    expect(fetch.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1);
    const oldPresentations = presentation.openSurface.mock.calls.length;
    const replacement = { ...target, panel: { ...target.panel, installationId: "installed-2" }, route: "/assistant?session=replacement" };
    fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return response({ ...options, providers: [{ ...options.providers[0], installationId: "installed-2" }] });
      return JSON.parse(init.body as string).installationId === "installed-1"
        ? response({ message: "The assistant installation changed.", code: "provider_changed" }, false)
        : response({ ...result, url: "https://core.example/replacement-discussion", target: hasPanel ? replacement : null, conversationId: "replacement" });
    });
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => button().click());
    const retried = JSON.parse(fetch.mock.calls.filter(call => call[1]?.method === "POST")[1][1].body);
    expect(retried).toEqual(first);
    expect(presentation.openSurface).toHaveBeenCalledTimes(oldPresentations);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("The assistant installation changed.");
    const start = Array.from(container.querySelectorAll("button")).find(item => item.textContent === "Start a new discussion")!;
    await act(async () => start.click());
    const created = JSON.parse(fetch.mock.calls.filter(call => call[1]?.method === "POST")[2][1].body);
    expect(created.installationId).toBe("installed-2");
    expect(created.requestId).not.toBe(first.requestId);
    expect(created.contentHash).toBe(first.contentHash);
    if (hasPanel) expect(presentation.openSurface).toHaveBeenLastCalledWith(replacement, expect.objectContaining({ placement: "side" }));
    expect(container.querySelector("a")?.href).toBe("https://core.example/replacement-discussion");
    expect(window.open).not.toHaveBeenCalled();
  });
});
