// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextEncoder } from "node:util";
import { createHash } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { TranslateDocument } from "./translate-document";
import { parseSourceDocument } from "@/lib/parser";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch: fetch }));
const document = parseSourceDocument("docs/features/example/plan.md", "---\nstatus: Ready\ncreated: 2026-10-15\nupdated: 2026-10-15\nsummary: An example.\n---\n# Example\n\n## Deliverables\n- [ ] D1. Read this\n");
const options = { userId: "admin", providers: ["codex", "claude"].map(key => ({ appId: "harness", installationId: "installed", key, displayName: "Harness", problem: null })) };
const result = { body: "# Пример\n\n## Результаты\n- [ ] D1. Прочитать\n", contentHash: createHash("sha256").update(document.content).digest("hex"), targetLanguage: "ru", providerAppId: "harness", key: "claude" };
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });
let root: Root, container: HTMLDivElement;
const button = (label: string) => Array.from(container.querySelectorAll("button")).find(b => b.textContent === label)!;
const postCalls = () => fetch.mock.calls.filter(call => call[1]?.method === "POST");
async function render(current = document, workspaceId: string | null = null) {
  await act(async () => root.render(createElement(TranslateDocument, { document: current, repositoryId: "repo", workspaceId, navigate: vi.fn() })));
}
async function open() { await act(async () => button("Translate").click()); }
async function selectClaude() {
  const select = container.querySelector<HTMLSelectElement>('[aria-label="Translation provider"]')!;
  await act(async () => { select.value = JSON.stringify(["harness", "claude", "installed"]); select.dispatchEvent(new Event("change", { bubbles: true })); });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("TextEncoder", TextEncoder); fetch.mockReset();
  fetch.mockImplementation(async (_url: string, init?: RequestInit) => response(init?.method === "POST" ? result : options));
  container = window.document.createElement("div"); window.document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
describe("document translation view", () => {
  it("discovers only on demand, requires a provider choice and preserves original metadata", async () => {
    await render(); expect(fetch).not.toHaveBeenCalled(); await open(); expect(button("Translate document").disabled).toBe(true);
    await selectClaude(); await act(async () => button("Translate document").click());
    expect(postCalls()).toHaveLength(1); expect(JSON.parse(postCalls()[0][1].body)).toMatchObject({ key: "claude", targetLanguage: "ru", contentHash: result.contentHash, workspaceId: null });
    expect(container.querySelector(".markdown")?.textContent).toContain("Результаты");
    expect(container.textContent).not.toContain("Document needs attention");
    await act(async () => button("Show original").click()); expect(container.querySelector(".markdown")?.textContent).toContain("Deliverables");
    await act(async () => button("Show translation").click()); expect(container.querySelector(".markdown")?.textContent).toContain("Результаты");
    expect(document.content).toContain("Read this");
  });
  it("cancels duplicate activation and ignores a late result", async () => {
    let finish!: (value: unknown) => void;
    fetch.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST" ? new Promise(resolve => { finish = resolve; }) : response(options));
    await render(); await open(); await selectClaude(); await act(async () => { button("Translate document").click(); button("Translate document").click(); });
    expect(postCalls()).toHaveLength(1); await act(async () => button("Cancel translation").click()); expect(postCalls()[0][1].signal.aborted).toBe(true);
    await act(async () => finish(response(result))); expect(container.querySelector(".markdown")?.textContent).toContain("Read this");
  });
  it("retains a translation on unchanged polls and clears it on changed source or workspace", async () => {
    await render(); await open(); await selectClaude(); await act(async () => button("Translate document").click());
    await render({ ...document }); expect(container.querySelector(".markdown")?.textContent).toContain("Пример");
    await render(document, "workspace"); expect(container.querySelector(".markdown")?.textContent).toContain("Example");
    await open(); await selectClaude(); await act(async () => button("Translate document").click());
    expect(JSON.parse(postCalls().at(-1)![1].body).workspaceId).toBe("workspace");
    await render(parseSourceDocument(document.path, document.content.replace("Read this", "Updated source")), "workspace");
    expect(container.querySelector(".markdown")?.textContent).toContain("Updated source"); expect(container.textContent).not.toContain("Show original");
  });
  it("aborts on source changes while a request is pending", async () => {
    fetch.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST" ? new Promise(() => {}) : response(options));
    await render(); await open(); await selectClaude(); await act(async () => button("Translate document").click());
    await render(document, "workspace"); expect(postCalls()[0][1].signal.aborted).toBe(true);
  });
  it("keeps source reading available on permission denial", async () => {
    fetch.mockResolvedValue(response({ message: "Allow Translation", reviewUrl: "https://core.example/review" }, false));
    await render(); await open(); expect(container.querySelector('[role="alert"]')?.textContent).toContain("Allow Translation");
    expect(container.querySelector('a[href="https://core.example/review"]')).not.toBeNull(); expect(container.querySelector(".markdown")?.textContent).toContain("Read this");
  });
  it("renders translated Markdown safely and rejects mismatched responses", async () => {
    fetch.mockImplementation(async (_url: string, init?: RequestInit) => response(init?.method === "POST" ? { ...result, contentHash: "wrong" } : options));
    await render(); await open(); await selectClaude(); await act(async () => button("Translate document").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("does not match");
    fetch.mockImplementation(async (_url: string, init?: RequestInit) => response(init?.method === "POST" ? { ...result, body: '# Пример\n<script>alert(1)</script>\n[unsafe](javascript:alert)\n' } : options));
    await act(async () => button("Translate document").click()); expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  });
});
